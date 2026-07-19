#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "../..");
const defaultCatalogPath = path.join(defaultRepositoryRoot, "releases", "registry", "provider-artifacts.v1.json");
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_NAME = /^@hyperion\/[a-z0-9-]+$/;
const SOURCE_REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[a-z0-9-]+\.yml$/;
const DISALLOWED_LOCAL_PROTOCOL = /^(?:workspace|file|link):/i;
const DEPENDENCY_GROUPS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"];
const DISALLOWED_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepare",
  "prepack",
  "postpack",
  "prepublishOnly",
  "publish",
  "postpublish"
];
const ALLOWED_PUBLISH_CONFIG_KEYS = new Set(["access", "tag"]);
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;
const PACK_STAGING_PREFIX = "hyperion-npm-pack-staging-";
const READBACK_TEMP_PREFIX = "hyperion-published-npm-artifact-";
const OWNED_TEMP_PREFIXES = new Set([PACK_STAGING_PREFIX, READBACK_TEMP_PREFIX]);
const GENERATED_TEST_ARTIFACT = /\.test\.(?:js(?:\.map)?|d\.ts(?:\.map)?)$/i;
export const MAX_PUBLISHED_NPM_TARBALL_BYTES = 64 * 1024 * 1024;

export function validatePublishableNpmManifest(manifest, options) {
  const errors = [];
  const artifactVersions = options.artifactVersions ?? new Map();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["packed manifest must be an object"];
  }
  if (manifest.name !== options.packageName) {
    errors.push(`packed manifest name must equal ${options.packageName}`);
  }
  if (manifest.version !== options.version) {
    errors.push(`packed manifest version must equal ${options.version}`);
  }
  if (options.requiredGitHead && manifest.gitHead !== options.requiredGitHead) {
    errors.push(`packed manifest gitHead must equal ${options.requiredGitHead}`);
  }
  if (manifest.private === true) errors.push("packed manifest must not be private");
  const scripts = manifest.scripts;
  if (scripts !== undefined && (!scripts || typeof scripts !== "object" || Array.isArray(scripts))) {
    errors.push("packed manifest scripts must be an object");
  } else {
    for (const lifecycle of DISALLOWED_LIFECYCLE_SCRIPTS) {
      if (Object.hasOwn(scripts ?? {}, lifecycle)) {
        errors.push(`packed manifest must not expose a ${lifecycle} lifecycle script`);
      }
    }
  }
  const publishConfig = manifest.publishConfig;
  if (publishConfig !== undefined) {
    if (!publishConfig || typeof publishConfig !== "object" || Array.isArray(publishConfig)) {
      errors.push("packed manifest publishConfig must be an object");
    } else {
      for (const key of Object.keys(publishConfig)) {
        if (key === "registry") errors.push("packed manifest must not override the workflow-controlled registry");
        else if (!ALLOWED_PUBLISH_CONFIG_KEYS.has(key)) {
          errors.push(`packed manifest publishConfig.${key} is not allowed`);
        }
      }
      if (publishConfig.access !== undefined && publishConfig.access !== "public") {
        errors.push("packed manifest publishConfig.access must equal public");
      }
      if (
        publishConfig.tag !== undefined &&
        (typeof publishConfig.tag !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(publishConfig.tag))
      ) {
        errors.push("packed manifest publishConfig.tag must be a safe lowercase npm tag");
      }
    }
  }
  for (const group of DEPENDENCY_GROUPS) {
    const dependencies = manifest[group] ?? {};
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      errors.push(`packed manifest ${group} must be an object`);
      continue;
    }
    for (const [name, rawSpecifier] of Object.entries(dependencies)) {
      const specifier = String(rawSpecifier).trim();
      if (DISALLOWED_LOCAL_PROTOCOL.test(specifier)) {
        errors.push(`packed manifest ${group}.${name} must not use ${specifier.split(":", 1)[0]} protocol`);
      }
      if (targetsHyperionNpmAlias(specifier)) {
        errors.push(
          `packed manifest ${group}.${name} must not alias a Hyperion package; use its canonical name and exact catalog SemVer`
        );
      }
      if (!name.startsWith("@hyperion/")) continue;
      if (!EXACT_SEMVER.test(specifier)) {
        errors.push(`packed manifest ${group}.${name} must use exact SemVer; received ${specifier}`);
        continue;
      }
      const expected = artifactVersions.get(name);
      if (!expected) {
        errors.push(`packed manifest ${group}.${name} is absent from the provider artifact catalog`);
      } else if (specifier !== expected) {
        errors.push(`packed manifest ${group}.${name} must equal catalog version ${expected}; received ${specifier}`);
      }
    }
  }
  return errors;
}

