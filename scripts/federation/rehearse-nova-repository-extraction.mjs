#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_NOVA_EXTRACTION_MANIFEST = path.join(scriptDirectory, "nova-repository-extraction.v1.json");
export const NOVA_EXTRACTION_MANIFEST_REPOSITORY_PATH = "scripts/federation/nova-repository-extraction.v1.json";

const FULL_HEAD_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{40}$/;
const ZERO_OBJECT_ID = "0".repeat(40);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMMAND_BUFFER = 64 * 1024 * 1024;
export class NovaExtractionRehearsalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NovaExtractionRehearsalError";
  }
}

export async function loadNovaExtractionManifest(manifestPath = DEFAULT_NOVA_EXTRACTION_MANIFEST) {
  const absolutePath = path.resolve(manifestPath);
  const metadata = await lstat(absolutePath).catch((error) => {
    throw new NovaExtractionRehearsalError(`Extraction manifest is unavailable: ${absolutePath}`, { cause: error });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_MANIFEST_BYTES) {
    throw new NovaExtractionRehearsalError(
      "Extraction manifest must be a non-empty regular file without symbolic links and at most 1 MiB"
    );
  }

  let manifest;
  let manifestBytes;
  try {
    manifestBytes = await readFile(absolutePath);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new NovaExtractionRehearsalError(`Extraction manifest is not valid JSON: ${error.message}`, {
      cause: error
    });
  }
  return {
    manifest: validateNovaExtractionManifest(manifest),
    manifestPath: absolutePath,
    manifestBytes
  };
}

export function validateNovaExtractionManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new NovaExtractionRehearsalError("Extraction manifest must be an object");
  }
  if (manifest.schemaVersion !== 1 || manifest.cell !== "nova") {
    throw new NovaExtractionRehearsalError("Extraction manifest must declare schemaVersion 1 and cell nova");
  }
  const tagAllowlist = requireArray(manifest.tagAllowlist, "tagAllowlist");
  if (tagAllowlist.length !== 0) {
    throw new NovaExtractionRehearsalError(
      "schemaVersion 1 rehearses no tags; tagAllowlist must remain empty until tag filtering is implemented"
    );
  }

  const directPaths = uniqueRepositoryPaths(manifest.directPaths, "directPaths");
  if (directPaths.length === 0) throw new NovaExtractionRehearsalError("directPaths must not be empty");

  const historicalRenames = requireArray(manifest.historicalRenames, "historicalRenames").map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new NovaExtractionRehearsalError(`historicalRenames[${index}] must be an object`);
    }
    const from = repositoryPath(entry.from, `historicalRenames[${index}].from`, { directorySuffix: true });
    const to = repositoryPath(entry.to, `historicalRenames[${index}].to`, { directorySuffix: true });
    if (stripDirectorySuffix(from) === stripDirectorySuffix(to)) {
      throw new NovaExtractionRehearsalError(`historicalRenames[${index}] must change the path`);
    }
    if (!pathCoveredBySelection(to, directPaths)) {
      throw new NovaExtractionRehearsalError(
        `historicalRenames[${index}].to is outside the direct NOVA closure: ${to}`
      );
    }
    return { from, to };
  });
  rejectDuplicateValues(
    historicalRenames.map(({ from }) => stripDirectorySuffix(from)),
    "historical rename source"
  );
  rejectDuplicateValues(
    historicalRenames.map(({ to }) => stripDirectorySuffix(to)),
    "historical rename target"
  );

  const directHistoryPaths = uniqueRepositoryPaths(manifest.directHistoryPaths, "directHistoryPaths");
  for (const historyPath of directHistoryPaths) {
    if (!pathCoveredBySelection(historyPath, directPaths)) {
      throw new NovaExtractionRehearsalError(`directHistoryPaths entry is outside directPaths: ${historyPath}`);
    }
  }

  const ancestryOnly = requireArray(manifest.ancestryOnly, "ancestryOnly").map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new NovaExtractionRehearsalError(`ancestryOnly[${index}] must be an object`);
    }
    const sourcePath = repositoryPath(entry.path, `ancestryOnly[${index}].path`);
    const lineageTargets = uniqueRepositoryPaths(entry.lineageTargets, `ancestryOnly[${index}].lineageTargets`);
    if (lineageTargets.length === 0) {
      throw new NovaExtractionRehearsalError(`ancestryOnly[${index}].lineageTargets must not be empty`);
    }
    for (const target of lineageTargets) {
      if (!pathCoveredBySelection(target, directPaths)) {
        throw new NovaExtractionRehearsalError(`ancestryOnly[${index}] target is outside directPaths: ${target}`);
      }
    }
    if (entry.headPolicy !== "remove-during-adaptation") {
      throw new NovaExtractionRehearsalError(`ancestryOnly[${index}].headPolicy must equal remove-during-adaptation`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 12) {
      throw new NovaExtractionRehearsalError(`ancestryOnly[${index}].reason must explain the lineage decision`);
    }
    return {
      path: sourcePath,
      lineageTargets,
      headPolicy: entry.headPolicy,
      reason: entry.reason.trim()
    };
  });
  rejectDuplicateValues(
    ancestryOnly.map(({ path: sourcePath }) => sourcePath),
    "ancestry-only path"
  );

  const forbiddenHeadPathPrefixes = uniqueRepositoryPaths(
    manifest.forbiddenHeadPathPrefixes,
    "forbiddenHeadPathPrefixes",
    { directorySuffix: true }
  );
  if (forbiddenHeadPathPrefixes.length === 0) {
    throw new NovaExtractionRehearsalError("forbiddenHeadPathPrefixes must not be empty");
  }

  const requiredExternalArtifacts = requireArray(manifest.requiredExternalArtifacts, "requiredExternalArtifacts").map(
    (value, index) => {
      if (typeof value !== "string" || !/^@hyperion\/[a-z0-9-]+@\d+\.\d+\.\d+$/.test(value)) {
        throw new NovaExtractionRehearsalError(`requiredExternalArtifacts[${index}] must use exact SemVer`);
      }
      return value;
    }
  );
  rejectDuplicateValues(requiredExternalArtifacts, "required external artifact");

  const adaptationRequired = requireArray(manifest.adaptationRequired, "adaptationRequired").map((value, index) => {
    if (typeof value !== "string" || value.trim().length < 12) {
      throw new NovaExtractionRehearsalError(`adaptationRequired[${index}] must be a meaningful instruction`);
    }
    return value.trim();
  });
  if (adaptationRequired.length === 0) {
    throw new NovaExtractionRehearsalError("adaptationRequired must not be empty");
  }

  return Object.freeze({
    schemaVersion: 1,
    cell: "nova",
    description: String(manifest.description ?? "").trim(),
    tagAllowlist: Object.freeze([]),
    directPaths: Object.freeze(directPaths),
    historicalRenames: Object.freeze(historicalRenames),
    directHistoryPaths: Object.freeze(directHistoryPaths),
    ancestryOnly: Object.freeze(ancestryOnly),
    requiredExternalArtifacts: Object.freeze(requiredExternalArtifacts),
    forbiddenHeadPathPrefixes: Object.freeze(forbiddenHeadPathPrefixes),
    adaptationRequired: Object.freeze(adaptationRequired)
  });
}

