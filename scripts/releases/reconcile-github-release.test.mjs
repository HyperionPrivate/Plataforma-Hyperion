import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reconcileGitHubRelease, RELEASE_EVIDENCE_FILES } from "./reconcile-github-release.mjs";

const sourceRevision = "a".repeat(40);
const cell = "nova";
const releaseVersion = "1.2.3";
const tag = `release/${cell}/v${releaseVersion}`;

async function localBundle(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hyperion-release-reconcile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = {
    "manifest.json": `${JSON.stringify({ cell, releaseVersion, sourceRevision, status: "published" })}\n`,
    "image-inventory.json": '{"images":{}}\n',
    "registry-verification.json": '{"images":{}}\n',
    "npm-verification.json": '{"packages":{}}\n',
    "attestation.json": '{"predicateType":"test"}\n'
  };
  for (const [name, bytes] of Object.entries(evidence)) await writeFile(path.join(directory, name), bytes);
  const checksumBytes = Object.entries(evidence)
    .map(([name, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${name}`)
    .join("\n");
  await writeFile(path.join(directory, "SHA256SUMS"), `${checksumBytes}\n`);
  await writeFile(
    path.join(directory, "RELEASE-NOTES.md"),
    `Federated release evidence for ${cell} ${releaseVersion} at source revision \`${sourceRevision}\`.\n`
  );
  return directory;
}

function fakeRemote(releaseDirectory, initial = {}) {
  const state = {
    tagSha: initial.tagSha,
    annotatedTagObjectSha: initial.annotated === true ? "c".repeat(40) : undefined,
    release: initial.release,
    failCreateAfterMutation: initial.failCreateAfterMutation === true,
    calls: []
  };
  const execute = (command, arguments_) => {
    state.calls.push([command, ...arguments_]);
    assert.equal(command, "gh");
    if (arguments_[0] === "api" && arguments_[1].includes("/git/ref/tags/")) {
      if (!state.tagSha) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      return {
        status: 0,
        stdout: JSON.stringify({
          ref: `refs/tags/${tag}`,
          object: state.annotatedTagObjectSha
            ? { type: "tag", sha: state.annotatedTagObjectSha }
            : { type: "commit", sha: state.tagSha }
        }),
        stderr: ""
      };
    }
    if (arguments_[0] === "api" && arguments_[1].includes("/git/tags/")) {
      assert.equal(arguments_[1].endsWith(state.annotatedTagObjectSha), true);
      return {
        status: 0,
        stdout: JSON.stringify({ object: { type: "commit", sha: state.tagSha } }),
        stderr: ""
      };
    }
    const operation = `${arguments_[0]} ${arguments_[1]}`;
    if (operation === "release view") {
      if (!state.release) return { status: 1, stdout: "", stderr: "release not found" };
      return { status: 0, stdout: JSON.stringify(releaseJson(state.release)), stderr: "" };
    }
    if (operation === "release create") {
      const target = arguments_[arguments_.indexOf("--target") + 1];
      const title = arguments_[arguments_.indexOf("--title") + 1];
      const notesPath = arguments_[arguments_.indexOf("--notes-file") + 1];
      const firstFlag = arguments_.findIndex((entry, index) => index >= 3 && entry.startsWith("--"));
      const assets = new Map(
        arguments_.slice(3, firstFlag).map((filePath) => [path.basename(filePath), readFileSync(filePath)])
      );
      state.tagSha ??= target;
      state.release = {
        tagName: arguments_[2],
        targetCommitish: target,
        name: title,
        body: readFileSync(notesPath, "utf8"),
        isDraft: true,
        isPrerelease: false,
        assets
      };
      if (state.failCreateAfterMutation) {
        state.failCreateAfterMutation = false;
        return { status: 1, stdout: "", stderr: "connection closed after server accepted the draft" };
      }
      return { status: 0, stdout: "created\n", stderr: "" };
    }
    if (operation === "release upload") {
      for (const filePath of arguments_.slice(3)) {
        const name = path.basename(filePath);
        if (state.release.assets.has(name)) return { status: 1, stdout: "", stderr: "asset already exists" };
        state.release.assets.set(name, readFileSync(filePath));
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (operation === "release download") {
      const name = arguments_[arguments_.indexOf("--pattern") + 1];
      const directory = arguments_[arguments_.indexOf("--dir") + 1];
      const bytes = state.release.assets.get(name);
      if (!bytes) return { status: 1, stdout: "", stderr: "asset not found" };
      writeFileSync(path.join(directory, name), bytes);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (operation === "release edit") {
      state.release.isDraft = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected fake command: ${command} ${arguments_.join(" ")}`);
  };
  return { state, execute, releaseDirectory };
}

function exactRelease(releaseDirectory, overrides = {}) {
  return {
    tagName: tag,
    targetCommitish: sourceRevision,
    name: `${cell} v${releaseVersion}`,
    body: `Federated release evidence for ${cell} ${releaseVersion} at source revision \`${sourceRevision}\`.\n`,
    isDraft: true,
    isPrerelease: false,
    assets: new Map(RELEASE_EVIDENCE_FILES.map((name) => [name, readFileSync(path.join(releaseDirectory, name))])),
    ...overrides
  };
}

function releaseJson(release) {
  return {
    ...release,
    assets: [...release.assets].map(([name, bytes]) => ({ name, size: bytes.length }))
  };
}

function options(releaseDirectory) {
  return { cell, releaseVersion, sourceRevision, sourceRepository: "example/hyperion", releaseDirectory };
}

test("creates, reads back and idempotently accepts one exact published release", async (context) => {
  const directory = await localBundle(context);
  const remote = fakeRemote(directory);
  const created = await reconcileGitHubRelease(options(directory), remote.execute);
  assert.equal(created.state, "created");
  assert.equal(remote.state.release.isDraft, false);
  assert.deepEqual([...remote.state.release.assets.keys()].sort(), [...RELEASE_EVIDENCE_FILES].sort());

  const createsBefore = remote.state.calls.filter((call) => call[1] === "release" && call[2] === "create").length;
  const repeated = await reconcileGitHubRelease(options(directory), remote.execute);
  assert.equal(repeated.state, "already-published");
  assert.equal(
    remote.state.calls.filter((call) => call[1] === "release" && call[2] === "create").length,
    createsBefore
  );
});

test("recovers by readback when draft creation mutates GitHub before the command fails", async (context) => {
  const directory = await localBundle(context);
  const remote = fakeRemote(directory, { failCreateAfterMutation: true });
  const result = await reconcileGitHubRelease(options(directory), remote.execute);
  assert.equal(result.state, "created");
  assert.equal(remote.state.release.isDraft, false);
  assert.deepEqual([...remote.state.release.assets.keys()].sort(), [...RELEASE_EVIDENCE_FILES].sort());
  assert.equal(remote.state.calls.filter((call) => call[1] === "release" && call[2] === "create").length, 1);
});

test("resumes an exact partial draft by uploading only missing assets", async (context) => {
  const directory = await localBundle(context);
  const release = exactRelease(directory);
  release.assets = new Map([...release.assets].slice(0, 2));
  const remote = fakeRemote(directory, { tagSha: sourceRevision, release });
  const result = await reconcileGitHubRelease(options(directory), remote.execute);
  assert.equal(result.state, "resumed");
  const upload = remote.state.calls.find((call) => call[1] === "release" && call[2] === "upload");
  assert.deepEqual(
    upload
      .slice(4)
      .map((filePath) => path.basename(filePath))
      .sort(),
    RELEASE_EVIDENCE_FILES.slice(2).sort()
  );
  assert.equal(remote.state.release.isDraft, false);
});

test("fails closed on divergent draft bytes without overwrite or publication", async (context) => {
  const directory = await localBundle(context);
  const release = exactRelease(directory);
  release.assets.set("manifest.json", Buffer.from("divergent\n"));
  const remote = fakeRemote(directory, { tagSha: sourceRevision, release });
  await assert.rejects(() => reconcileGitHubRelease(options(directory), remote.execute), /differs from the sealed/);
  assert.equal(
    remote.state.calls.some((call) => call[1] === "release" && call[2] === "upload"),
    false
  );
  assert.equal(
    remote.state.calls.some((call) => call[1] === "release" && call[2] === "edit"),
    false
  );
});

test("accepts an exact orphan tag but rejects one that targets another source", async (context) => {
  const directory = await localBundle(context);
  const exact = fakeRemote(directory, { tagSha: sourceRevision });
  await reconcileGitHubRelease(options(directory), exact.execute);
  const create = exact.state.calls.find((call) => call[1] === "release" && call[2] === "create");
  assert.ok(create.includes("--verify-tag"));

  const divergent = fakeRemote(directory, { tagSha: "b".repeat(40) });
  await assert.rejects(() => reconcileGitHubRelease(options(directory), divergent.execute), /expected a{40}/);
  assert.equal(divergent.state.release, undefined);
});

test("dereferences an exact annotated orphan tag through the authenticated GitHub API", async (context) => {
  const directory = await localBundle(context);
  const remote = fakeRemote(directory, { tagSha: sourceRevision, annotated: true });
  await reconcileGitHubRelease(options(directory), remote.execute);
  assert.ok(
    remote.state.calls.some(
      (call) => call[1] === "api" && call[2].includes(`/git/tags/${remote.state.annotatedTagObjectSha}`)
    )
  );
});

test("never repairs an incomplete already-published release", async (context) => {
  const directory = await localBundle(context);
  const release = exactRelease(directory, { isDraft: false });
  release.assets.delete("attestation.json");
  const remote = fakeRemote(directory, { tagSha: sourceRevision, release });
  await assert.rejects(
    () => reconcileGitHubRelease(options(directory), remote.execute),
    /published release .* missing/
  );
  assert.equal(
    remote.state.calls.some((call) => call[1] === "release" && call[2] === "upload"),
    false
  );
});