export function validatePackedFileInventory(files) {
  const errors = [];
  if (!Array.isArray(files) || files.length < 2)
    return ["pnpm pack inventory must contain package.json and dist files"];
  let manifestSeen = false;
  let distributionSeen = false;
  for (const entry of files) {
    const filePath = typeof entry === "string" ? entry : entry?.path;
    if (
      typeof filePath !== "string" ||
      !filePath ||
      path.posix.isAbsolute(filePath) ||
      filePath.split("/").includes("..")
    ) {
      errors.push(`pnpm pack inventory contains an unsafe path: ${String(filePath)}`);
      continue;
    }
    if (filePath === "package.json") manifestSeen = true;
    else if (filePath.startsWith("dist/")) distributionSeen = true;
    else errors.push(`pnpm pack inventory contains a non-publishable path: ${filePath}`);
    if (/(?:^|\/)(?:\.npmrc|\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx)|[^/]+\.test\.[^/]+)$/i.test(filePath)) {
      errors.push(`pnpm pack inventory contains a sensitive or test path: ${filePath}`);
    }
  }
  if (!manifestSeen) errors.push("pnpm pack inventory is missing package.json");
  if (!distributionSeen) errors.push("pnpm pack inventory is missing dist output");
  return errors;
}

export async function packPublishableNpmArtifact(options, root = defaultRepositoryRoot, execute = executeCommand) {
  requireString(options.packageDirectory, "--package-directory");
  requireString(options.packageName, "--package-name");
  requireString(options.version, "--version");
  requireString(options.sourceRevision, "--source-revision");
  requireString(options.outputDirectory, "--output-directory");
  if (!PACKAGE_NAME.test(options.packageName)) throw new Error("--package-name must be a @hyperion scoped package");
  if (!EXACT_SEMVER.test(options.version)) throw new Error("--version must be exact SemVer");
  if (!SOURCE_REVISION.test(options.sourceRevision)) {
    throw new Error("--source-revision must be a non-zero lowercase 40-character Git SHA");
  }

  const catalog = options.catalog ?? (await readJson(path.resolve(options.catalogPath ?? defaultCatalogPath)));
  const artifact = requireCatalogArtifact(catalog, options.packageName, options.version);
  const packageDirectory = resolveInside(root, options.packageDirectory);
  if (normalizeRelative(artifact.sourcePath) !== normalizeRelative(path.relative(root, packageDirectory))) {
    throw new Error(`${options.packageName} package directory differs from the provider artifact catalog`);
  }
  const sourceManifest = await readJson(path.join(packageDirectory, "package.json"));
  const artifactVersions = catalogArtifactVersions(catalog);
  assertNoErrors(
    validatePublishableNpmManifest(sourceManifest, {
      packageName: options.packageName,
      version: options.version,
      artifactVersions
    }),
    "Source package manifest is not publishable"
  );

  const outputDirectory = path.resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const existingTarballs = (await readdir(outputDirectory)).filter((entry) => entry.endsWith(".tgz"));
  if (existingTarballs.length > 0) throw new Error("--output-directory must not contain an existing tarball");
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), PACK_STAGING_PREFIX));
  let packedEntries;
  try {
    await copyReviewedDistribution(path.join(packageDirectory, "dist"), path.join(stagingRoot, "dist"));
    const stagedManifest = { ...sourceManifest, gitHead: options.sourceRevision };
    assertNoErrors(
      validatePublishableNpmManifest(stagedManifest, {
        packageName: options.packageName,
        version: options.version,
        artifactVersions,
        requiredGitHead: options.sourceRevision
      }),
      "Staged package manifest is not publishable"
    );
    await writeFile(path.join(stagingRoot, "package.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    const packedResult = execute("pnpm", [
      "--dir",
      stagingRoot,
      "pack",
      "--json",
      "--pack-destination",
      outputDirectory
    ]);
    assertCommand(packedResult, `pack ${options.packageName}@${options.version}`);
    const packedOutput = parseJson(Buffer.from(packedResult.stdout), "pnpm pack output");
    packedEntries = Array.isArray(packedOutput) ? packedOutput : [packedOutput];
    if (packedEntries.length !== 1 || typeof packedEntries[0]?.filename !== "string") {
      throw new Error("pnpm pack must return exactly one tarball");
    }
    assertNoErrors(validatePackedFileInventory(packedEntries[0].files), "Packed file inventory is not publishable");
  } finally {
    await removeOwnedTemporaryDirectory(stagingRoot, PACK_STAGING_PREFIX);
  }
  const tarballs = (await readdir(outputDirectory)).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1)
    throw new Error(`pack output must contain exactly one tarball; received ${tarballs.length}`);
  const tarballPath = path.join(outputDirectory, tarballs[0]);
  const reportedPath = path.resolve(stagingRoot, packedEntries[0].filename);
  if (path.resolve(tarballPath) !== reportedPath && path.basename(packedEntries[0].filename) !== tarballs[0]) {
    throw new Error("pnpm pack reported a tarball outside the reviewed output directory");
  }
  const tarballBytes = await readRegularFile(
    tarballPath,
    `${options.packageName} local tarball`,
    MAX_PUBLISHED_NPM_TARBALL_BYTES
  );
  const manifestResult = execute("tar", ["-xOf", tarballPath, "package/package.json"]);
  assertCommand(manifestResult, `inspect packed manifest for ${options.packageName}`);
  const packedManifest = parseJson(Buffer.from(manifestResult.stdout), `${options.packageName} packed manifest`);
  assertNoErrors(
    validatePublishableNpmManifest(packedManifest, {
      packageName: options.packageName,
      version: options.version,
      artifactVersions,
      requiredGitHead: options.sourceRevision
    }),
    "Packed package manifest is not publishable"
  );
  const result = {
    tarballPath,
    tarballSha256: sha256(tarballBytes),
    tarballIntegrity: sha512Integrity(tarballBytes),
    tarballBytes: tarballBytes.length,
    packedFiles: packedEntries[0].files.map((entry) => (typeof entry === "string" ? entry : entry.path)),
    packedManifest
  };
  if (options.githubOutput) {
    await appendFile(
      path.resolve(options.githubOutput),
      `tarball=${result.tarballPath}\nsha256=${result.tarballSha256}\nintegrity=${result.tarballIntegrity}\n`,
      "utf8"
    );
  }
  return result;
}

