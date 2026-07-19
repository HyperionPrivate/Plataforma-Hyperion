#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SOURCE_REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CELLS = new Set(["platform", "nova", "lumen", "pulso"]);
export const RELEASE_EVIDENCE_FILES = Object.freeze([
  "manifest.json",
  "image-inventory.json",
  "registry-verification.json",
  "npm-verification.json",
  "attestation.json",
  "SHA256SUMS"
]);
const CHECKSUMMED_FILES = RELEASE_EVIDENCE_FILES.filter((name) => name !== "SHA256SUMS");

export async function reconcileGitHubRelease(options, execute = executeCommand) {
  validateOptions(options);
  const releaseDirectory = path.resolve(options.releaseDirectory);
  const localAssets = await readAndValidateLocalBundle(releaseDirectory, options);
  const notes = await readRegularFile(path.join(releaseDirectory, "RELEASE-NOTES.md"), "release notes");
  const expectedBody = notes.toString("utf8");
  const tag = `release/${options.cell}/v${options.releaseVersion}`;
  const title = `${options.cell} v${options.releaseVersion}`;

  let release = readRelease(tag, execute);
  const initialState = release ? (release.isDraft ? "draft" : "published") : "absent";
  if (!release) {
    const tagState = readRemoteTag(tag, options.sourceRevision, options.sourceRepository, execute);
    const createArguments = ["release", "create", tag, ...assetPaths(releaseDirectory), "--draft"];
    if (tagState === "present") createArguments.push("--verify-tag");
    createArguments.push(
      "--target",
      options.sourceRevision,
      "--title",
      title,
      "--notes-file",
      path.join(releaseDirectory, "RELEASE-NOTES.md")
    );
    const created = execute("gh", createArguments);
    if (!commandSucceeded(created)) {
      release = readRelease(tag, execute);
      if (!release) assertCommand(created, `create draft release ${tag}`);
    } else {
      release = readRelease(tag, execute);
    }
    if (!release) throw new Error(`draft release ${tag} was not visible after creation`);
  }

  validateReleaseIdentity(release, { tag, title, expectedBody, sourceRevision: options.sourceRevision });
  readRemoteTag(tag, options.sourceRevision, options.sourceRepository, execute, true);
  await reconcileAssets(release, tag, releaseDirectory, localAssets, execute);

  release = readRelease(tag, execute);
  if (!release) throw new Error(`release ${tag} disappeared during reconciliation`);
  validateReleaseIdentity(release, { tag, title, expectedBody, sourceRevision: options.sourceRevision });
  await verifyRemoteAssets(release, tag, localAssets, execute);

  if (release.isDraft) {
    assertCommand(execute("gh", ["release", "edit", tag, "--draft=false"]), `publish reconciled release ${tag}`);
  }
  const published = readRelease(tag, execute);
  if (!published) throw new Error(`release ${tag} disappeared after publication`);
  validateReleaseIdentity(published, { tag, title, expectedBody, sourceRevision: options.sourceRevision });
  if (published.isDraft) throw new Error(`release ${tag} remained a draft after publication`);
  await verifyRemoteAssets(published, tag, localAssets, execute);

  return {
    tag,
    state: initialState === "published" ? "already-published" : initialState === "draft" ? "resumed" : "created",
    assetCount: RELEASE_EVIDENCE_FILES.length
  };
}

async function reconcileAssets(release, tag, releaseDirectory, localAssets, execute) {
  const assetNames = validateRemoteAssetNames(release);
  const missing = RELEASE_EVIDENCE_FILES.filter((name) => !assetNames.has(name));
  await verifyRemoteAssets(release, tag, localAssets, execute, { allowMissing: true });
  if (missing.length === 0) return;
  if (!release.isDraft) {
    throw new Error(`published release ${tag} is missing immutable assets: ${missing.join(", ")}`);
  }
  const upload = execute("gh", ["release", "upload", tag, ...missing.map((name) => path.join(releaseDirectory, name))]);
  assertCommand(upload, `upload missing assets to draft release ${tag}`);
}

