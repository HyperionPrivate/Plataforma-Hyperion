import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertValid, compareSemver, parseOciImageReference, validateCatalog } from "../releases/release-model.mjs";
import { validatePublishedRelease } from "../releases/validate-published-release.mjs";
import {
  ROLLBACK_CELLS,
  loadRollbackPolicy,
  rollbackComponentPartitions,
  verifyProviderMigrationManifest
} from "../releases/rollback-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;
const BUNDLE_EVIDENCE_FILES = Object.freeze([
  "manifest.json",
  "image-inventory.json",
  "registry-verification.json",
  "npm-verification.json",
  "attestation.json"
]);
const OBSERVATION_KEYS = new Set([
  "schemaVersion",
  "cell",
  "rollbackReleaseVersion",
  "currentReleaseVersion",
  "rollbackImages",
  "forwardOnlyImages"
]);

export async function verifyCellRollback(cell, options, root = repositoryRoot) {
  assertRollbackCell(cell);
  requireOption(options.rollbackBundle, "--rollback-bundle");
  requireOption(options.currentBundle, "--current-bundle");
  requireOption(options.observedImages, "--observed-images");
  requireOption(options.confirm, "--confirm");

  const [rollbackRelease, currentRelease] = await Promise.all([
    loadSealedPublishedReleaseBundle(options.rollbackBundle, root, "rollback release bundle", {
      requireCheckoutSourceParity: false
    }),
    loadSealedPublishedReleaseBundle(options.currentBundle, root, "current release bundle", {
      requireCheckoutSourceParity: true
    })
  ]);
  const cellLabel = cell.toUpperCase();
  if (rollbackRelease.manifest.cell !== cell) {
    throw new Error(`rollback release bundle must belong to the ${cell} cell`);
  }
  if (currentRelease.manifest.cell !== cell) {
    throw new Error(`current release bundle must belong to the ${cell} cell`);
  }
  if (compareSemver(currentRelease.manifest.catalogVersion, rollbackRelease.manifest.catalogVersion) < 0) {
    throw new Error("current release catalog cannot predate the rollback release catalog");
  }

  const rollbackPolicy = await loadRollbackPolicy(rollbackRelease.catalog, root);
  const currentPolicy = await loadRollbackPolicy(currentRelease.catalog, root);
  const rollbackPartitions = rollbackComponentPartitions(rollbackPolicy.policy, rollbackRelease.catalog);
  const currentPartitions = rollbackComponentPartitions(currentPolicy.policy, currentRelease.catalog);
  if (
    JSON.stringify(rollbackPartitions.rollbackOciComponents) !== JSON.stringify(currentPartitions.rollbackOciComponents)
  ) {
    throw new Error(
      "current and rollback runtime component partitions differ; a topology-specific rollback is required"
    );
  }
  for (const componentId of rollbackPartitions.forwardOnlyOciComponents) {
    if (!currentPartitions.forwardOnlyOciComponents.includes(componentId)) {
      throw new Error(`current release no longer owns forward-only control-plane component ${componentId}`);
    }
  }

  // Only the current control plane may inspect or mutate the current database. Historical
  // migration/bootstrap images are evidence in the rollback bundle, never deployment targets.
  const migrationEvidence = await verifyProviderMigrationManifest(currentPolicy.policy, root);
  const expectedConfirmation =
    `ROLLBACK ${cellLabel} RUNTIMES ${rollbackRelease.manifest.releaseVersion} ` +
    `MANIFEST SHA256 ${rollbackRelease.manifestSha256} KEEP CONTROL PLANE ` +
    `${currentRelease.manifest.releaseVersion} MANIFEST SHA256 ${currentRelease.manifestSha256}`;
  if (options.confirm !== expectedConfirmation) {
    throw new Error(`--confirm must equal '${expectedConfirmation}'`);
  }

  const observation = parseJson(
    await readRegularFile(path.resolve(options.observedImages), "observed image inventory"),
    "observed image inventory"
  );
  validateObservationEnvelope(observation, cell, rollbackRelease.manifest, currentRelease.manifest);
  const runtimeEvidenceLines = verifyObservedImageSet({
    observed: observation.rollbackImages,
    componentIds: rollbackPartitions.rollbackOciComponents,
    manifest: rollbackRelease.manifest,
    catalog: rollbackRelease.catalog,
    label: "rollback runtime",
    cell
  });
  const forwardOnlyEvidenceLines = verifyObservedImageSet({
    observed: observation.forwardOnlyImages,
    componentIds: currentPartitions.forwardOnlyOciComponents,
    manifest: currentRelease.manifest,
    catalog: currentRelease.catalog,
    label: "current forward-only control-plane",
    cell
  });

  return {
    cell,
    rollbackReleaseVersion: rollbackRelease.manifest.releaseVersion,
    currentReleaseVersion: currentRelease.manifest.releaseVersion,
    rollbackCatalogVersion: rollbackRelease.manifest.catalogVersion,
    currentCatalogVersion: currentRelease.manifest.catalogVersion,
    rollbackSourceRevision: rollbackRelease.manifest.sourceRevision,
    currentSourceRevision: currentRelease.manifest.sourceRevision,
    rollbackManifestSha256: rollbackRelease.manifestSha256,
    currentManifestSha256: currentRelease.manifestSha256,
    rollbackBundleIndexSha256: rollbackRelease.bundleIndexSha256,
    currentBundleIndexSha256: currentRelease.bundleIndexSha256,
    rollbackPolicySha256: rollbackPolicy.sha256,
    currentPolicySha256: currentPolicy.sha256,
    migrationSetSha256: migrationEvidence.sha256,
    migrationCount: migrationEvidence.count,
    runtimeImageSetSha256: hashLines(runtimeEvidenceLines),
    runtimeImageCount: runtimeEvidenceLines.length,
    forwardOnlyImageSetSha256: hashLines(forwardOnlyEvidenceLines),
    forwardOnlyImageCount: forwardOnlyEvidenceLines.length
  };
}