export async function rehearseNovaRepositoryExtraction(options) {
  const normalized = await normalizeRehearsalOptions(options);
  const toolVersions = inspectToolVersions(normalized.execute);

  const source = inspectSourceRepository(normalized, normalized.execute);
  await assertManifestBoundToCandidate(normalized.manifestPath, normalized.manifestBytes, source, normalized.execute);
  await validateManifestAgainstSource(normalized.manifest, source, normalized.execute);

  const outputParent = await resolveOutputParent(normalized.outputParent, source.root);
  const rehearsalRoot = await mkdtemp(path.join(outputParent, "hyperion-nova-extraction-"));
  const bareRepository = path.join(rehearsalRoot, "nova-history.git");
  const pathsFile = path.join(rehearsalRoot, "nova-filter-paths.txt");
  const reportPath = path.join(rehearsalRoot, "rehearsal-report.json");

  runCommand(
    "git",
    [
      "clone",
      "--bare",
      "--no-local",
      "--no-tags",
      "--single-branch",
      "--branch",
      source.branch,
      "--",
      source.root,
      bareRepository
    ],
    { execute: normalized.execute, label: "create isolated bare clone" }
  );
  runGit(bareRepository, ["remote", "remove", "origin"], normalized.execute, "remove temporary clone origin");
  assertNoGitRemotes(bareRepository, normalized.execute);
  assertExactRef(bareRepository, source.ref, source.sha, normalized.execute, "temporary bare clone");
  assertOnlyExpectedRef(bareRepository, source.ref, normalized.execute);

  await writeFile(pathsFile, renderFilterRepoPaths(normalized.manifest), { encoding: "utf8", flag: "wx" });
  runGit(
    bareRepository,
    ["filter-repo", "--force", "--paths-from-file", pathsFile],
    normalized.execute,
    "filter NOVA history"
  );

  assertNoGitRemotes(bareRepository, normalized.execute);
  runGit(bareRepository, ["fsck", "--full", "--strict"], normalized.execute, "verify filtered repository");
  assertOnlyExpectedRef(bareRepository, source.ref, normalized.execute);

  const commitMapPath = path.join(bareRepository, "filter-repo", "commit-map");
  const refMapPath = path.join(bareRepository, "filter-repo", "ref-map");
  const commitMap = await readCommitMap(commitMapPath);
  const refMap = await readRefMap(refMapPath);
  const filteredSha = requireMappedObject(commitMap, source.sha, "candidate source commit");
  assertExactRef(bareRepository, source.ref, filteredSha, normalized.execute, "filtered repository");
  assertRefMap(refMap, source.ref, source.sha, filteredSha);

  const headPaths = gitLines(
    bareRepository,
    ["ls-tree", "-r", "--name-only", source.ref],
    normalized.execute,
    "list filtered HEAD"
  );
  assertDirectHeadPaths(normalized.manifest.directPaths, headPaths);
  assertNoForbiddenHeadPaths(normalized.manifest.forbiddenHeadPathPrefixes, headPaths);
  assertHeadWithinManifest(normalized.manifest, headPaths);

  const lineage = [];
  for (const historyPath of normalized.manifest.directHistoryPaths) {
    lineage.push(
      validatePreservedLineage({
        kind: "direct",
        sourceRepository: source.root,
        sourceRef: source.sha,
        sourcePath: historyPath,
        filteredRepository: bareRepository,
        filteredRef: source.ref,
        filteredPath: historyPath,
        commitMap,
        execute: normalized.execute
      })
    );
  }
  for (const rename of normalized.manifest.historicalRenames) {
    const result = validatePreservedLineage({
      kind: "rename",
      sourceRepository: source.root,
      sourceRef: source.sha,
      sourcePath: rename.from,
      filteredRepository: bareRepository,
      filteredRef: source.ref,
      filteredPath: rename.to,
      sourceTargetPath: rename.to,
      commitMap,
      execute: normalized.execute
    });
    if (gitObjectExists(bareRepository, `${source.ref}:${stripDirectorySuffix(rename.from)}`, normalized.execute)) {
      throw new NovaExtractionRehearsalError(`Historical source path survived filtered HEAD: ${rename.from}`);
    }
    lineage.push(result);
  }
  for (const ancestry of normalized.manifest.ancestryOnly) {
    if (!gitObjectExists(bareRepository, `${source.ref}:${ancestry.path}`, normalized.execute)) {
      throw new NovaExtractionRehearsalError(`Ancestry-only path is absent from filtered HEAD: ${ancestry.path}`);
    }
    const result = validatePreservedLineage({
      kind: "ancestry-only",
      sourceRepository: source.root,
      sourceRef: source.sha,
      sourcePath: ancestry.path,
      filteredRepository: bareRepository,
      filteredRef: source.ref,
      filteredPath: ancestry.path,
      commitMap,
      execute: normalized.execute
    });
    for (const target of ancestry.lineageTargets) {
      if (!gitObjectExists(bareRepository, `${source.ref}:${stripDirectorySuffix(target)}`, normalized.execute)) {
        throw new NovaExtractionRehearsalError(`Ancestry-only target is absent from filtered HEAD: ${target}`);
      }
    }
    lineage.push({ ...result, lineageTargets: ancestry.lineageTargets, headPolicy: ancestry.headPolicy });
    for (const target of ancestry.lineageTargets) {
      lineage.push({
        ...validatePreservedLineage({
          kind: "ancestry-target",
          sourceRepository: source.root,
          sourceRef: source.sha,
          sourcePath: target,
          filteredRepository: bareRepository,
          filteredRef: source.ref,
          filteredPath: target,
          commitMap,
          execute: normalized.execute
        }),
        ancestrySourcePath: ancestry.path
      });
    }
  }

  const pathsBytes = await readFile(pathsFile);
  const commitMapBytes = await readFile(commitMapPath);
  const refMapBytes = await readFile(refMapPath);
  const report = {
    schemaVersion: 1,
    kind: "nova-repository-extraction-rehearsal",
    status: "filtered-history-only",
    tooling: toolVersions,
    source: { ref: source.ref, sha: source.sha },
    filtered: {
      ref: source.ref,
      sha: filteredSha,
      headPathCount: headPaths.length,
      remotes: [],
      tags: []
    },
    manifest: {
      path: NOVA_EXTRACTION_MANIFEST_REPOSITORY_PATH,
      sha256: sha256(normalized.manifestBytes),
      matchesCandidateCommit: true
    },
    lineage,
    ancestryOnlyPresentAtHead: normalized.manifest.ancestryOnly.map(({ path: sourcePath }) => sourcePath),
    adaptationRequired: normalized.manifest.adaptationRequired,
    externalArtifactsRequired: normalized.manifest.requiredExternalArtifacts,
    publication: { branch: source.ref, tagAllowlist: [] },
    evidence: {
      pathsFile: { path: "nova-filter-paths.txt", sha256: sha256(pathsBytes) },
      commitMap: { path: "nova-history.git/filter-repo/commit-map", sha256: sha256(commitMapBytes) },
      refMap: { path: "nova-history.git/filter-repo/ref-map", sha256: sha256(refMapBytes) }
    },
    artifacts: {
      bareRepository: "nova-history.git",
      pathsFile: "nova-filter-paths.txt",
      commitMap: "nova-history.git/filter-repo/commit-map",
      refMap: "nova-history.git/filter-repo/ref-map"
    }
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return {
    ...report,
    reportPath,
    artifacts: { rehearsalRoot, bareRepository, pathsFile, commitMapPath, refMapPath }
  };
}

export function renderFilterRepoPaths(manifest) {
  const lines = [
    "# Generated from the versioned NOVA extraction manifest.",
    "# Direct paths",
    ...manifest.directPaths.map((entry) => `literal:${entry}`),
    "",
    "# Historical paths selected and renamed",
    ...manifest.historicalRenames.flatMap(({ from, to }) => [`literal:${from}`, `literal:${from}==>${to}`]),
    "",
    "# Ancestry-only paths; remove from HEAD in the adaptation commit",
    ...manifest.ancestryOnly.map(({ path: sourcePath }) => `literal:${sourcePath}`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function inspectSourceRepository(options, execute) {
  const isWorkTree = gitText(
    options.sourceRepository,
    ["rev-parse", "--is-inside-work-tree"],
    execute,
    "inspect source"
  );
  if (isWorkTree !== "true") {
    throw new NovaExtractionRehearsalError("--source-repository must be a non-bare Git worktree");
  }
  const topLevel = path.resolve(
    gitText(options.sourceRepository, ["rev-parse", "--show-toplevel"], execute, "resolve source root")
  );
  if (canonicalPath(topLevel) !== canonicalPath(options.sourceRepository)) {
    throw new NovaExtractionRehearsalError("--source-repository must name the exact Git worktree root");
  }
  const shallow = gitText(
    topLevel,
    ["rev-parse", "--is-shallow-repository"],
    execute,
    "inspect source history completeness"
  );
  if (shallow !== "false") {
    throw new NovaExtractionRehearsalError("Source repository is shallow; a complete local history is required");
  }
  const partialClone = gitOptionalText(
    topLevel,
    ["config", "--local", "--get", "extensions.partialClone"],
    execute,
    "inspect source partial-clone configuration"
  );
  const promisorRemotes = gitOptionalText(
    topLevel,
    ["config", "--local", "--get-regexp", "^remote\\..*\\.promisor$"],
    execute,
    "inspect source promisor configuration"
  );
  if (partialClone || promisorRemotes) {
    throw new NovaExtractionRehearsalError(
      "Source repository is partial or promisor-backed; all objects must be local before rehearsal"
    );
  }
  const dirty = gitText(
    topLevel,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    execute,
    "inspect source cleanliness"
  );
  if (dirty) throw new NovaExtractionRehearsalError("Source repository is dirty; commit or remove every change first");

  runGit(topLevel, ["check-ref-format", options.sourceRef], execute, "validate source ref");
  const sha = gitText(
    topLevel,
    ["rev-parse", "--verify", `${options.sourceRef}^{commit}`],
    execute,
    "resolve source ref"
  ).toLowerCase();
  if (sha !== options.expectedSourceSha) {
    throw new NovaExtractionRehearsalError(
      `Source ref mismatch: ${options.sourceRef} resolves to ${sha}, expected ${options.expectedSourceSha}`
    );
  }
  return { root: topLevel, ref: options.sourceRef, branch: options.sourceRef.slice("refs/heads/".length), sha };
}

async function assertManifestBoundToCandidate(manifestPath, manifestBytes, source, execute) {
  const expectedPath = path.join(source.root, ...NOVA_EXTRACTION_MANIFEST_REPOSITORY_PATH.split("/"));
  const [actualRealPath, expectedRealPath] = await Promise.all([
    realpath(manifestPath),
    realpath(expectedPath).catch((error) => {
      throw new NovaExtractionRehearsalError(`Candidate checkout lacks ${NOVA_EXTRACTION_MANIFEST_REPOSITORY_PATH}`, {
        cause: error
      });
    })
  ]);
  if (canonicalPath(actualRealPath) !== canonicalPath(expectedRealPath)) {
    throw new NovaExtractionRehearsalError(
      `--manifest must be ${NOVA_EXTRACTION_MANIFEST_REPOSITORY_PATH} inside the source checkout`
    );
  }
  const object = `${source.sha}:${NOVA_EXTRACTION_MANIFEST_REPOSITORY_PATH}`;
  const objectType = gitText(source.root, ["cat-file", "-t", object], execute, "inspect committed manifest");
  if (objectType !== "blob") {
    throw new NovaExtractionRehearsalError(`Candidate manifest is not a Git blob: ${object}`);
  }
  const committedBytes = Buffer.from(
    runGit(source.root, ["show", object], execute, "read committed extraction manifest").stdout,
    "utf8"
  );
  if (!manifestBytes.equals(committedBytes)) {
    throw new NovaExtractionRehearsalError(
      `Extraction manifest bytes do not match ${source.sha}:${NOVA_EXTRACTION_MANIFEST_REPOSITORY_PATH}`
    );
  }
}

async function validateManifestAgainstSource(manifest, source, execute) {
  for (const directPath of manifest.directPaths) {
    if (!gitObjectExists(source.root, `${source.sha}:${stripDirectorySuffix(directPath)}`, execute)) {
      throw new NovaExtractionRehearsalError(`Direct extraction path is absent from candidate HEAD: ${directPath}`);
    }
  }
  for (const rename of manifest.historicalRenames) {
    if (!gitObjectExists(source.root, `${source.sha}:${stripDirectorySuffix(rename.to)}`, execute)) {
      throw new NovaExtractionRehearsalError(`Historical rename target is absent from candidate HEAD: ${rename.to}`);
    }
    if (gitObjectExists(source.root, `${source.sha}:${stripDirectorySuffix(rename.from)}`, execute)) {
      throw new NovaExtractionRehearsalError(
        `Historical rename source still exists at candidate HEAD and would collide: ${rename.from}`
      );
    }
    requirePathHistory(source.root, source.sha, rename.from, execute, "historical rename source");
  }
  for (const historyPath of manifest.directHistoryPaths) {
    requirePathHistory(source.root, source.sha, historyPath, execute, "direct history path");
  }
  for (const ancestry of manifest.ancestryOnly) {
    if (!gitObjectExists(source.root, `${source.sha}:${ancestry.path}`, execute)) {
      throw new NovaExtractionRehearsalError(`Ancestry-only path is absent from candidate HEAD: ${ancestry.path}`);
    }
    requirePathHistory(source.root, source.sha, ancestry.path, execute, "ancestry-only path");
    for (const target of ancestry.lineageTargets) {
      if (!gitObjectExists(source.root, `${source.sha}:${stripDirectorySuffix(target)}`, execute)) {
        throw new NovaExtractionRehearsalError(`Ancestry-only target is absent from candidate HEAD: ${target}`);
      }
    }
  }
}

function validatePreservedLineage(options) {
  const sourceCommits = pathHistory(
    options.sourceRepository,
    options.sourceRef,
    options.sourcePath,
    options.execute,
    `${options.kind} source history`
  );
  if (sourceCommits.length === 0) {
    throw new NovaExtractionRehearsalError(`${options.kind} source history is empty: ${options.sourcePath}`);
  }
  const filteredCommits = pathHistory(
    options.filteredRepository,
    options.filteredRef,
    options.filteredPath,
    options.execute,
    `${options.kind} filtered history`
  );
  if (filteredCommits.length === 0) {
    throw new NovaExtractionRehearsalError(`${options.kind} history disappeared from ${options.filteredPath}`);
  }
  const sourceTargetCommits = options.sourceTargetPath
    ? requirePathHistory(
        options.sourceRepository,
        options.sourceRef,
        options.sourceTargetPath,
        options.execute,
        `${options.kind} source target history`
      )
    : [];
  const allSourceCommits = [...new Set([...sourceCommits, ...sourceTargetCommits])];
  const filteredCommitSet = new Set(filteredCommits);
  const mappedCommitSet = new Set();
  let absorbedRenameCommitCount = 0;
  for (const sourceCommit of allSourceCommits) {
    const filteredCommit = requireMappedObject(
      options.commitMap,
      sourceCommit,
      `${options.kind} commit ${sourceCommit}`
    );
    mappedCommitSet.add(filteredCommit);
    if (!filteredCommitSet.has(filteredCommit)) {
      // After git-filter-repo path renames, the monorepo rename commit often becomes a
      // no-op for this path and correctly disappears from `git log -- <path>`.
      if (!commitTouchesPath(options.filteredRepository, filteredCommit, options.filteredPath, options.execute)) {
        absorbedRenameCommitCount += 1;
      } else {
        throw new NovaExtractionRehearsalError(
          `${options.kind} mapped commit ${filteredCommit} is absent from filtered path history ${options.filteredPath}`
        );
      }
    }
    const sourceIdentity = commitIdentity(options.sourceRepository, sourceCommit, options.execute);
    const filteredIdentity = commitIdentity(options.filteredRepository, filteredCommit, options.execute);
    if (sourceIdentity !== filteredIdentity) {
      throw new NovaExtractionRehearsalError(
        `${options.kind} author/committer identity or timestamp changed for ${sourceCommit}`
      );
    }
  }
  const unexpectedFilteredCommits = filteredCommits.filter((filteredCommit) => !mappedCommitSet.has(filteredCommit));
  if (unexpectedFilteredCommits.length > 0) {
    throw new NovaExtractionRehearsalError(
      `${options.kind} filtered path history contains commits outside the mapped source set: ${unexpectedFilteredCommits.join(", ")}`
    );
  }
  return {
    kind: options.kind,
    sourcePath: options.sourcePath,
    filteredPath: options.filteredPath,
    sourceCommitCount: sourceCommits.length,
    sourceTargetCommitCount: sourceTargetCommits.length,
    mappedCommitCount: allSourceCommits.length,
    filteredCommitCount: filteredCommits.length,
    absorbedRenameCommitCount,
    mappedCommitsPresentInFilteredPathHistory: true,
    filteredPathHistoryMatchesMappedSourceSet: true,
    identitiesAndTimestampsPreserved: true
  };
}

async function normalizeRehearsalOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new NovaExtractionRehearsalError("Rehearsal options are required");
  }
  if (typeof options.sourceRepository !== "string" || !options.sourceRepository.trim()) {
    throw new NovaExtractionRehearsalError("--source-repository is required");
  }
  const requestedSourceRepository = path.resolve(options.sourceRepository);
  const sourceMetadata = await lstat(requestedSourceRepository).catch((error) => {
    throw new NovaExtractionRehearsalError("--source-repository does not resolve to an existing path", {
      cause: error
    });
  });
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new NovaExtractionRehearsalError("--source-repository must be a real directory without symbolic links");
  }
  const sourceRepository = await realpath(requestedSourceRepository);
  if (canonicalPath(sourceRepository) !== canonicalPath(requestedSourceRepository)) {
    throw new NovaExtractionRehearsalError("--source-repository must not traverse a symbolic link or junction");
  }
  if (typeof options.sourceRef !== "string" || !FULL_HEAD_REF_PATTERN.test(options.sourceRef)) {
    throw new NovaExtractionRehearsalError("--source-ref must be an explicit refs/heads/<branch> ref");
  }
  if (
    typeof options.expectedSourceSha !== "string" ||
    !OBJECT_ID_PATTERN.test(options.expectedSourceSha.toLowerCase()) ||
    options.expectedSourceSha.toLowerCase() === ZERO_OBJECT_ID
  ) {
    throw new NovaExtractionRehearsalError("--expected-source-sha must be an exact non-zero 40-character commit ID");
  }
  const { manifest, manifestPath, manifestBytes } = await loadNovaExtractionManifest(
    options.manifestPath ?? DEFAULT_NOVA_EXTRACTION_MANIFEST
  );
  return {
    sourceRepository,
    sourceRef: options.sourceRef,
    expectedSourceSha: options.expectedSourceSha.toLowerCase(),
    outputParent: options.outputParent,
    manifest,
    manifestPath,
    manifestBytes,
    execute: options.execute ?? executeCommand
  };
}

async function resolveOutputParent(outputParent, sourceRoot) {
  const requested = path.resolve(outputParent ?? os.tmpdir());
  const requestedMetadata = await lstat(requested).catch((error) => {
    throw new NovaExtractionRehearsalError("--output-parent must be an existing directory", { cause: error });
  });
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new NovaExtractionRehearsalError("--output-parent must be a real directory without symbolic links");
  }
  const candidate = await realpath(requested);
  if (canonicalPath(candidate) !== canonicalPath(requested)) {
    throw new NovaExtractionRehearsalError("--output-parent must not traverse a symbolic link or junction");
  }
  if (pathsOverlap(candidate, sourceRoot)) {
    throw new NovaExtractionRehearsalError("--output-parent and --source-repository must not contain one another");
  }
  return candidate;
}

