import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  assertHeadWithinManifest,
  loadNovaExtractionManifest,
  rehearseNovaRepositoryExtraction,
  validateNovaExtractionManifest
} from "./rehearse-nova-repository-extraction.mjs";

const commandEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0"
};

test("versioned NOVA manifest uses real paths and records every lineage class", async () => {
  const { manifest } = await loadNovaExtractionManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.cell, "nova");
  assert.deepEqual(manifest.tagAllowlist, []);
  assert.ok(manifest.directPaths.includes("infra/docker/cells/nova.Dockerfile"));
  assert.ok(manifest.directPaths.includes("eslint.config.mjs"));
  assert.equal(manifest.directPaths.includes("infra/Dockerfile.nova"), false);
  assert.equal(manifest.directPaths.includes("eslint.config.js"), false);
  assert.ok(manifest.historicalRenames.length >= 18);
  assert.ok(manifest.ancestryOnly.length >= 6);
  assert.deepEqual(manifest.requiredExternalArtifacts, [
    "@hyperion/audit-contracts@1.1.0",
    "@hyperion/database@0.1.0",
    "@hyperion/logger@0.1.0",
    "@hyperion/platform-contracts@1.1.0"
  ]);
});

test("rejects unsafe or colliding manifest paths before invoking Git", () => {
  const base = fixtureManifest();
  assert.throws(
    () => validateNovaExtractionManifest({ ...base, directPaths: ["nova", "../escape"] }),
    /unsafe path segment/
  );
  assert.throws(
    () => validateNovaExtractionManifest({ ...base, directPaths: ["nova==>apps/lumen-console"] }),
    /safe repository-relative POSIX path/
  );
  assert.throws(
    () => validateNovaExtractionManifest({ ...base, tagAllowlist: ["nova-v1.0.0"] }),
    /tagAllowlist must remain empty/
  );
  assert.throws(
    () =>
      validateNovaExtractionManifest({
        ...base,
        historicalRenames: [{ from: "legacy/nova.txt", to: "outside/nova.txt" }]
      }),
    /outside the direct NOVA closure/
  );
  assert.throws(
    () =>
      validateNovaExtractionManifest({
        ...base,
        ancestryOnly: [{ ...base.ancestryOnly[0], headPolicy: "keep" }]
      }),
    /remove-during-adaptation/
  );
  const normalized = validateNovaExtractionManifest(base);
  assert.throws(
    () => assertHeadWithinManifest(normalized, ["direct/service.ts", "unexpected/product.txt"]),
    /outside the manifest allowlist/
  );
});