async function copyReviewedDistribution(sourceRoot, destinationRoot) {
  const rootMetadata = await lstat(sourceRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("publishable dist must be a real directory without symbolic links");
  }
  let fileCount = 0;
  let totalBytes = 0;
  const copyDirectory = async (sourceDirectory, destinationDirectory, relativeDirectory) => {
    await mkdir(destinationDirectory, { recursive: false, mode: 0o700 });
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      const relativePath = path.posix.join("dist", relativeDirectory, entry.name);
      const metadata = await lstat(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`publishable dist must not contain symbolic links: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath, path.posix.join(relativeDirectory, entry.name));
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`publishable dist must contain only regular files and directories: ${relativePath}`);
      }
      if (GENERATED_TEST_ARTIFACT.test(relativePath)) continue;
      assertNoErrors(
        validatePackedFileInventory([{ path: "package.json" }, { path: relativePath }]),
        "Publishable dist file is not allowed"
      );
      totalBytes += metadata.size;
      if (metadata.size === 0) throw new Error(`publishable dist contains an empty file: ${relativePath}`);
      if (totalBytes > MAX_PUBLISHED_NPM_TARBALL_BYTES) {
        throw new Error("publishable dist exceeds the 64 MiB safety limit");
      }
      await copyFile(sourcePath, destinationPath);
      fileCount += 1;
    }
  };
  await copyDirectory(sourceRoot, destinationRoot, "");
  if (fileCount === 0) throw new Error("publishable dist must contain at least one regular file");
}

export function preflightExactNpmArtifact(options, execute = executeCommand) {
  validatePublishedArtifactOptions(options, { requireSource: false, requireWorkflow: false });
  const registryOrigin = normalizeRegistryOrigin(options.registryOrigin);
  const packageReference = `${options.packageName}@${options.version}`;
  const authentication = execute("npm", ["whoami", "--registry", registryOrigin]);
  assertCommand(authentication, "authenticated registry preflight");
  if (!String(authentication.stdout ?? "").trim()) {
    throw new Error("authenticated registry preflight returned an empty identity");
  }
  const result = execute("npm", ["view", packageReference, "version", "--json", "--registry", registryOrigin]);
  if (result.error)
    throw new Error(`registry preflight could not execute: ${result.error.message}`, { cause: result.error });
  if (result.status === 0) {
    const version = parseJson(Buffer.from(result.stdout), "registry preflight response");
    if (version !== options.version) throw new Error(`registry returned ${String(version)} for ${packageReference}`);
    return { alreadyPublished: true };
  }
  const diagnostic = String(result.stderr || result.stdout || "");
  if (
    /(?:E401|401 Unauthorized|E403|403 Forbidden|E5\d\d|5\d\d (?:Server|Internal)|ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)/i.test(
      diagnostic
    )
  ) {
    throw new Error(`registry preflight failed without proving exact package absence: ${diagnostic.trim()}`);
  }
  if (!/(?:E404|404 Not Found|is not in this registry)/i.test(diagnostic)) {
    throw new Error(`registry preflight failed without proving exact package absence: ${diagnostic.trim()}`);
  }
  return { alreadyPublished: false };
}

export async function verifyPublishedNpmArtifact(options, execute = executeCommand) {
  validatePublishedArtifactOptions(options, { requireSource: true, requireWorkflow: true });
  const registryOrigin = normalizeRegistryOrigin(options.registryOrigin);
  const packageReference = `${options.packageName}@${options.version}`;
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), READBACK_TEMP_PREFIX));
  try {
    const metadataResult = execute("npm", ["view", packageReference, "--json", "--registry", registryOrigin]);
    assertCommand(metadataResult, `registry metadata for ${packageReference}`);
    const metadata = parseJson(Buffer.from(metadataResult.stdout), `${packageReference} registry metadata`);
    validateRegistryMetadata(metadata, options, registryOrigin);

    const packResult = execute("npm", [
      "pack",
      packageReference,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporaryRoot,
      "--registry",
      registryOrigin
    ]);
    assertCommand(packResult, `download immutable tarball for ${packageReference}`);
    const packOutput = parseJson(Buffer.from(packResult.stdout), `${packageReference} npm pack output`);
    if (!Array.isArray(packOutput) || packOutput.length !== 1) {
      throw new Error(`${packageReference} npm pack must return exactly one tarball`);
    }
    const packed = packOutput[0];
    if (
      !packed ||
      typeof packed.filename !== "string" ||
      path.basename(packed.filename) !== packed.filename ||
      packed.integrity !== metadata.dist.integrity
    ) {
      throw new Error(`${packageReference} npm pack output differs from registry integrity metadata`);
    }
    const remoteTarballPath = path.join(temporaryRoot, packed.filename);
    const remoteBytes = await readRegularFile(
      remoteTarballPath,
      `${packageReference} registry tarball`,
      MAX_PUBLISHED_NPM_TARBALL_BYTES
    );
    if (sha512Integrity(remoteBytes) !== metadata.dist.integrity) {
      throw new Error(`${packageReference} registry tarball bytes do not match SHA-512 integrity`);
    }
    if (options.localTarball) {
      const localBytes = await readRegularFile(
        path.resolve(options.localTarball),
        `${packageReference} local tarball`,
        MAX_PUBLISHED_NPM_TARBALL_BYTES
      );
      if (!localBytes.equals(remoteBytes)) {
        throw new Error(`${packageReference} registry readback differs byte-for-byte from the packed candidate`);
      }
    }
    const tarballSha256 = sha256(remoteBytes);
    const signerWorkflow = `${options.sourceRepository}/${options.signerWorkflow}`;
    const provenanceResult = execute("gh", [
      "attestation",
      "verify",
      remoteTarballPath,
      "--repo",
      options.sourceRepository,
      "--signer-workflow",
      signerWorkflow,
      "--signer-digest",
      options.sourceRevision,
      "--source-digest",
      options.sourceRevision,
      "--source-ref",
      "refs/heads/main",
      "--deny-self-hosted-runners",
      "--format",
      "json"
    ]);
    assertCommand(provenanceResult, `GitHub package provenance for ${packageReference}`);
    const verified = selectVerifiedStatement(
      parseJson(Buffer.from(provenanceResult.stdout), `${packageReference} GitHub package provenance`),
      tarballSha256,
      options.sourceRevision
    );
    return {
      schemaVersion: 1,
      verifier: "npm-registry-sha512+gh-attestation",
      packageName: options.packageName,
      version: options.version,
      sourceRepository: options.sourceRepository,
      sourceRevision: options.sourceRevision,
      signerWorkflow: options.signerWorkflow,
      registryOrigin,
      registryTarball: metadata.dist.tarball,
      integrity: metadata.dist.integrity,
      tarballSha256,
      builderId: verified.predicate.runDetails.builder.id,
      registryMetadataSha256: sha256(canonicalRegistryMetadata(metadata)),
      verifiedProvenanceSha256: sha256(canonicalJsonBytes(verified.statement)),
      verifiedAt: options.verifiedAt ?? new Date().toISOString()
    };
  } finally {
    await removeOwnedTemporaryDirectory(temporaryRoot, READBACK_TEMP_PREFIX);
  }
}

export async function verifyPublishedNpmArtifactWithRetry(options, execute = executeCommand, wait = defaultWait) {
  const attempts = Number(options.attempts ?? 1);
  const retryDelayMs = Number(options.retryDelayMs ?? 0);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("--attempts must be an integer between 1 and 10");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) {
    throw new Error("--retry-delay-ms must be an integer between 0 and 60000");
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyPublishedNpmArtifact(options, execute);
    } catch (error) {
      lastError = error;
      if (!retryableReadbackError(error)) throw error;
      if (attempt < attempts) await wait(retryDelayMs);
    }
  }
  throw new Error(`published npm artifact readback failed after ${attempts} attempt(s): ${lastError.message}`, {
    cause: lastError
  });
}

export async function writeRegistryEvidence(evidence, outputPath) {
  requireString(outputPath, "--output");
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  return resolved;
}

export async function removeOwnedTemporaryDirectory(target, expectedPrefix) {
  if (!OWNED_TEMP_PREFIXES.has(expectedPrefix)) {
    throw new Error(`refusing unsafe temporary cleanup with unknown prefix: ${String(expectedPrefix)}`);
  }
  requireString(target, "temporary cleanup target");
  const resolvedTarget = path.resolve(target);
  const targetMetadata = await lstat(resolvedTarget);
  if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) {
    throw new Error("refusing unsafe temporary cleanup of a non-directory or symbolic link");
  }
  const [realTemporaryRoot, realTarget] = await Promise.all([realpath(os.tmpdir()), realpath(resolvedTarget)]);
  const relativeTarget = path.relative(realTemporaryRoot, realTarget);
  const basename = path.basename(realTarget);
  const suffix = basename.startsWith(expectedPrefix) ? basename.slice(expectedPrefix.length) : "";
  if (
    !relativeTarget ||
    path.isAbsolute(relativeTarget) ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    relativeTarget.includes(path.sep) ||
    relativeTarget !== basename ||
    !/^[A-Za-z0-9]{6}$/.test(suffix)
  ) {
    throw new Error(`refusing unsafe temporary cleanup outside the exact ${expectedPrefix}<random> basename`);
  }
  await rm(realTarget, { recursive: true, force: true });
}

function requireCatalogArtifact(catalog, packageName, version) {
  const matches = (catalog.artifacts ?? []).filter((artifact) => artifact?.packageName === packageName);
  if (matches.length !== 1) throw new Error(`${packageName} must appear exactly once in the provider artifact catalog`);
  if (matches[0].currentVersion !== version) {
    throw new Error(`${packageName} version must equal catalog currentVersion ${matches[0].currentVersion}`);
  }
  return matches[0];
}

function catalogArtifactVersions(catalog) {
  return new Map(
    (catalog.artifacts ?? [])
      .filter((artifact) => typeof artifact?.packageName === "string" && typeof artifact?.currentVersion === "string")
      .map((artifact) => [artifact.packageName, artifact.currentVersion])
  );
}

function validateRegistryMetadata(metadata, options, registryOrigin) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${options.packageName} registry metadata must be an object`);
  }
  if (metadata.name !== options.packageName || metadata.version !== options.version) {
    throw new Error(`${options.packageName} registry identity differs from the requested exact version`);
  }
  if (metadata.gitHead !== options.sourceRevision) {
    throw new Error(`${options.packageName} registry gitHead differs from the protected-main source revision`);
  }
  if (!metadata.dist || typeof metadata.dist !== "object" || Array.isArray(metadata.dist)) {
    throw new Error(`${options.packageName} registry metadata has no immutable distribution`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist.integrity ?? "")) {
    throw new Error(`${options.packageName} registry metadata has no valid SHA-512 integrity`);
  }
  let tarball;
  try {
    tarball = new URL(metadata.dist.tarball);
  } catch {
    throw new Error(`${options.packageName} registry tarball URL is invalid`);
  }
  const unscoped = options.packageName.split("/").at(-1);
  const expectedPath = `/${options.packageName}/-/${unscoped}-${options.version}.tgz`;
  if (
    tarball.protocol !== "https:" ||
    tarball.username ||
    tarball.password ||
    tarball.search ||
    tarball.hash ||
    tarball.origin !== registryOrigin ||
    decodeURIComponent(tarball.pathname) !== expectedPath
  ) {
    throw new Error(`${options.packageName} registry tarball must be the exact version on the authorized HTTPS origin`);
  }
}

