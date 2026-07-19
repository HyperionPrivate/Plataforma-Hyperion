#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./generate-release-manifest.mjs";
import { parseOciImageReference } from "./release-model.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "../..");
const SOURCE_REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function verifyImageProvenance(options, root = defaultRepositoryRoot, execute = executeCommand) {
  for (const name of ["cell", "catalogVersion", "sourceRevision", "sourceRepository", "imageInventory", "output"]) {
    if (typeof options[name] !== "string" || !options[name]) throw new Error(`--${toKebab(name)} is required`);
  }
  if (!SOURCE_REVISION.test(options.sourceRevision)) {
    throw new Error("--source-revision must be a non-zero lowercase 40-character Git SHA");
  }
  if (!SOURCE_REPOSITORY.test(options.sourceRepository)) {
    throw new Error("--source-repository must use owner/repository syntax");
  }
  const catalog = await loadCatalog(root, options.cell, options.catalogVersion);
  const inventoryBytes = await readRegularFile(path.resolve(options.imageInventory), "image inventory");
  const inventory = parseJson(inventoryBytes, "image inventory");
  validateInventory(inventory, options, catalog);

  const evidenceImages = {};
  for (const component of catalog.components.filter((entry) => entry.distribution === "oci")) {
    const image = inventory.images[component.id];
    const parsedImage = parseOciImageReference(image);
    if (!parsedImage || parsedImage.repository !== component.imageRepository || /^0{64}$/.test(parsedImage.digest)) {
      throw new Error(`image inventory ${component.id} is not an exact catalog OCI digest`);
    }

    const registry = execute("docker", ["buildx", "imagetools", "inspect", image]);
    assertCommand(registry, `registry readback for ${component.id}`);
    const registryDigest = parseRegistryDigest(registry.stdout, component.id);
    if (registryDigest !== parsedImage.digest) {
      throw new Error(`registry readback for ${component.id} returned a divergent digest`);
    }

    const provenance = execute("gh", [
      "attestation",
      "verify",
      `oci://${image}`,
      "--repo",
      options.sourceRepository,
      "--bundle-from-oci",
      "--signer-workflow",
      `${options.sourceRepository}/.github/workflows/build-attested-cell-images.yml`,
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
    assertCommand(provenance, `GitHub provenance verification for ${component.id}`);
    const verified = selectVerifiedStatement(
      parseJson(Buffer.from(provenance.stdout), `${component.id} GitHub provenance`),
      parsedImage,
      options.sourceRevision
    );
    evidenceImages[component.id] = {
      image,
      sourceRevision: options.sourceRevision,
      builderId: verified.predicate.runDetails.builder.id,
      registryInspectionSha256: hash(canonicalJsonBytes({ image, digest: `sha256:${registryDigest}` })),
      verifiedProvenanceSha256: hash(canonicalJsonBytes(verified.statement))
    };
  }

  const evidence = {
    schemaVersion: 1,
    verifier: "gh-attestation+docker-registry-readback",
    sourceRepository: options.sourceRepository,
    cell: options.cell,
    catalogVersion: options.catalogVersion,
    sourceRevision: options.sourceRevision,
    verifiedAt: options.verifiedAt ?? new Date().toISOString(),
    imageInventorySha256: hash(inventoryBytes),
    images: evidenceImages
  };
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: options.force ? "w" : "wx",
    mode: 0o600
  });
  return evidence;
}

function validateInventory(inventory, options, catalog) {
  exactKeys(inventory, ["schemaVersion", "cell", "catalogVersion", "sourceRevision", "images"], "image inventory");
  if (
    inventory.schemaVersion !== 1 ||
    inventory.cell !== options.cell ||
    inventory.catalogVersion !== options.catalogVersion ||
    inventory.sourceRevision !== options.sourceRevision ||
    !inventory.images ||
    typeof inventory.images !== "object" ||
    Array.isArray(inventory.images)
  ) {
    throw new Error("image inventory identity does not match the requested release source");
  }
  const expectedIds = catalog.components.filter((entry) => entry.distribution === "oci").map((entry) => entry.id);
  if (JSON.stringify(Object.keys(inventory.images).sort()) !== JSON.stringify(expectedIds.sort())) {
    throw new Error("image inventory must contain exactly every catalog OCI component");
  }
}

function selectVerifiedStatement(verificationOutput, parsedImage, sourceRevision) {
  const results = Array.isArray(verificationOutput) ? verificationOutput : [verificationOutput];
  for (const entry of results) {
    const verification = entry?.verificationResult ?? entry;
    const statement = verification?.statement;
    if (!statement || statement.predicateType !== "https://slsa.dev/provenance/v1") continue;
    const subjectMatches = statement.subject?.some(
      (subject) => subject?.name === parsedImage.repository && subject?.digest?.sha256 === parsedImage.digest
    );
    if (!subjectMatches) continue;
    const predicate = statement.predicate;
    const dependencyMatches = predicate?.buildDefinition?.resolvedDependencies?.some(
      (dependency) => dependency?.digest?.gitCommit === sourceRevision
    );
    if (!dependencyMatches) continue;
    if (typeof predicate?.runDetails?.builder?.id !== "string" || !predicate.runDetails.builder.id) continue;
    return { statement, predicate };
  }
  throw new Error(
    `verified GitHub provenance does not bind ${parsedImage.repository}@sha256:${parsedImage.digest} to ${sourceRevision}`
  );
}

function parseRegistryDigest(output, componentId) {
  const matches = [...String(output).matchAll(/^Digest:\s+sha256:([a-f0-9]{64})\s*$/gm)].map((match) => match[1]);
  if (matches.length !== 1) {
    throw new Error(`registry readback for ${componentId} must expose exactly one top-level SHA-256 digest`);
  }
  return matches[0];
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

function executeCommand(command, arguments_) {
  return spawnSync(command, arguments_, { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
}

function assertCommand(result, label) {
  if (result.error) throw new Error(`${label} could not execute: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}`);
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

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
    else if (argument === "--image-inventory") options.imageInventory = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--verified-at") options.verifiedAt = argv[++index];
    else if (argument === "--force") options.force = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const result = await verifyImageProvenance(parseArguments(process.argv.slice(2)), process.cwd());
  process.stdout.write(`VERIFIED_REGISTRY_CELL=${result.cell}\n`);
  process.stdout.write(`VERIFIED_REGISTRY_SOURCE_REVISION=${result.sourceRevision}\n`);
  process.stdout.write(`VERIFIED_REGISTRY_IMAGE_COUNT=${Object.keys(result.images).length}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