async function readCommitMap(filePath) {
  const rows = await readMapFile(filePath, "commit-map", 2);
  const result = new Map();
  for (const [oldObject, newObject] of rows) {
    if (!OBJECT_ID_PATTERN.test(oldObject) || !OBJECT_ID_PATTERN.test(newObject)) {
      throw new NovaExtractionRehearsalError("commit-map contains an invalid object ID");
    }
    result.set(oldObject, newObject);
  }
  if (result.size === 0) throw new NovaExtractionRehearsalError("commit-map contains no rewritten commits");
  return result;
}

async function readRefMap(filePath) {
  return readMapFile(filePath, "ref-map", 3);
}

async function readMapFile(filePath, label, columns) {
  const metadata = await lstat(filePath).catch((error) => {
    throw new NovaExtractionRehearsalError(`${label} is missing after git-filter-repo`, { cause: error });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new NovaExtractionRehearsalError(`${label} must be a non-empty regular file without symbolic links`);
  }
  const lines = (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts.length !== columns) throw new NovaExtractionRehearsalError(`${label} contains a malformed row`);
    rows.push(parts);
  }
  return rows;
}

function assertRefMap(rows, ref, sourceSha, filteredSha) {
  const match = rows.find((row) => row[2] === ref);
  if (!match || match[0] !== sourceSha || match[1] !== filteredSha) {
    throw new NovaExtractionRehearsalError(`ref-map does not bind ${ref} from ${sourceSha} to ${filteredSha}`);
  }
}