async function verifyRemoteAssets(release, tag, localAssets, execute, options = {}) {
  const assetNames = validateRemoteAssetNames(release);
  const missing = RELEASE_EVIDENCE_FILES.filter((name) => !assetNames.has(name));
  if (missing.length > 0 && options.allowMissing !== true) {
    throw new Error(`release ${tag} is missing immutable assets: ${missing.join(", ")}`);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "hyperion-release-readback-"));
  try {
    for (const name of RELEASE_EVIDENCE_FILES) {
      if (!assetNames.has(name)) continue;
      assertCommand(
        execute("gh", ["release", "download", tag, "--pattern", name, "--dir", directory]),
        `download ${name} from release ${tag}`
      );
      const remote = await readRegularFile(path.join(directory, name), `downloaded release asset ${name}`);
      if (!remote.equals(localAssets.get(name))) {
        throw new Error(`release ${tag} asset ${name} differs from the sealed local candidate`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validateRemoteAssetNames(release) {
  if (!Array.isArray(release.assets)) throw new Error("GitHub release assets must be an array");
  const names = release.assets.map((asset) => asset?.name);
  if (names.some((name) => typeof name !== "string" || !name)) {
    throw new Error("GitHub release contains an asset without a valid name");
  }
  if (new Set(names).size !== names.length) throw new Error("GitHub release contains duplicate asset names");
  const unexpected = names.filter((name) => !RELEASE_EVIDENCE_FILES.includes(name));
  if (unexpected.length > 0) {
    throw new Error(`GitHub release contains unexpected immutable assets: ${unexpected.join(", ")}`);
  }
  return new Set(names);
}

async function readAndValidateLocalBundle(releaseDirectory, options) {
  const assets = new Map();
  for (const name of RELEASE_EVIDENCE_FILES) {
    assets.set(name, await readRegularFile(path.join(releaseDirectory, name), `local release asset ${name}`));
  }
  const manifest = parseJson(assets.get("manifest.json"), "published manifest");
  if (
    manifest.cell !== options.cell ||
    manifest.releaseVersion !== options.releaseVersion ||
    manifest.sourceRevision !== options.sourceRevision ||
    manifest.status !== "published"
  ) {
    throw new Error("published manifest identity differs from the requested GitHub release");
  }
  const checksumLines = assets.get("SHA256SUMS").toString("utf8").trimEnd().split(/\r?\n/);
  if (checksumLines.length !== CHECKSUMMED_FILES.length) {
    throw new Error("SHA256SUMS must contain every evidence asset exactly once");
  }
  const checksums = new Map();
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || !CHECKSUMMED_FILES.includes(match[2]) || checksums.has(match[2])) {
      throw new Error("SHA256SUMS contains an invalid, duplicate or unexpected entry");
    }
    checksums.set(match[2], match[1]);
  }
  for (const name of CHECKSUMMED_FILES) {
    if (checksums.get(name) !== sha256(assets.get(name))) {
      throw new Error(`SHA256SUMS does not seal ${name}`);
    }
  }
  return assets;
}

function validateReleaseIdentity(release, expected) {
  if (
    release.tagName !== expected.tag ||
    release.name !== expected.title ||
    release.targetCommitish !== expected.sourceRevision ||
    release.body !== expected.expectedBody ||
    release.isPrerelease !== false ||
    typeof release.isDraft !== "boolean"
  ) {
    throw new Error(`GitHub release ${expected.tag} identity differs from the sealed candidate`);
  }
}

function readRelease(tag, execute) {
  const result = execute("gh", [
    "release",
    "view",
    tag,
    "--json",
    "tagName,targetCommitish,name,body,isDraft,isPrerelease,assets"
  ]);
  if (commandSucceeded(result)) return parseJson(Buffer.from(result.stdout), `GitHub release ${tag}`);
  const detail = String(result.stderr || result.stdout || "");
  if (result.status === 1 && /(?:release not found|HTTP 404)/i.test(detail)) return undefined;
  assertCommand(result, `read GitHub release ${tag}`);
}

function readRemoteTag(tag, sourceRevision, sourceRepository, execute, requirePresent = false) {
  const encodedTag = tag.split("/").map(encodeURIComponent).join("/");
  const result = execute("gh", ["api", `repos/${sourceRepository}/git/ref/tags/${encodedTag}`]);
  const detail = String(result.stderr || result.stdout || "");
  if (result.status === 1 && !result.error && /HTTP 404/i.test(detail)) {
    if (requirePresent) throw new Error(`release tag ${tag} is absent after release creation`);
    return "absent";
  }
  assertCommand(result, `resolve release tag ${tag}`);
  const reference = parseJson(Buffer.from(result.stdout), `GitHub tag reference ${tag}`);
  if (reference?.ref !== `refs/tags/${tag}`) {
    throw new Error(`GitHub returned a different reference while resolving release tag ${tag}`);
  }
  const resolved = resolveTagObject(reference.object, sourceRepository, execute, tag);
  if (resolved !== sourceRevision) {
    throw new Error(`release tag ${tag} resolves to ${resolved ?? "no commit"}, expected ${sourceRevision}`);
  }
  return "present";
}

function resolveTagObject(initialObject, sourceRepository, execute, tag) {
  let object = initialObject;
  const seen = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!object || !SOURCE_REVISION.test(object.sha ?? "") || !["commit", "tag"].includes(object.type)) {
      throw new Error(`release tag ${tag} has an invalid Git object`);
    }
    if (object.type === "commit") return object.sha;
    if (seen.has(object.sha)) throw new Error(`release tag ${tag} contains an annotated-tag cycle`);
    seen.add(object.sha);
    const result = execute("gh", ["api", `repos/${sourceRepository}/git/tags/${object.sha}`]);
    assertCommand(result, `dereference annotated release tag ${tag}`);
    object = parseJson(Buffer.from(result.stdout), `annotated GitHub tag ${tag}`).object;
  }
  throw new Error(`release tag ${tag} exceeds the annotated-tag depth limit`);
}