test("rehearsal preserves direct, renamed and ancestry-only history without sibling paths or remotes", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  const result = await rehearseNovaRepositoryExtraction(fixture.options);

  assert.equal(result.status, "filtered-history-only");
  assert.equal(result.source.sha, fixture.sourceSha);
  assert.notEqual(result.filtered.sha, fixture.sourceSha);
  assert.equal(result.filtered.remotes.length, 0);
  assert.match(result.tooling.git, /^git version /);
  assert.match(result.tooling.gitFilterRepo, /^[a-f0-9]+$/);
  assert.equal(result.lineage.length, 5);
  assert.ok(result.lineage.every((entry) => entry.identitiesAndTimestampsPreserved));
  assert.ok(result.lineage.every((entry) => entry.mappedCommitsPresentInFilteredPathHistory));
  assert.ok(result.lineage.every((entry) => entry.filteredPathHistoryMatchesMappedSourceSet));
  const ancestryTarget = result.lineage.find(
    (entry) => entry.kind === "ancestry-target" && entry.sourcePath === "nova/lineage.ts"
  );
  assert.equal(ancestryTarget.sourceCommitCount, 2);
  assert.equal(ancestryTarget.ancestrySourcePath, "ancestry/shared.ts");
  assert.deepEqual(result.ancestryOnlyPresentAtHead, ["ancestry/shared.ts"]);

  assert.equal(git(result.artifacts.bareRepository, "remote"), "");
  const filteredPaths = git(result.artifacts.bareRepository, "ls-tree", "-r", "--name-only", fixture.sourceRef).split(
    /\r?\n/
  );
  assert.ok(filteredPaths.includes("nova/app.txt"));
  assert.ok(filteredPaths.includes("nova-dir/page.ts"));
  assert.ok(filteredPaths.includes("ancestry/shared.ts"));
  assert.equal(
    filteredPaths.some((entry) => /(?:^|\/)(?:lumen|pulso)(?:[-/]|$)/i.test(entry)),
    false
  );
  assert.equal(filteredPaths.includes("apps/lumen-console/index.ts"), false);
  assert.equal(gitObjectExists(result.artifacts.bareRepository, `${fixture.sourceRef}:legacy/nova.txt`), false);
  assert.equal(gitObjectExists(result.artifacts.bareRepository, `${fixture.sourceRef}:legacy-dir/page.ts`), false);

  const renamedSubjects = git(
    result.artifacts.bareRepository,
    "log",
    "--format=%s",
    fixture.sourceRef,
    "--",
    "nova/app.txt"
  );
  assert.match(renamedSubjects, /split NOVA cell/);
  assert.match(renamedSubjects, /introduce legacy NOVA/);
  const renamedDirectorySubjects = git(
    result.artifacts.bareRepository,
    "log",
    "--format=%s",
    fixture.sourceRef,
    "--",
    "nova-dir/page.ts"
  );
  assert.match(renamedDirectorySubjects, /split NOVA cell/);
  assert.match(renamedDirectorySubjects, /introduce legacy NOVA/);

  const reportText = await readFile(result.reportPath, "utf8");
  const report = JSON.parse(reportText);
  assert.equal(report.filtered.sha, result.filtered.sha);
  assert.equal(report.filtered.remotes.length, 0);
  assert.deepEqual(report.filtered.tags, []);
  assert.deepEqual(report.publication.tagAllowlist, []);
  assert.equal(report.manifest.path, "scripts/federation/nova-repository-extraction.v1.json");
  assert.equal(report.manifest.matchesCandidateCommit, true);
  assert.equal(report.artifacts.bareRepository, "nova-history.git");
  assert.doesNotMatch(reportText, new RegExp(escapeRegExp(fixture.sourceRoot), "i"));
  assert.doesNotMatch(reportText, /hyperion-nova-extraction-[A-Za-z0-9._-]+/);
  assert.match(await readFile(result.artifacts.commitMapPath, "utf8"), new RegExp(fixture.sourceSha));
  assert.match(await readFile(result.artifacts.refMapPath, "utf8"), /refs\/heads\/main/);
  assert.equal(report.evidence.pathsFile.sha256, await fileSha256(result.artifacts.pathsFile));
  assert.equal(report.evidence.commitMap.sha256, await fileSha256(result.artifacts.commitMapPath));
  assert.equal(report.evidence.refMap.sha256, await fileSha256(result.artifacts.refMapPath));
  assert.equal(git(fixture.sourceRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");

  const repeated = await rehearseNovaRepositoryExtraction(fixture.options);
  assert.equal(await readFile(repeated.reportPath, "utf8"), reportText);
});

test("rejects a dirty source before creating a rehearsal directory", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  await writeFile(path.join(fixture.sourceRoot, "dirty.txt"), "not committed\n", "utf8");
  await assert.rejects(rehearseNovaRepositoryExtraction(fixture.options), /repository is dirty/);
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("rejects a missing direct path before cloning", async (context) => {
  const fixture = await prepareRepositoryFixture(context, { missingDirectPath: true });
  await assert.rejects(rehearseNovaRepositoryExtraction(fixture.options), /absent from candidate HEAD: missing.txt/);
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("rejects an exact ref/SHA mismatch before cloning", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  await assert.rejects(
    rehearseNovaRepositoryExtraction({ ...fixture.options, expectedSourceSha: "f".repeat(40) }),
    /Source ref mismatch/
  );
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("rejects a missing git-filter-repo prerequisite before creating temporary artifacts", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  const execute = (command, arguments_, options) => {
    if (command === "git" && arguments_[0] === "filter-repo" && arguments_[1] === "--version") {
      return { status: null, stdout: "", stderr: "", error: new Error("git-filter-repo not found") };
    }
    return spawnSync(command, arguments_, options);
  };
  await assert.rejects(
    rehearseNovaRepositoryExtraction({ ...fixture.options, execute }),
    /locate git-filter-repo could not execute/
  );
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("rejects a selected sibling product even when it is otherwise manifest-allowlisted", async (context) => {
  const fixture = await prepareRepositoryFixture(context, { selectForbiddenSibling: true });
  await assert.rejects(rehearseNovaRepositoryExtraction(fixture.options), /sibling product paths/);
});

test("rejects shallow and promisor-backed source repositories before cloning", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  const shallowRoot = path.join(path.dirname(fixture.sourceRoot), "shallow");
  git(
    path.dirname(fixture.sourceRoot),
    "clone",
    "--depth",
    "1",
    "--branch",
    "main",
    pathToFileURL(fixture.sourceRoot).href,
    shallowRoot
  );
  await assert.rejects(
    rehearseNovaRepositoryExtraction({
      ...fixture.options,
      sourceRepository: shallowRoot,
      manifestPath: path.join(shallowRoot, "scripts/federation/nova-repository-extraction.v1.json")
    }),
    /repository is shallow/
  );
  assert.deepEqual(await readdir(fixture.outputParent), []);

  git(fixture.sourceRoot, "config", "remote.origin.promisor", "true");
  await assert.rejects(rehearseNovaRepositoryExtraction(fixture.options), /partial or promisor-backed/);
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("binds the manifest bytes and location to the exact candidate commit", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  const manifestPath = fixture.options.manifestPath;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.description = "Locally substituted manifest that must not drive extraction.";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  git(
    fixture.sourceRoot,
    "update-index",
    "--assume-unchanged",
    "scripts/federation/nova-repository-extraction.v1.json"
  );
  assert.equal(git(fixture.sourceRoot, "status", "--porcelain=v1", "--untracked-files=all"), "");
  await assert.rejects(rehearseNovaRepositoryExtraction(fixture.options), /manifest bytes do not match/);
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("rejects an external manifest even when its bytes match the candidate", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  const externalManifest = path.join(path.dirname(fixture.sourceRoot), "external-extraction.json");
  await writeFile(externalManifest, await readFile(fixture.options.manifestPath));
  await assert.rejects(
    rehearseNovaRepositoryExtraction({ ...fixture.options, manifestPath: externalManifest }),
    /--manifest must be scripts\/federation\/nova-repository-extraction\.v1\.json inside the source checkout/
  );
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("rejects ancestry-only paths that are not actually present at candidate HEAD", async (context) => {
  const fixture = await prepareRepositoryFixture(context, { removeAncestryAtHead: true });
  await assert.rejects(rehearseNovaRepositoryExtraction(fixture.options), /Ancestry-only path is absent/);
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("rejects output-parent symlinks or junctions before creating artifacts", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  const linkedOutput = path.join(path.dirname(fixture.outputParent), "linked-output");
  await symlink(fixture.outputParent, linkedOutput, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    rehearseNovaRepositoryExtraction({ ...fixture.options, outputParent: linkedOutput }),
    /output-parent must be a real directory without symbolic links/
  );
  assert.deepEqual(await readdir(fixture.outputParent), []);
});

test("removes caller-supplied Git repository selectors from every spawned command", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  const previousGitDirectory = process.env.GIT_DIR;
  const previousGitWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(path.dirname(fixture.sourceRoot), "must-not-be-used.git");
  process.env.GIT_WORK_TREE = path.join(path.dirname(fixture.sourceRoot), "must-not-be-used-worktree");
  try {
    const execute = (command, arguments_, options) => {
      assert.equal(options.env.GIT_DIR, undefined);
      assert.equal(options.env.GIT_WORK_TREE, undefined);
      assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
      return spawnSync(command, arguments_, options);
    };
    const result = await rehearseNovaRepositoryExtraction({ ...fixture.options, execute });
    assert.equal(result.status, "filtered-history-only");
  } finally {
    restoreEnvironment("GIT_DIR", previousGitDirectory);
    restoreEnvironment("GIT_WORK_TREE", previousGitWorkTree);
  }
});

test("stays bound to the pinned SHA and verified manifest bytes after concurrent source changes", async (context) => {
  const fixture = await prepareRepositoryFixture(context);
  const originalManifestHash = await fileSha256(fixture.options.manifestPath);
  const parentSha = git(fixture.sourceRoot, "rev-parse", `${fixture.sourceSha}^`);
  let sourceMoved = false;
  const execute = (command, arguments_, options) => {
    const result = spawnSync(command, arguments_, options);
    if (!sourceMoved && result.status === 0 && command === "git" && arguments_[0] === "clone") {
      const update = spawnSync(
        "git",
        ["-C", fixture.sourceRoot, "update-ref", fixture.sourceRef, parentSha, fixture.sourceSha],
        { encoding: "utf8", shell: false, env: commandEnvironment }
      );
      assert.equal(update.status, 0, update.stderr || update.stdout);
      writeFileSync(fixture.options.manifestPath, '{"substituted":true}\n', "utf8");
      sourceMoved = true;
    }
    return result;
  };

  const result = await rehearseNovaRepositoryExtraction({ ...fixture.options, execute });
  assert.equal(sourceMoved, true);
  assert.equal(result.source.sha, fixture.sourceSha);
  assert.equal(result.manifest.sha256, originalManifestHash);
  assert.equal(git(fixture.sourceRoot, "rev-parse", fixture.sourceRef), parentSha);
});

test("requires git-filter-repo as an explicit local prerequisite", () => {
  const result = spawnSync("git", ["filter-repo", "--version"], {
    encoding: "utf8",
    shell: false,
    env: commandEnvironment
  });
  assert.equal(result.status, 0, result.stderr || "git-filter-repo must be installed");
  assert.match(result.stdout.trim(), /^[a-f0-9]+$/);
});

async function prepareRepositoryFixture(context, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-nova-extraction-test-"));
  context.after(async () => {
    const resolved = path.resolve(root);
    const temporaryRoot = path.resolve(os.tmpdir());
    const relative = path.relative(temporaryRoot, resolved);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.match(path.basename(resolved), /^hyperion-nova-extraction-test-[A-Za-z0-9._-]+$/);
    await rm(resolved, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, "source");
  const outputParent = path.join(root, "output");
  await mkdir(sourceRoot);
  await mkdir(outputParent);
  git(sourceRoot, "init", "--initial-branch=main");
  git(sourceRoot, "config", "user.name", "NOVA History Test");
  git(sourceRoot, "config", "user.email", "nova-history@example.invalid");

  await writeFixtureFile(sourceRoot, "legacy/nova.txt", "legacy NOVA\n");
  await writeFixtureFile(sourceRoot, "legacy-dir/page.ts", "export const legacyDirectory = 1;\n");
  await writeFixtureFile(sourceRoot, "direct/service.ts", "export const version = 1;\n");
  await writeFixtureFile(sourceRoot, "ancestry/shared.ts", "export const shared = true;\n");
  await writeFixtureFile(sourceRoot, "apps/lumen-console/index.ts", "export const sibling = 'LUMEN';\n");
  git(sourceRoot, "add", ".");
  gitWithDates(sourceRoot, "2026-01-02T03:04:05Z", "commit", "-m", "introduce legacy NOVA");

  await mkdir(path.join(sourceRoot, "nova"), { recursive: true });
  await rename(path.join(sourceRoot, "legacy", "nova.txt"), path.join(sourceRoot, "nova", "app.txt"));
  await rename(path.join(sourceRoot, "legacy-dir"), path.join(sourceRoot, "nova-dir"));
  await writeFixtureFile(sourceRoot, "nova/app.txt", "legacy NOVA\nextracted into its own cell\n");
  await writeFixtureFile(sourceRoot, "nova-dir/page.ts", "export const legacyDirectory = 2;\n");
  await writeFixtureFile(sourceRoot, "direct/service.ts", "export const version = 2;\n");
  await writeFixtureFile(sourceRoot, "nova/lineage.ts", "export const lineage = true;\n");
  await writeFixtureFile(sourceRoot, "apps/pulso-console/index.ts", "export const sibling = 'PULSO';\n");
  if (options.removeAncestryAtHead) {
    await rm(path.join(sourceRoot, "ancestry", "shared.ts"));
  }

  const manifest = fixtureManifest(options);
  await writeFixtureFile(
    sourceRoot,
    "scripts/federation/nova-repository-extraction.v1.json",
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  git(sourceRoot, "add", ".");
  gitWithDates(sourceRoot, "2026-02-03T04:05:06Z", "commit", "-m", "split NOVA cell");

  await writeFixtureFile(sourceRoot, "nova/lineage.ts", "export const lineage = 'post-split';\n");
  git(sourceRoot, "add", "nova/lineage.ts");
  gitWithDates(sourceRoot, "2026-03-04T05:06:07Z", "commit", "-m", "advance NOVA target lineage");

  const sourceRef = "refs/heads/main";
  const sourceSha = git(sourceRoot, "rev-parse", sourceRef);
  return {
    sourceRoot,
    outputParent,
    sourceRef,
    sourceSha,
    options: {
      sourceRepository: sourceRoot,
      sourceRef,
      expectedSourceSha: sourceSha,
      manifestPath: path.join(sourceRoot, "scripts/federation/nova-repository-extraction.v1.json"),
      outputParent
    }
  };
}

function fixtureManifest(options = {}) {
  const normalizedOptions = typeof options === "boolean" ? { missingDirectPath: options } : options;
  return {
    schemaVersion: 1,
    cell: "nova",
    description: "Synthetic NOVA extraction fixture.",
    tagAllowlist: [],
    directPaths: [
      "direct",
      "nova",
      "nova-dir",
      "scripts/federation",
      ...(normalizedOptions.missingDirectPath ? ["missing.txt"] : []),
      ...(normalizedOptions.selectForbiddenSibling ? ["apps/lumen-console"] : [])
    ],
    historicalRenames: [
      { from: "legacy/nova.txt", to: "nova/app.txt" },
      { from: "legacy-dir/", to: "nova-dir/" }
    ],
    directHistoryPaths: ["direct/service.ts"],
    ancestryOnly: [
      {
        path: "ancestry/shared.ts",
        lineageTargets: ["nova/lineage.ts"],
        headPolicy: "remove-during-adaptation",
        reason: "The shared source remains only to prove ancestry in the filtered history."
      }
    ],
    requiredExternalArtifacts: ["@hyperion/platform-contracts@1.1.0"],
    forbiddenHeadPathPrefixes: ["apps/lumen-", "apps/pulso-"],
    adaptationRequired: ["Remove the ancestry-only fixture before treating the filtered HEAD as autonomous."]
  };
}

async function fileSha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function writeFixtureFile(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

function git(repository, ...arguments_) {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
    env: commandEnvironment
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function gitWithDates(repository, date, ...arguments_) {
  const result = spawnSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...commandEnvironment, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function gitObjectExists(repository, object) {
  return (
    spawnSync("git", ["-C", repository, "cat-file", "-e", object], {
      encoding: "utf8",
      shell: false,
      env: commandEnvironment
    }).status === 0
  );
}
