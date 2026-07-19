#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { generateManifest, loadCatalog } from "./generate-release-manifest.mjs";
import { packageSetSha256, validateNpmVerification } from "./npm-evidence.mjs";
import {
  assertValid,
  draftImageReference,
  parseOciImageReference,
  validateCatalogSources,
  validateManifest
} from "./release-model.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "../..");
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;
const SOURCE_REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INVENTORY_KEYS = ["schemaVersion", "cell", "catalogVersion", "sourceRevision", "images"];

export async function preparePublishedRelease(options, root = defaultRepositoryRoot) {
  requireOption(options.cell, "--cell");
  requireOption(options.catalogVersion, "--catalog-version");
  requireOption(options.releaseVersion, "--release-version");
  requireOption(options.sourceRevision, "--source-revision");
  requireOption(options.sourceRepository, "--source-repository");
  requireOption(options.imageInventory, "--image-inventory");
  requireOption(options.registryVerification, "--registry-verification");
  requireOption(options.npmVerification, "--npm-verification");
  requireOption(options.manifestOutput, "--manifest-output");
  requireOption(options.attestationOutput, "--attestation-output");
  if (!SOURCE_REVISION.test(options.sourceRevision)) {
    throw new Error("--source-revision must be a non-zero lowercase 40-character Git SHA");
  }
  if (!SOURCE_REPOSITORY.test(options.sourceRepository)) {
    throw new Error("--source-repository must use owner/repository syntax");
  }

  const catalog = await loadCatalog(root, options.cell, options.catalogVersion);
  assertValid(
    validateCatalogSources(catalog, { context: `${options.cell} release catalog`, root }),
    "Release catalog sources are invalid"
  );
  const inventoryBytes = await readRegularFile(path.resolve(options.imageInventory), "image inventory");
  const inventory = parseJson(inventoryBytes, "image inventory");
  const registryVerificationBytes = await readRegularFile(
    path.resolve(options.registryVerification),
    "registry provenance verification"
  );
  const registryVerification = parseJson(registryVerificationBytes, "registry provenance verification");
  const npmVerificationBytes = await readRegularFile(
    path.resolve(options.npmVerification),
    "npm provenance verification"
  );
  const npmVerification = parseJson(npmVerificationBytes, "npm provenance verification");
  validateInventoryEnvelope(inventory, options);
  const packages = validateNpmVerification(npmVerification, catalog, options);

  const ociComponents = catalog.components.filter((component) => component.distribution === "oci");
  const expectedIds = new Set(ociComponents.map((component) => component.id));
  if (Object.keys(inventory.images).length !== expectedIds.size) {
    throw new Error(`image inventory must contain exactly ${expectedIds.size} ${options.cell} OCI components`);
  }
  const images = new Map();
  for (const [id, image] of Object.entries(inventory.images)) {
    if (!expectedIds.has(id)) throw new Error(`image inventory contains unknown or non-OCI component ${id}`);
    const component = ociComponents.find((entry) => entry.id === id);
    const parsed = parseOciImageReference(image);
    if (!parsed || !SHA256.test(parsed.digest)) {
      throw new Error(`image inventory ${id} must use a non-zero OCI SHA-256 digest`);
    }
    if (parsed.repository !== component.imageRepository) {
      throw new Error(`image inventory ${id} repository must be ${component.imageRepository}`);
    }
    if (image === draftImageReference(catalog.cell, catalog.catalogVersion, component)) {
      throw new Error(`image inventory ${id} still uses the unpublished draft digest`);
    }
    images.set(id, image);
  }
  for (const id of expectedIds) {
    if (!images.has(id)) throw new Error(`image inventory is missing ${id}`);
  }
  validateRegistryVerification(registryVerification, options, inventoryBytes, images);

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const manifest = generateManifest(catalog, {
    releaseVersion: options.releaseVersion,
    status: "published",
    sourceRevision: options.sourceRevision,
    generatedAt,
    releasedAt: options.releasedAt ?? generatedAt,
    imagesVerified: true,
    images
  });
  assertValid(
    validateManifest(manifest, catalog, { context: "published release manifest", publishable: true }),
    "Published release is not publishable"
  );
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = hash(manifestBytes);
  const imageInventorySha256 = hash(inventoryBytes);
  const registryVerificationSha256 = hash(registryVerificationBytes);
  const npmVerificationSha256 = hash(npmVerificationBytes);
  const imageSetSha256 = hash(
    Buffer.from(
      `${[...images.entries()]
        .map(([id, image]) => `${id}=${image}`)
        .sort()
        .join("\n")}\n`
    )
  );
  const attestation = {
    schemaVersion: 2,
    predicateType: "https://hyperion.example/attestations/federated-release/v2",
    cell: options.cell,
    catalogVersion: options.catalogVersion,
    releaseVersion: options.releaseVersion,
    sourceRevision: options.sourceRevision,
    sourceRepository: options.sourceRepository,
    issuedAt: generatedAt,
    manifestSha256,
    imageInventorySha256,
    registryVerificationSha256,
    npmVerificationSha256,
    imageSetSha256,
    imageCount: images.size,
    packageSetSha256: packageSetSha256(packages),
    packageCount: packages.size
  };
  const attestationBytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`);

  await writeOutput(path.resolve(options.manifestOutput), manifestBytes, options.force);
  try {
    await writeOutput(path.resolve(options.attestationOutput), attestationBytes, options.force);
  } catch (error) {
    throw new Error(`Manifest was prepared but release attestation could not be written: ${error.message}`, {
      cause: error
    });
  }
  return { manifest, attestation };
}

function validateRegistryVerification(evidence, options, inventoryBytes, images) {
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
    evidence.sourceRepository !== options.sourceRepository ||
    evidence.cell !== options.cell ||
    evidence.catalogVersion !== options.catalogVersion ||
    evidence.sourceRevision !== options.sourceRevision ||
    evidence.imageInventorySha256 !== hash(inventoryBytes) ||
    !evidence.images ||
    typeof evidence.images !== "object" ||
    Array.isArray(evidence.images) ||
    !Number.isFinite(Date.parse(evidence.verifiedAt))
  ) {
    throw new Error("registry provenance verification does not match the release input");
  }
  if (JSON.stringify(Object.keys(evidence.images).sort()) !== JSON.stringify([...images.keys()].sort())) {
    throw new Error("registry provenance verification must cover every exact OCI image");
  }
  for (const [id, image] of images) {
    const entry = evidence.images[id];
    exactKeys(
      entry,
      ["image", "sourceRevision", "builderId", "registryInspectionSha256", "verifiedProvenanceSha256"],
      `registry provenance verification ${id}`
    );
    if (
      entry.image !== image ||
      entry.sourceRevision !== options.sourceRevision ||
      typeof entry.builderId !== "string" ||
      !entry.builderId ||
      !SHA256.test(entry.registryInspectionSha256) ||
      !SHA256.test(entry.verifiedProvenanceSha256)
    ) {
      throw new Error(`registry provenance verification ${id} is invalid`);
    }
  }
}

function validateInventoryEnvelope(inventory, options) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("image inventory must be a JSON object");
  }
  const actualKeys = Object.keys(inventory).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify([...INVENTORY_KEYS].sort())) {
    throw new Error(`image inventory must contain exactly: ${INVENTORY_KEYS.join(", ")}`);
  }
  if (inventory.schemaVersion !== 1) throw new Error("image inventory schemaVersion must be 1");
  if (inventory.cell !== options.cell) throw new Error("image inventory cell does not match --cell");
  if (inventory.catalogVersion !== options.catalogVersion) {
    throw new Error("image inventory catalogVersion does not match --catalog-version");
  }
  if (inventory.sourceRevision !== options.sourceRevision) {
    throw new Error("image inventory sourceRevision does not match --source-revision");
  }
  if (!inventory.images || typeof inventory.images !== "object" || Array.isArray(inventory.images)) {
    throw new Error("image inventory images must be an object");
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

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeOutput(filePath, bytes, force = false) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes, { flag: force ? "w" : "wx", mode: 0o600 });
}

function requireOption(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
}

function parseArguments(argv) {
  const options = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--catalog-version") options.catalogVersion = argv[++index];
    else if (argument === "--release-version") options.releaseVersion = argv[++index];
    else if (argument === "--source-revision") options.sourceRevision = argv[++index];
    else if (argument === "--source-repository") options.sourceRepository = argv[++index];
    else if (argument === "--image-inventory") options.imageInventory = argv[++index];
    else if (argument === "--registry-verification") options.registryVerification = argv[++index];
    else if (argument === "--npm-verification") options.npmVerification = argv[++index];
    else if (argument === "--manifest-output") options.manifestOutput = argv[++index];
    else if (argument === "--attestation-output") options.attestationOutput = argv[++index];
    else if (argument === "--generated-at") options.generatedAt = argv[++index];
    else if (argument === "--released-at") options.releasedAt = argv[++index];
    else if (argument === "--force") options.force = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await preparePublishedRelease(options, process.cwd());
  process.stdout.write(`PUBLISHED_RELEASE_MANIFEST_SHA256=${result.attestation.manifestSha256}\n`);
  process.stdout.write(`PUBLISHED_RELEASE_IMAGE_SET_SHA256=${result.attestation.imageSetSha256}\n`);
  process.stdout.write(`PUBLISHED_RELEASE_IMAGE_COUNT=${result.attestation.imageCount}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