function requireMappedObject(commitMap, sourceObject, label) {
  const mapped = commitMap.get(sourceObject);
  if (!mapped || mapped === ZERO_OBJECT_ID) {
    throw new NovaExtractionRehearsalError(`${label} was discarded instead of preserved by git-filter-repo`);
  }
  return mapped;
}

function assertDirectHeadPaths(directPaths, headPaths) {
  for (const selectedPath of directPaths) {
    const expected = stripDirectorySuffix(selectedPath);
    if (!headPaths.some((entry) => entry === expected || entry.startsWith(`${expected}/`))) {
      throw new NovaExtractionRehearsalError(`Filtered HEAD is missing a direct extraction path: ${selectedPath}`);
    }
  }
}

function assertNoForbiddenHeadPaths(prefixes, headPaths) {
  const normalizedPrefixes = prefixes.map((entry) => stripDirectorySuffix(entry).toLowerCase());
  const forbidden = headPaths.filter((entry) => {
    const normalized = entry.toLowerCase();
    return normalizedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
  });
  if (forbidden.length > 0) {
    throw new NovaExtractionRehearsalError(`Filtered HEAD contains sibling product paths: ${forbidden.join(", ")}`);
  }
}

export function assertHeadWithinManifest(manifest, headPaths) {
  const allowed = [...manifest.directPaths, ...manifest.ancestryOnly.map(({ path: sourcePath }) => sourcePath)];
  const unexpected = headPaths.filter((entry) => !pathCoveredBySelection(entry, allowed));
  if (unexpected.length > 0) {
    throw new NovaExtractionRehearsalError(
      `Filtered HEAD contains paths outside the manifest allowlist: ${unexpected.join(", ")}`
    );
  }
}