function assetPaths(releaseDirectory) {
  return RELEASE_EVIDENCE_FILES.map((name) => path.join(releaseDirectory, name));
}

function validateOptions(options) {
  if (!CELLS.has(options.cell)) throw new Error("--cell must be platform, nova, lumen or pulso");
  if (!SEMVER.test(options.releaseVersion ?? "")) throw new Error("--release-version must be SemVer");
  if (!SOURCE_REVISION.test(options.sourceRevision ?? "")) {
    throw new Error("--source-revision must be a non-zero lowercase 40-character Git SHA");
  }
  if (!SOURCE_REPOSITORY.test(options.sourceRepository ?? "")) {
    throw new Error("--source-repository must use owner/repository syntax");
  }
  if (typeof options.releaseDirectory !== "string" || !options.releaseDirectory) {
    throw new Error("--release-directory is required");
  }
}

async function readRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error(`${label} must be a non-empty regular file without symbolic links`);
  }
  return readFile(filePath);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function commandSucceeded(result) {
  return !result.error && result.status === 0;
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

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--release-version") options.releaseVersion = argv[++index];
    else if (argument === "--source-revision") options.sourceRevision = argv[++index];
    else if (argument === "--source-repository") options.sourceRepository = argv[++index];
    else if (argument === "--release-directory") options.releaseDirectory = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const result = await reconcileGitHubRelease(parseArguments(process.argv.slice(2)));
  process.stdout.write(`RECONCILED_RELEASE_TAG=${result.tag}\n`);
  process.stdout.write(`RECONCILED_RELEASE_STATE=${result.state}\n`);
  process.stdout.write(`RECONCILED_RELEASE_ASSET_COUNT=${result.assetCount}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