export async function loadSealedPublishedReleaseBundle(
  bundleDirectory,
  root = repositoryRoot,
  label = "release bundle",
  { requireCheckoutSourceParity = true } = {}
) {
  const resolvedDirectory = path.resolve(bundleDirectory);
  const metadata = await lstat(resolvedDirectory).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist`, { cause: error });
    throw error;
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory`);
  }

  const checksumBytes = await readRegularFile(path.join(resolvedDirectory, "SHA256SUMS"), `${label} SHA256SUMS`);
  const checksums = parseChecksumIndex(checksumBytes, label);
  const evidenceBytes = new Map();
  for (const filename of BUNDLE_EVIDENCE_FILES) {
    const bytes = await readRegularFile(path.join(resolvedDirectory, filename), `${label} ${filename}`);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== checksums.get(filename)) throw new Error(`${label} SHA256SUMS does not seal ${filename}`);
    evidenceBytes.set(filename, bytes);
  }

  const manifest = parseJson(evidenceBytes.get("manifest.json"), `${label} manifest`);
  const attestation = parseJson(evidenceBytes.get("attestation.json"), `${label} attestation`);
  if (typeof attestation.sourceRevision !== "string" || typeof attestation.sourceRepository !== "string") {
    throw new Error(`${label} attestation has no source identity`);
  }
  const validation = await validatePublishedRelease(
    {
      manifest: path.join(resolvedDirectory, "manifest.json"),
      imageInventory: path.join(resolvedDirectory, "image-inventory.json"),
      registryVerification: path.join(resolvedDirectory, "registry-verification.json"),
      npmVerification: path.join(resolvedDirectory, "npm-verification.json"),
      attestation: path.join(resolvedDirectory, "attestation.json"),
      sourceRevision: attestation.sourceRevision,
      sourceRepository: attestation.sourceRepository,
      requireCheckoutSourceParity,
      publishable: true
    },
    root
  );
  const manifestSha256 = createHash("sha256").update(evidenceBytes.get("manifest.json")).digest("hex");
  if (validation.manifestSha256 !== manifestSha256) {
    throw new Error(`${label} validated manifest digest differs from its sealed bytes`);
  }

  const catalogPath = path.join(root, "releases", "catalogs", manifest.cell, `${manifest.catalogVersion}.json`);
  const catalog = parseJson(await readRegularFile(catalogPath, `${label} release catalog`), `${label} release catalog`);
  assertValid(validateCatalog(catalog, { context: `${label} release catalog` }), `${label} release catalog is invalid`);
  return {
    manifest,
    catalog,
    manifestSha256,
    bundleIndexSha256: createHash("sha256").update(checksumBytes).digest("hex")
  };
}

