#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./generate-release-manifest.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "../..");
const SOURCE_REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const MAX_NPM_TARBALL_BYTES = 64 * 1024 * 1024;

export async function verifyNpmProvenance(options, root = defaultRepositoryRoot, execute = executeCommand) {
  for (const name of ["cell", "catalogVersion", "sourceRevision", "sourceRepository", "registryOrigin", "output"]) {
    if (typeof options[name] !== "string" || !options[name]) throw new Error(`--${toKebab(name)} is required`);
  }
  if (!SOURCE_REVISION.test(options.sourceRevision)) {
    throw new Error("--source-revision must be a non-zero lowercase 40-character Git SHA");
  }
  if (!SOURCE_REPOSITORY.test(options.sourceRepository)) {
    throw new Error("--source-repository must use owner/repository syntax");
  }
  const registryOrigin = normalizeRegistryOrigin(options.registryOrigin);
  const catalog = await loadCatalog(root, options.cell, options.catalogVersion);
  const npmComponents = catalog.components.filter((component) => component.distribution === "npm");
  const directory = await mkdtemp(path.join(os.tmpdir(), "hyperion-npm-provenance-"));
  const packages = {};
  try {
    for (const component of npmComponents) {
      const packageReference = `${component.packageName}@${component.version}`;
      const metadataResult = execute("npm", ["view", packageReference, "--json", "--registry", registryOrigin]);
      assertCommand(metadataResult, `registry metadata for ${component.id}`);
      const metadata = parseJson(Buffer.from(metadataResult.stdout), `${component.id} npm registry metadata`);
      validateRegistryMetadata(metadata, component, options.sourceRevision, registryOrigin);

      const packResult = execute("npm", [
        "pack",
        packageReference,
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        directory,
        "--registry",
        registryOrigin
      ]);
      assertCommand(packResult, `download immutable tarball for ${component.id}`);
      const packOutput = parseJson(Buffer.from(packResult.stdout), `${component.id} npm pack output`);
      if (!Array.isArray(packOutput) || packOutput.length !== 1) {
        throw new Error(`${component.id} npm pack must return exactly one tarball`);
      }
      const packed = packOutput[0];
      if (
        !packed ||
        typeof packed.filename !== "string" ||
        path.basename(packed.filename) !== packed.filename ||
        packed.integrity !== metadata.dist.integrity
      ) {
        throw new Error(`${component.id} npm pack output differs from registry integrity metadata`);
      }
      const tarballPath = path.join(directory, packed.filename);
      const tarballBytes = await readRegularFile(tarballPath, `${component.id} npm tarball`, MAX_NPM_TARBALL_BYTES);
      if (sha512Integrity(tarballBytes) !== metadata.dist.integrity) {
        throw new Error(`${component.id} tarball bytes do not match the registry SHA-512 integrity`);
      }
      const tarballSha256 = hash(tarballBytes);

      const provenance = execute("gh", [
        "attestation",
        "verify",
        tarballPath,
        "--repo",
        options.sourceRepository,
        "--signer-workflow",
        `${options.sourceRepository}/.github/workflows/publish-provider-contracts.yml`,
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
      assertCommand(provenance, `GitHub package provenance verification for ${component.id}`);
      const verified = selectVerifiedStatement(
        parseJson(Buffer.from(provenance.stdout), `${component.id} GitHub package provenance`),
        tarballSha256,
        options.sourceRevision
      );
      packages[component.id] = {
        package: packageReference,
        registryTarball: metadata.dist.tarball,
        integrity: metadata.dist.integrity,
        tarballSha256,
        sourceRevision: options.sourceRevision,
        builderId: verified.predicate.runDetails.builder.id,
        registryMetadataSha256: hash(canonicalRegistryMetadata(metadata)),
        verifiedProvenanceSha256: hash(canonicalJsonBytes(verified.statement))
      };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const evidence = {
    schemaVersion: 1,
    verifier: "npm-registry-sha512+gh-attestation",
    sourceRepository: options.sourceRepository,
    registryOrigin,
    cell: options.cell,
    catalogVersion: options.catalogVersion,
    sourceRevision: options.sourceRevision,
    verifiedAt: options.verifiedAt ?? new Date().toISOString(),
    packages
  };
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: options.force ? "w" : "wx",
    mode: 0o600
  });
  return evidence;
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

function validateRegistryMetadata(metadata, component, sourceRevision, registryOrigin) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${component.id} npm registry metadata must be an object`);
  }
  if (metadata.name !== component.packageName || metadata.version !== component.version) {
    throw new Error(`${component.id} registry package identity differs from the release catalog`);
  }
  if (metadata.gitHead !== sourceRevision) {
    throw new Error(`${component.id} registry gitHead does not match the release source revision`);
  }
  if (!metadata.dist || typeof metadata.dist !== "object" || Array.isArray(metadata.dist)) {
    throw new Error(`${component.id} registry metadata has no immutable distribution`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist.integrity ?? "")) {
    throw new Error(`${component.id} registry metadata must provide SHA-512 integrity`);
  }
  let tarball;
  try {
    tarball = new URL(metadata.dist.tarball);
  } catch {
    throw new Error(`${component.id} registry tarball URL is invalid`);
  }
  if (
    tarball.protocol !== "https:" ||
    tarball.username ||
    tarball.password ||
    tarball.search ||
    tarball.hash ||
    tarball.origin !== registryOrigin
  ) {
    throw new Error(`${component.id} registry tarball must stay on the authorized HTTPS registry origin`);
  }
}

function selectVerifiedStatement(verificationOutput, tarballSha256, sourceRevision) {
  const results = Array.isArray(verificationOutput) ? verificationOutput : [verificationOutput];
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

async function readRegularFile(filePath, label, maxBytes) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error(`${label} must be a non-empty regular file without symbolic links`);
  }
  if (metadata.size > maxBytes) {
    throw new Error(`${label} exceeds the 64 MiB safety limit`);
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

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function hash(bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (!SHA256.test(digest)) throw new Error("could not compute SHA-256 digest");
  return digest;
}

function executeCommand(command, arguments_) {
  return spawnSync(command, arguments_, { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
}

function assertCommand(result, label) {
  if (result.error) throw new Error(`${label} could not execute: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

function toKebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function parseArguments(argv) {
  const options = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--catalog-version") options.catalogVersion = argv[++index];
    else if (argument === "--source-revision") options.sourceRevision = argv[++index];
    else if (argument === "--source-repository") options.sourceRepository = argv[++index];
    else if (argument === "--registry-origin") options.registryOrigin = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--verified-at") options.verifiedAt = argv[++index];
    else if (argument === "--force") options.force = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const result = await verifyNpmProvenance(parseArguments(process.argv.slice(2)));
  process.stdout.write(`VERIFIED_NPM_CELL=${result.cell}\n`);
  process.stdout.write(`VERIFIED_NPM_SOURCE_REVISION=${result.sourceRevision}\n`);
  process.stdout.write(`VERIFIED_NPM_PACKAGE_COUNT=${Object.keys(result.packages).length}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