function inspectToolVersions(execute) {
  const gitVersion = runCommand("git", ["--version"], {
    execute,
    label: "read Git version"
  }).stdout.trim();
  const gitFilterRepoVersion = runCommand("git", ["filter-repo", "--version"], {
    execute,
    label: "locate git-filter-repo"
  }).stdout.trim();
  if (!gitVersion || !gitFilterRepoVersion) {
    throw new NovaExtractionRehearsalError("Git and git-filter-repo must return non-empty version identifiers");
  }
  return { git: gitVersion, gitFilterRepo: gitFilterRepoVersion };
}

function assertNoGitRemotes(repository, execute) {
  const remotes = gitLines(repository, ["remote"], execute, "inspect temporary remotes");
  if (remotes.length > 0) {
    throw new NovaExtractionRehearsalError(`Temporary repository unexpectedly has remotes: ${remotes.join(", ")}`);
  }
}

function assertExactRef(repository, ref, expectedSha, execute, label) {
  const actual = gitText(repository, ["rev-parse", "--verify", `${ref}^{commit}`], execute, `resolve ${label} ref`);
  if (actual !== expectedSha) {
    throw new NovaExtractionRehearsalError(`${label} ${ref} resolves to ${actual}, expected ${expectedSha}`);
  }
}

function assertOnlyExpectedRef(repository, expectedRef, execute) {
  const refs = gitLines(repository, ["for-each-ref", "--format=%(refname)"], execute, "list temporary refs");
  if (refs.length !== 1 || refs[0] !== expectedRef) {
    throw new NovaExtractionRehearsalError(
      `Temporary repository must contain only ${expectedRef}; found ${refs.join(", ") || "none"}`
    );
  }
}

