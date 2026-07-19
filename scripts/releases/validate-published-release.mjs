#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./generate-release-manifest.mjs";
import { packageSetSha256, validateNpmVerification } from "./npm-evidence.mjs";
import { assertValid, validateCatalogSources, validateManifest } from "./release-model.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "../..");
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;
const SOURCE_REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ATTESTATION_KEYS = [
  "schemaVersion",
  "predicateType",
  "cell",
  "catalogVersion",
  "releaseVersion",
  "sourceRevision",
  "sourceRepository",
  "issuedAt",
  "manifestSha256",
  "imageInventorySha256",
  "registryVerificationSha256",
  "npmVerificationSha256",
  "imageSetSha256",
  "imageCount",
  "packageSetSha256",
  "packageCount"
];

export async function validatePublishedRelease(options, root = defaultRepositoryRoot) {
  if (options.publishable !== true) throw new Error("--publishable is required for publication validation");
  for (const name of [
    "manifest",
    "imageInventory",
    "registryVerification",
    "npmVerification",
    "attestation",
    "sourceRevision",
    "sourceRepository"
  ]) {
    if (typeof options[name] !== "string" || !options[name]) throw new Error(`--${toKebab(name)} is required`);
  }
  if (!SOURCE_REVISION.test(options.sourceRevision)) {
    throw new Error("--source-revision must be a non-zero lowercase 40-character Git SHA");
  }
  if (!SOURCE_REPOSITORY.test(options.sourceRepository)) {
    throw new Error("--source-repository must use owner/repository syntax");
  }
  const manifestBytes = await readRegularFile(path.resolve(options.manifest), "published manifest");
  const inventoryBytes = await readRegularFile(path.resolve(options.imageInventory), "image inventory");
  const registryVerificationBytes = await readRegularFile(
    path.resolve(options.registryVerification),
    "registry provenance verification"
  );
  const npmVerificationBytes = await readRegularFile(
    path.resolve(options.npmVerification),
    "npm provenance verification"
  );
  const attestationBytes = await readRegularFile(path.resolve(options.attestation), "release attestation");
  const manifest = parseJson(manifestBytes, "published manifest");
  const inventory = parseJson(inventoryBytes, "image inventory");
  const registryVerification = parseJson(registryVerificationBytes, "registry provenance verification");
  const npmVerification = parseJson(npmVerificationBytes, "npm provenance verification");
  const attestation = parseJson(attestationBytes, "release attestation");
  if (!manifest.cell || !manifest.catalogVersion) throw new Error("published manifest has no catalog identity");
  const catalog = await loadCatalog(root, manifest.cell, manifest.catalogVersion);
  if (options.requireCheckoutSourceParity !== false) {
    assertValid(
      validateCatalogSources(catalog, { context: `${manifest.cell} release catalog`, root }),
      "Release catalog sources are invalid"
    );
  }
  assertValid(
    validateManifest(manifest, catalog, { context: "published release manifest", publishable: true }),
    "Published release is not publishable"
  );
  if (manifest.sourceRevision !== options.sourceRevision) {
    throw new Error("published manifest sourceRevision differs from the checked-out source revision");
  }

  exactKeys(attestation, ATTESTATION_KEYS, "release attestation");
  if (
    attestation.schemaVersion !== 2 ||
    attestation.predicateType !== "https://hyperion.example/attestations/federated-release/v2"
  ) {
    throw new Error("release attestation identity is invalid");
  }
  for (const [name, expected] of [
    ["cell", manifest.cell],
    ["catalogVersion", manifest.catalogVersion],
    ["releaseVersion", manifest.releaseVersion],
    ["sourceRevision", manifest.sourceRevision],
    ["sourceRepository", options.sourceRepository],
    ["issuedAt", manifest.generatedAt]
  ]) {
    if (attestation[name] !== expected) throw new Error(`release attestation ${name} differs from manifest`);
  }
  for (const name of ["manifestSha256", "imageInventorySha256", "imageSetSha256"]) {
    if (!SHA256.test(attestation[name])) throw new Error(`release attestation ${name} is invalid`);
  }
  if (attestation.manifestSha256 !== hash(manifestBytes)) {
    throw new Error("release attestation manifestSha256 does not match the manifest bytes");
  }
  if (attestation.imageInventorySha256 !== hash(inventoryBytes)) {
    throw new Error("release attestation imageInventorySha256 does not match the inventory bytes");
  }
  if (attestation.registryVerificationSha256 !== hash(registryVerificationBytes)) {
    throw new Error("release attestation registryVerificationSha256 does not match registry evidence bytes");
  }
  if (attestation.npmVerificationSha256 !== hash(npmVerificationBytes)) {
    throw new Error("release attestation npmVerificationSha256 does not match npm evidence bytes");
  }

  exactKeys(inventory, ["schemaVersion", "cell", "catalogVersion", "sourceRevision", "images"], "image inventory");
  if (
    inventory.schemaVersion !== 1 ||
    inventory.cell !== manifest.cell ||
    inventory.catalogVersion !== manifest.catalogVersion ||
    inventory.sourceRevision !== manifest.sourceRevision ||
    !inventory.images ||
    typeof inventory.images !== "object" ||
    Array.isArray(inventory.images)
  ) {
    throw new Error("image inventory identity differs from published manifest");
  }
  const manifestImages = Object.fromEntries(
    manifest.components.filter((component) => component.image).map((component) => [component.id, component.image])
  );
  if (JSON.stringify(sortObject(inventory.images)) !== JSON.stringify(sortObject(manifestImages))) {
    throw new Error("published manifest images differ from the exact image inventory");
  }
  validateRegistryVerification(
    registryVerification,
    manifest,
    options.sourceRepository,
    hash(inventoryBytes),
    manifestImages
  );
  const imageLines = Object.entries(manifestImages)
    .map(([id, image]) => `${id}=${image}`)
    .sort();
  const imageSetSha256 = hash(Buffer.from(`${imageLines.join("\n")}\n`));
  if (attestation.imageSetSha256 !== imageSetSha256 || attestation.imageCount !== imageLines.length) {
    throw new Error("release attestation image set differs from the published manifest");
  }
  const packages = validateNpmVerification(npmVerification, catalog, {
    sourceRepository: options.sourceRepository,
    cell: manifest.cell,
    catalogVersion: manifest.catalogVersion,
    sourceRevision: manifest.sourceRevision
  });
  const manifestPackages = Object.fromEntries(
    manifest.components.filter((component) => component.package).map((component) => [component.id, component.package])
  );
  const evidencePackages = Object.fromEntries([...packages].map(([id, entry]) => [id, entry.package]));
  if (JSON.stringify(sortObject(manifestPackages)) !== JSON.stringify(sortObject(evidencePackages))) {
    throw new Error("published manifest packages differ from verified npm provenance evidence");
  }
  const verifiedPackageSetSha256 = packageSetSha256(packages);
  if (attestation.packageSetSha256 !== verifiedPackageSetSha256 || attestation.packageCount !== packages.size) {
    throw new Error("release attestation package set differs from the published manifest");
  }

  return {
    cell: manifest.cell,
    releaseVersion: manifest.releaseVersion,
    manifestSha256: attestation.manifestSha256,
    imageSetSha256,
    imageCount: imageLines.length,
    packageSetSha256: verifiedPackageSetSha256,
    packageCount: packages.size
  };
}