function validatePublishedArtifactOptions(options, requirements) {
  for (const name of ["packageName", "version", "registryOrigin"]) requireString(options[name], `--${toKebab(name)}`);
  if (!PACKAGE_NAME.test(options.packageName)) throw new Error("--package-name must be a @hyperion scoped package");
  if (!EXACT_SEMVER.test(options.version)) throw new Error("--version must be exact SemVer");
  if (requirements.requireSource) {
    requireString(options.sourceRevision, "--source-revision");
    requireString(options.sourceRepository, "--source-repository");
    if (!SOURCE_REVISION.test(options.sourceRevision)) {
      throw new Error("--source-revision must be a non-zero lowercase 40-character Git SHA");
    }
    if (!SOURCE_REPOSITORY.test(options.sourceRepository)) {
      throw new Error("--source-repository must use owner/repository syntax");
    }
  }
  if (requirements.requireWorkflow) {
    requireString(options.signerWorkflow, "--signer-workflow");
    if (!WORKFLOW_PATH.test(options.signerWorkflow)) {
      throw new Error("--signer-workflow must be a .github/workflows/*.yml path");
    }
  }
}

function selectVerifiedStatement(output, tarballSha256, sourceRevision) {
  const results = Array.isArray(output) ? output : [output];
  for (const entry of results) {
    const statement = (entry?.verificationResult ?? entry)?.statement;
    if (!statement || statement.predicateType !== "https://slsa.dev/provenance/v1") continue;
    if (!statement.subject?.some((subject) => subject?.digest?.sha256 === tarballSha256)) continue;
    const predicate = statement.predicate;
    if (
      !predicate?.buildDefinition?.resolvedDependencies?.some(
        (dependency) => dependency?.digest?.gitCommit === sourceRevision
      )
    ) {
      continue;
    }
    if (typeof predicate?.runDetails?.builder?.id !== "string" || !predicate.runDetails.builder.id) continue;
    return { statement, predicate };
  }
  throw new Error(`verified GitHub package provenance does not bind the tarball to ${sourceRevision}`);
}