function requirePathHistory(repository, ref, repositoryPathValue, execute, label) {
  const commits = pathHistory(repository, ref, repositoryPathValue, execute, label);
  if (commits.length === 0) throw new NovaExtractionRehearsalError(`${label} has no history: ${repositoryPathValue}`);
  return commits;
}

function pathHistory(repository, ref, repositoryPathValue, execute, label) {
  return gitLines(
    repository,
    ["log", "--format=%H", ref, "--", stripDirectorySuffix(repositoryPathValue)],
    execute,
    label
  );
}

function commitTouchesPath(repository, commit, repositoryPathValue, execute) {
  return (
    gitLines(
      repository,
      [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        commit,
        "--",
        stripDirectorySuffix(repositoryPathValue)
      ],
      execute,
      "commit path touch check"
    ).length > 0
  );
}

function commitIdentity(repository, commit, execute) {
  return gitText(
    repository,
    ["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", commit],
    execute,
    "read commit identity"
  );
}

function gitObjectExists(repository, object, execute) {
  const result = execute("git", ["-C", repository, "cat-file", "-e", object], {
    encoding: "utf8",
    shell: false,
    maxBuffer: MAX_COMMAND_BUFFER,
    env: safeGitEnvironment()
  });
  if (result.error) {
    throw new NovaExtractionRehearsalError(`git cat-file could not execute: ${result.error.message}`, {
      cause: result.error
    });
  }
  return result.status === 0;
}