export function parseRollbackArguments(argv) {
  const options = {};
  const optionNames = new Map([
    ["--rollback-bundle", "rollbackBundle"],
    ["--current-bundle", "currentBundle"],
    ["--observed-images", "observedImages"],
    ["--confirm", "confirm"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = optionNames.get(argument);
    if (!name) throw new Error(`Unknown argument: ${argument}`);
    if (options[name] !== undefined) throw new Error(`Duplicate argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[name] = value;
  }
  return options;
}

export function formatRollbackEvidence(evidence) {
  const prefix = evidence.cell.toUpperCase();
  return [
    `${prefix}_ROLLBACK_RUNTIME_RELEASE_VERSION=${evidence.rollbackReleaseVersion}`,
    `${prefix}_ROLLBACK_CURRENT_RELEASE_VERSION=${evidence.currentReleaseVersion}`,
    `${prefix}_ROLLBACK_RUNTIME_CATALOG_VERSION=${evidence.rollbackCatalogVersion}`,
    `${prefix}_ROLLBACK_CURRENT_CATALOG_VERSION=${evidence.currentCatalogVersion}`,
    `${prefix}_ROLLBACK_RUNTIME_SOURCE_REVISION=${evidence.rollbackSourceRevision}`,
    `${prefix}_ROLLBACK_CURRENT_SOURCE_REVISION=${evidence.currentSourceRevision}`,
    `${prefix}_ROLLBACK_RUNTIME_MANIFEST_SHA256=${evidence.rollbackManifestSha256}`,
    `${prefix}_ROLLBACK_CURRENT_MANIFEST_SHA256=${evidence.currentManifestSha256}`,
    `${prefix}_ROLLBACK_RUNTIME_BUNDLE_INDEX_SHA256=${evidence.rollbackBundleIndexSha256}`,
    `${prefix}_ROLLBACK_CURRENT_BUNDLE_INDEX_SHA256=${evidence.currentBundleIndexSha256}`,
    `${prefix}_ROLLBACK_RUNTIME_POLICY_SHA256=${evidence.rollbackPolicySha256}`,
    `${prefix}_ROLLBACK_CURRENT_POLICY_SHA256=${evidence.currentPolicySha256}`,
    `${prefix}_ROLLBACK_CURRENT_MIGRATION_SET_SHA256=${evidence.migrationSetSha256}`,
    `${prefix}_ROLLBACK_CURRENT_MIGRATION_COUNT=${evidence.migrationCount}`,
    `${prefix}_ROLLBACK_RUNTIME_IMAGE_SET_SHA256=${evidence.runtimeImageSetSha256}`,
    `${prefix}_ROLLBACK_RUNTIME_IMAGE_COUNT=${evidence.runtimeImageCount}`,
    `${prefix}_ROLLBACK_FORWARD_ONLY_IMAGE_SET_SHA256=${evidence.forwardOnlyImageSetSha256}`,
    `${prefix}_ROLLBACK_FORWARD_ONLY_IMAGE_COUNT=${evidence.forwardOnlyImageCount}`
  ].join("\n");
}

function parseChecksumIndex(bytes, label) {
  const lines = bytes.toString("utf8").trimEnd().split(/\r?\n/);
  if (lines.length !== BUNDLE_EVIDENCE_FILES.length) {
    throw new Error(`${label} SHA256SUMS must contain every evidence file exactly once`);
  }
  const checksums = new Map();
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^([a-f0-9]{64}) {2}([A-Za-z0-9.-]+)$/);
    const expectedFilename = BUNDLE_EVIDENCE_FILES[index];
    if (!match || !SHA256.test(match[1]) || match[2] !== expectedFilename || checksums.has(match[2])) {
      throw new Error(`${label} SHA256SUMS contains an invalid, duplicate, reordered or unexpected entry`);
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

function validateObservationEnvelope(observation, cell, rollbackManifest, currentManifest) {
  if (!isRecord(observation)) throw new Error("observed image inventory must be a JSON object");
  for (const key of Object.keys(observation)) {
    if (!OBSERVATION_KEYS.has(key)) throw new Error(`observed image inventory contains unsupported property ${key}`);
  }
  if (observation.schemaVersion !== 2) throw new Error("observed image inventory schemaVersion must be 2");
  if (observation.cell !== cell) throw new Error(`observed image inventory cell must be ${cell}`);
  if (observation.rollbackReleaseVersion !== rollbackManifest.releaseVersion) {
    throw new Error(`observed image inventory rollbackReleaseVersion must be ${rollbackManifest.releaseVersion}`);
  }
  if (observation.currentReleaseVersion !== currentManifest.releaseVersion) {
    throw new Error(`observed image inventory currentReleaseVersion must be ${currentManifest.releaseVersion}`);
  }
  if (!isRecord(observation.rollbackImages)) {
    throw new Error("observed image inventory rollbackImages must be a JSON object");
  }
  if (!isRecord(observation.forwardOnlyImages)) {
    throw new Error("observed image inventory forwardOnlyImages must be a JSON object");
  }
}

function verifyObservedImageSet({ observed, componentIds, manifest, catalog, label, cell }) {
  const expectedIds = new Set(componentIds);
  for (const id of Object.keys(observed)) {
    if (!expectedIds.has(id))
      throw new Error(`observed ${label} image inventory contains non-allowlisted component ${id}`);
  }
  const manifestById = new Map(manifest.components.map((component) => [component.id, component]));
  const catalogById = new Map(catalog.components.map((component) => [component.id, component]));
  const lines = [];
  for (const id of componentIds) {
    const expectedImage = manifestById.get(id)?.image;
    const catalogComponent = catalogById.get(id);
    const observedImage = observed[id];
    if (typeof observedImage !== "string") throw new Error(`observed ${label} image inventory is missing ${id}`);
    const parsedObserved = parseOciImageReference(observedImage);
    if (!parsedObserved) throw new Error(`observed ${label} image for ${id} is not pinned by an OCI SHA-256 digest`);
    if (parsedObserved.repository !== catalogComponent?.imageRepository) {
      throw new Error(`observed ${label} image repository for ${id} is not owned by the ${cell} catalog`);
    }
    if (observedImage !== expectedImage) {
      throw new Error(`observed ${label} image digest for ${id} does not match its sealed release manifest`);
    }
    lines.push(`${id}=${observedImage}`);
  }
  if (Object.keys(observed).length !== componentIds.length) {
    throw new Error(`observed ${label} image inventory must contain exactly ${componentIds.length} components`);
  }
  return lines;
}

async function readRegularFile(filePath, label) {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist`, { cause: error });
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size === 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file`);
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

function hashLines(lines) {
  return createHash("sha256")
    .update(`${[...lines].sort().join("\n")}\n`)
    .digest("hex");
}

function requireOption(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
}

function assertRollbackCell(cell) {
  if (!ROLLBACK_CELLS.includes(cell)) throw new Error(`rollback cell must be one of ${ROLLBACK_CELLS.join(", ")}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function runRollbackCli(cell, argv = process.argv.slice(2)) {
  const evidence = await verifyCellRollback(cell, parseRollbackArguments(argv));
  process.stdout.write(`${formatRollbackEvidence(evidence)}\n`);
}