function canonicalRegistryMetadata(metadata) {
  return Buffer.from(
    `${JSON.stringify({
      name: metadata.name,
      version: metadata.version,
      gitHead: metadata.gitHead,
      dist: { integrity: metadata.dist.integrity, tarball: metadata.dist.tarball }
    })}\n`
  );
}

function canonicalJsonBytes(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, normalize(entry[key])])
      );
    }
    return entry;
  };
  return Buffer.from(`${JSON.stringify(normalize(value))}\n`);
}

function normalizeRegistryOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--registry-origin must be a valid HTTPS origin");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("--registry-origin must be a credential-free HTTPS origin without path, query or fragment");
  }
  return url.origin;
}

function targetsHyperionNpmAlias(specifier) {
  if (!/^npm:/i.test(specifier)) return false;
  const target = specifier.slice(4);
  try {
    return /^@hyperion\//i.test(decodeURIComponent(target));
  } catch {
    return /^@hyperion\//i.test(target);
  }
}

async function readRegularFile(filePath, label, maxBytes) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error(`${label} must be a non-empty regular file without symbolic links`);
  }
  if (metadata.size > maxBytes) throw new Error(`${label} exceeds the 64 MiB safety limit`);
  return readFile(filePath);
}

function resolveInside(root, relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`unsafe repository-relative path: ${String(relativePath)}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`))
    throw new Error(`path escapes repository root: ${relativePath}`);
  return resolved;
}