function gitText(repository, arguments_, execute, label) {
  return runGit(repository, arguments_, execute, label).stdout.trim();
}

function gitLines(repository, arguments_, execute, label) {
  const output = gitText(repository, arguments_, execute, label);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function gitOptionalText(repository, arguments_, execute, label) {
  const result = execute("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    shell: false,
    maxBuffer: MAX_COMMAND_BUFFER,
    env: safeGitEnvironment()
  });
  if (result.error) {
    throw new NovaExtractionRehearsalError(`${label} could not execute: ${result.error.message}`, {
      cause: result.error
    });
  }
  if (result.status === 1) return "";
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new NovaExtractionRehearsalError(`${label} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function runGit(repository, arguments_, execute, label) {
  return runCommand("git", ["-C", repository, ...arguments_], { execute, label });
}

function runCommand(command, arguments_, options) {
  const result = options.execute(command, arguments_, {
    encoding: "utf8",
    shell: false,
    maxBuffer: MAX_COMMAND_BUFFER,
    env: safeGitEnvironment()
  });
  if (result.error) {
    throw new NovaExtractionRehearsalError(`${options.label} could not execute: ${result.error.message}`, {
      cause: result.error
    });
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new NovaExtractionRehearsalError(`${options.label} failed: ${detail}`);
  }
  return result;
}

function executeCommand(command, arguments_, options) {
  return spawnSync(command, arguments_, options);
}

function safeGitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0"
  };
}

function uniqueRepositoryPaths(values, label, options = {}) {
  const paths = requireArray(values, label).map((value, index) => repositoryPath(value, `${label}[${index}]`, options));
  rejectDuplicateValues(paths.map(stripDirectorySuffix), label);
  return paths;
}

function repositoryPath(value, label, options = {}) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new NovaExtractionRehearsalError(`${label} must be a trimmed non-empty repository path`);
  }
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("==>") ||
    /[\r\n]/.test(value) ||
    path.posix.isAbsolute(value)
  ) {
    throw new NovaExtractionRehearsalError(`${label} must use a safe repository-relative POSIX path`);
  }
  const directorySuffix = options.directorySuffix === true && value.endsWith("/");
  const normalized = stripDirectorySuffix(value);
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new NovaExtractionRehearsalError(`${label} contains an unsafe path segment`);
  }
  return directorySuffix ? `${normalized}/` : normalized;
}

function pathCoveredBySelection(value, directPaths) {
  const candidate = stripDirectorySuffix(value);
  return directPaths.some((selected) => {
    const root = stripDirectorySuffix(selected);
    return candidate === root || candidate.startsWith(`${root}/`);
  });
}

function stripDirectorySuffix(value) {
  return value.replace(/\/$/, "");
}

function rejectDuplicateValues(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new NovaExtractionRehearsalError(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new NovaExtractionRehearsalError(`${label} must be an array`);
  return value;
}

function pathsOverlap(left, right) {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const key = {
      "--source-repository": "sourceRepository",
      "--source-ref": "sourceRef",
      "--expected-source-sha": "expectedSourceSha",
      "--manifest": "manifestPath",
      "--output-parent": "outputParent"
    }[argument];
    if (!key) throw new NovaExtractionRehearsalError(`Unknown argument: ${argument}`);
    if (options[key] !== undefined) throw new NovaExtractionRehearsalError(`Duplicate argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new NovaExtractionRehearsalError(`${argument} requires a value`);
    }
    options[key] = value;
  }
  return options;
}

function usage() {
  return `Usage:
  node scripts/federation/rehearse-nova-repository-extraction.mjs \\
    --source-repository <clean-local-worktree> \\
    --source-ref refs/heads/<candidate-branch> \\
    --expected-source-sha <exact-40-character-sha> \\
    [--manifest <manifest.json>] \\
    [--output-parent <existing-directory-outside-source>]

The command never reads or writes a configured Git remote. It creates and retains
an isolated bare repository below the output parent for inspection. It does not
perform the adaptation commit, install dependencies, publish artifacts or push refs.
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await rehearseNovaRepositoryExtraction(options);
  process.stdout.write(`NOVA_EXTRACTION_REHEARSAL_STATUS=${result.status}\n`);
  process.stdout.write(`NOVA_EXTRACTION_SOURCE_SHA=${result.source.sha}\n`);
  process.stdout.write(`NOVA_EXTRACTION_FILTERED_SHA=${result.filtered.sha}\n`);
  process.stdout.write(`NOVA_EXTRACTION_REPORT=${result.reportPath}\n`);
  process.stdout.write("NOVA_EXTRACTION_REMOTE_ACTIONS=none\n");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