function validateRegistryVerification(evidence, manifest, sourceRepository, inventorySha256, manifestImages) {
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "verifier",
      "sourceRepository",
      "cell",
      "catalogVersion",
      "sourceRevision",
      "verifiedAt",
      "imageInventorySha256",
      "images"
    ],
    "registry provenance verification"
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.verifier !== "gh-attestation+docker-registry-readback" ||
    evidence.sourceRepository !== sourceRepository ||
    evidence.cell !== manifest.cell ||
    evidence.catalogVersion !== manifest.catalogVersion ||
    evidence.sourceRevision !== manifest.sourceRevision ||
    evidence.imageInventorySha256 !== inventorySha256 ||
    !Number.isFinite(Date.parse(evidence.verifiedAt)) ||
    !evidence.images ||
    typeof evidence.images !== "object" ||
    Array.isArray(evidence.images)
  ) {
    throw new Error("registry provenance verification identity differs from published manifest");
  }
  if (JSON.stringify(Object.keys(evidence.images).sort()) !== JSON.stringify(Object.keys(manifestImages).sort())) {
    throw new Error("registry provenance verification does not cover the published image set");
  }
  for (const [id, image] of Object.entries(manifestImages)) {
    const entry = evidence.images[id];
    exactKeys(
      entry,
      ["image", "sourceRevision", "builderId", "registryInspectionSha256", "verifiedProvenanceSha256"],
      `registry provenance verification ${id}`
    );
    if (
      entry.image !== image ||
      entry.sourceRevision !== manifest.sourceRevision ||
      typeof entry.builderId !== "string" ||
      !entry.builderId ||
      !SHA256.test(entry.registryInspectionSha256) ||
      !SHA256.test(entry.verifiedProvenanceSha256)
    ) {
      throw new Error(`registry provenance verification ${id} is invalid`);
    }
  }
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

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toKebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function parseArguments(argv) {
  const options = { publishable: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") options.manifest = argv[++index];
    else if (argument === "--image-inventory") options.imageInventory = argv[++index];
    else if (argument === "--registry-verification") options.registryVerification = argv[++index];
    else if (argument === "--npm-verification") options.npmVerification = argv[++index];
    else if (argument === "--attestation") options.attestation = argv[++index];
    else if (argument === "--source-revision") options.sourceRevision = argv[++index];
    else if (argument === "--source-repository") options.sourceRepository = argv[++index];
    else if (argument === "--publishable") options.publishable = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const result = await validatePublishedRelease(parseArguments(process.argv.slice(2)), process.cwd());
  process.stdout.write(`PUBLISHABLE_CELL=${result.cell}\n`);
  process.stdout.write(`PUBLISHABLE_RELEASE_VERSION=${result.releaseVersion}\n`);
  process.stdout.write(`PUBLISHABLE_MANIFEST_SHA256=${result.manifestSha256}\n`);
  process.stdout.write(`PUBLISHABLE_IMAGE_SET_SHA256=${result.imageSetSha256}\n`);
  process.stdout.write(`PUBLISHABLE_IMAGE_COUNT=${result.imageCount}\n`);
  process.stdout.write(`PUBLISHABLE_PACKAGE_SET_SHA256=${result.packageSetSha256}\n`);
  process.stdout.write(`PUBLISHABLE_PACKAGE_COUNT=${result.packageCount}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