function normalizeRelative(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

async function readJson(filePath) {
  return parseJson(await readFile(filePath), filePath);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function assertNoErrors(errors, label) {
  if (errors.length > 0) throw new Error(`${label}:\n${errors.join("\n")}`);
}

function assertCommand(result, label) {
  if (result.error) throw new Error(`${label} could not execute: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

function executeCommand(command, arguments_) {
  return spawnSync(command, arguments_, { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
}

function sha256(bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!SHA256.test(digest)) throw new Error("could not compute a non-zero SHA-256 digest");
  return digest;
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
}

function toKebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryableReadbackError(error) {
  const message = String(error?.message ?? error);
  if (!/(?:registry metadata|download immutable tarball|GitHub package provenance)/i.test(message)) return false;
  return /(?:E404|404 Not Found|E5\d\d|5\d\d|ECONN|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|no attestations?|not found|unavailable)/i.test(
    message
  );
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  const options = { operation };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--package-directory") options.packageDirectory = rest[++index];
    else if (argument === "--package-name") options.packageName = rest[++index];
    else if (argument === "--version") options.version = rest[++index];
    else if (argument === "--catalog") options.catalogPath = rest[++index];
    else if (argument === "--output-directory") options.outputDirectory = rest[++index];
    else if (argument === "--github-output") options.githubOutput = rest[++index];
    else if (argument === "--registry-origin") options.registryOrigin = rest[++index];
    else if (argument === "--source-revision") options.sourceRevision = rest[++index];
    else if (argument === "--source-repository") options.sourceRepository = rest[++index];
    else if (argument === "--local-tarball") options.localTarball = rest[++index];
    else if (argument === "--output") options.output = rest[++index];
    else if (argument === "--verified-at") options.verifiedAt = rest[++index];
    else if (argument === "--attempts") options.attempts = Number(rest[++index]);
    else if (argument === "--retry-delay-ms") options.retryDelayMs = Number(rest[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.operation === "pack") {
    const result = await packPublishableNpmArtifact(options);
    process.stdout.write(`PACKED_NPM_TARBALL=${result.tarballPath}\n`);
    process.stdout.write(`PACKED_NPM_SHA256=${result.tarballSha256}\n`);
    return;
  }
  if (options.operation === "preflight") {
    const result = preflightExactNpmArtifact(options);
    if (options.githubOutput) {
      await appendFile(
        path.resolve(options.githubOutput),
        `already_published=${String(result.alreadyPublished)}\n`,
        "utf8"
      );
    }
    process.stdout.write(`NPM_ARTIFACT_ALREADY_PUBLISHED=${String(result.alreadyPublished)}\n`);
    return;
  }
  if (options.operation === "readback") {
    requireString(options.output, "--output");
    const catalog = await readJson(path.resolve(options.catalogPath ?? defaultCatalogPath));
    const artifact = requireCatalogArtifact(catalog, options.packageName, options.version);
    if (typeof artifact.publication?.workflow !== "string" || !artifact.publication.workflow) {
      throw new Error(`${options.packageName} has no approved publication workflow in the provider artifact catalog`);
    }
    options.signerWorkflow = artifact.publication.workflow;
    const evidence = await verifyPublishedNpmArtifactWithRetry(options);
    const output = await writeRegistryEvidence(evidence, options.output);
    process.stdout.write(`VERIFIED_NPM_ARTIFACT=${evidence.packageName}@${evidence.version}\n`);
    process.stdout.write(`VERIFIED_NPM_TARBALL_SHA256=${evidence.tarballSha256}\n`);
    process.stdout.write(`VERIFIED_NPM_EVIDENCE=${output}\n`);
    return;
  }
  throw new Error("Expected operation: pack, preflight or readback");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
