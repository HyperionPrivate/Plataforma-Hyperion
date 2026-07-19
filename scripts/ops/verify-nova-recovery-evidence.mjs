#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "../..");
const expectedBackupSteps = [
  "documents-writes-frozen",
  "postgres-exported",
  "documents-exported",
  "documents-writes-unfrozen"
];
const expectedRestoreSteps = [
  "documents-writes-frozen",
  "documents-restored-and-inventory-verified",
  "postgres-restored",
  "nova-smoke-passed",
  "documents-writes-unfrozen"
];

function fail(message) {
  process.stderr.write(`NOVA recovery evidence verification failed: ${message}\n`);
  process.exit(1);
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`invalid argument near ${name}`);
    }
    options[name.slice(2)] = value;
    index += 1;
  }
  if (!options.evidence) fail("--evidence is required");
  return options;
}

function regularFile(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    fail(`${label} must be a non-empty regular file without symbolic links`);
  }
  return metadata;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function inside(parent, candidate, label) {
  const pathFromParent = relative(parent, candidate);
  if (
    !pathFromParent ||
    pathFromParent === ".." ||
    pathFromParent.startsWith(`..${sep}`) ||
    isAbsolute(pathFromParent)
  ) {
    fail(`${label} is outside its permitted directory`);
  }
}

function resolveEvidencePath(repositoryRoot, relativePath, permittedRoot, label) {
  if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath) || relativePath.includes("\\")) {
    fail(`${label} must be a portable repository-relative path`);
  }
  const candidate = resolve(repositoryRoot, relativePath);
  inside(permittedRoot, candidate, label);
  regularFile(candidate, label);
  const canonical = realpathSync(candidate);
  inside(permittedRoot, canonical, label);
  return canonical;
}

function validateSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value) || /^0{64}$/.test(value)) {
    fail(`${label} must be a non-zero lowercase SHA-256`);
  }
}

function validateSteps(steps, expectedNames, repositoryRoot, drillRoot, label) {
  if (!Array.isArray(steps) || steps.length !== expectedNames.length) {
    fail(`${label} must contain exactly ${expectedNames.length} ordered steps`);
  }
  let previousTimestamp = -1;
  const receiptPaths = new Set();
  for (const [index, step] of steps.entries()) {
    exactObject(step, ["name", "completedAt", "receipt", "sha256"], `${label}[${index}]`);
    if (step.name !== expectedNames[index]) {
      fail(`${label}[${index}] must be ${expectedNames[index]}`);
    }
    const timestamp = Date.parse(step.completedAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(step.completedAt) || !Number.isFinite(timestamp)) {
      fail(`${label}[${index}].completedAt must be a canonical UTC timestamp`);
    }
    if (timestamp <= previousTimestamp) fail(`${label} timestamps must be strictly increasing`);
    previousTimestamp = timestamp;
    validateSha(step.sha256, `${label}[${index}].sha256`);
    const receiptPath = resolveEvidencePath(repositoryRoot, step.receipt, drillRoot, `${label}[${index}].receipt`);
    if (receiptPaths.has(receiptPath)) fail(`${label} receipt files must be unique`);
    receiptPaths.add(receiptPath);
    if (sha256(receiptPath) !== step.sha256) fail(`${label}[${index}] receipt SHA-256 differs from evidence`);
  }
  return {
    startedAt: steps[0].completedAt,
    completedAt: steps.at(-1).completedAt,
    durationSeconds: (Date.parse(steps.at(-1).completedAt) - Date.parse(steps[0].completedAt)) / 1000
  };
}

function validateInventory(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) fail("Documents inventory contains no objects");
  let previousKey = "";
  let totalBytes = 0;
  for (const [index, line] of lines.entries()) {
    const fields = line.split("\t");
    if (fields.length !== 3) fail(`Documents inventory line ${index + 1} does not have three columns`);
    const [digest, sizeText, key] = fields;
    validateSha(digest, `Documents inventory line ${index + 1} digest`);
    if (!/^\d{1,16}$/.test(sizeText)) fail(`Documents inventory line ${index + 1} size is invalid`);
    if (!key || /\s/.test(key)) fail(`Documents inventory line ${index + 1} key is not percent-encoded`);
    if (previousKey && key <= previousKey) fail("Documents inventory keys are not strictly sorted and unique");
    previousKey = key;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) fail(`Documents inventory line ${index + 1} size is unsafe`);
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes)) fail("Documents inventory total bytes exceed the safe integer range");
  }
  return { objectCount: lines.length, totalBytes };
}

const options = parseArguments(process.argv.slice(2));
const testMode = process.env.NOVA_OPS_TEST_MODE === "1";
let repositoryRoot = defaultRepositoryRoot;
if (testMode) {
  const testRoot = process.env.NOVA_OPS_TEST_ROOT;
  if (!testRoot || !basename(testRoot).startsWith("hyperion-recovery-test.")) {
    fail("NOVA_OPS_TEST_ROOT must be an isolated hyperion-recovery-test directory in test mode");
  }
  repositoryRoot = realpathSync(testRoot);
}
const backupRoot = resolve(repositoryRoot, "backups/nova");
const evidencePath = resolveEvidencePath(repositoryRoot, options.evidence, backupRoot, "evidence file");
let evidence;
try {
  evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
} catch (error) {
  fail(`evidence is not valid JSON: ${error.message}`);
}

exactObject(
  evidence,
  ["schemaVersion", "cell", "operationId", "consistencyMode", "database", "documents", "backupSteps", "restoreSteps"],
  "evidence"
);
if (evidence.schemaVersion !== 1 || evidence.cell !== "nova") fail("evidence must be schemaVersion 1 for cell nova");
if (!/^\d{8}T\d{6}Z$/.test(evidence.operationId)) fail("operationId must be a compact UTC timestamp");
if (evidence.consistencyMode !== "documents-write-quiesce") {
  fail("consistencyMode must prove that Documents writes were quiesced");
}

exactObject(evidence.database, ["sourceDatabase", "restoreDatabase", "owner", "archive", "sha256"], "database");
if (!/^hyperion_nova(?:_[a-z0-9_]+)?$/.test(evidence.database.sourceDatabase)) {
  fail("database.sourceDatabase is outside the NOVA logical database namespace");
}
if (!/^hyperion_nova(?:_[a-z0-9_]+)?$/.test(evidence.database.restoreDatabase)) {
  fail("database.restoreDatabase is outside the NOVA logical database namespace");
}
if (evidence.database.owner !== "hyperion_nova_migrator") fail("database.owner must be hyperion_nova_migrator");
validateSha(evidence.database.sha256, "database.sha256");
const databaseArchive = resolveEvidencePath(repositoryRoot, evidence.database.archive, backupRoot, "database archive");
if (basename(databaseArchive) !== `nova-${evidence.operationId}.dump.gz`) {
  fail("database archive timestamp must match operationId");
}
const gzipHeader = readFileSync(databaseArchive).subarray(0, 2).toString("hex");
if (gzipHeader !== "1f8b") fail("database archive is not gzip data");
if (sha256(databaseArchive) !== evidence.database.sha256) fail("database archive SHA-256 differs from evidence");

exactObject(
  evidence.documents,
  ["bucket", "snapshotDirectory", "snapshotSha256", "inventorySha256", "bundleSha256", "objectCount", "totalBytes"],
  "documents"
);
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(evidence.documents.bucket)) {
  fail("documents.bucket is invalid");
}
for (const [name, value] of [
  ["documents.snapshotSha256", evidence.documents.snapshotSha256],
  ["documents.inventorySha256", evidence.documents.inventorySha256],
  ["documents.bundleSha256", evidence.documents.bundleSha256]
]) {
  validateSha(value, name);
}
if (
  typeof evidence.documents.snapshotDirectory !== "string" ||
  isAbsolute(evidence.documents.snapshotDirectory) ||
  evidence.documents.snapshotDirectory.includes("\\")
) {
  fail("documents.snapshotDirectory must be a portable repository-relative path");
}
const snapshotDirectory = resolve(repositoryRoot, evidence.documents.snapshotDirectory);
inside(resolve(backupRoot, "documents"), snapshotDirectory, "Documents snapshot directory");
if (basename(snapshotDirectory) !== `nova-documents-${evidence.operationId}`) {
  fail("Documents snapshot timestamp must match operationId");
}
const snapshotRef = resolveEvidencePath(
  repositoryRoot,
  `${evidence.documents.snapshotDirectory}/snapshot.ref`,
  snapshotDirectory,
  "snapshot reference"
);
const inventory = resolveEvidencePath(
  repositoryRoot,
  `${evidence.documents.snapshotDirectory}/inventory.tsv`,
  snapshotDirectory,
  "Documents inventory"
);
const bucketFile = resolveEvidencePath(
  repositoryRoot,
  `${evidence.documents.snapshotDirectory}/bucket`,
  snapshotDirectory,
  "Documents bucket marker"
);
const bundleFile = resolveEvidencePath(
  repositoryRoot,
  `${evidence.documents.snapshotDirectory}/bundle.sha256`,
  snapshotDirectory,
  "Documents bundle marker"
);
if (readFileSync(bucketFile, "utf8").trim() !== evidence.documents.bucket)
  fail("Documents bucket marker differs from evidence");
const actualSnapshotSha = sha256(snapshotRef);
const actualInventorySha = sha256(inventory);
if (actualSnapshotSha !== evidence.documents.snapshotSha256) fail("snapshot reference SHA-256 differs from evidence");
if (actualInventorySha !== evidence.documents.inventorySha256)
  fail("Documents inventory SHA-256 differs from evidence");
const inventoryTotals = validateInventory(inventory);
if (
  inventoryTotals.objectCount !== evidence.documents.objectCount ||
  inventoryTotals.totalBytes !== evidence.documents.totalBytes
) {
  fail("Documents inventory totals differ from evidence");
}
const actualBundleSha = createHash("sha256")
  .update(
    `${evidence.documents.bucket}\n${actualSnapshotSha}\n${actualInventorySha}\n${inventoryTotals.objectCount}\n${inventoryTotals.totalBytes}\n`
  )
  .digest("hex");
if (
  actualBundleSha !== evidence.documents.bundleSha256 ||
  readFileSync(bundleFile, "utf8").trim() !== actualBundleSha
) {
  fail("Documents bundle SHA-256 differs from evidence");
}

const expectedDrillRoot = resolve(backupRoot, "drills", evidence.operationId);
inside(expectedDrillRoot, evidencePath, "evidence file");
const backupTiming = validateSteps(
  evidence.backupSteps,
  expectedBackupSteps,
  repositoryRoot,
  expectedDrillRoot,
  "backupSteps"
);
const restoreTiming = validateSteps(
  evidence.restoreSteps,
  expectedRestoreSteps,
  repositoryRoot,
  expectedDrillRoot,
  "restoreSteps"
);
if (Date.parse(restoreTiming.startedAt) <= Date.parse(backupTiming.completedAt)) {
  fail("restore drill must start after the coordinated backup completed");
}

process.stdout.write(`NOVA_RECOVERY_OPERATION_ID=${evidence.operationId}\n`);
process.stdout.write(`NOVA_RECOVERY_EVIDENCE_SHA256=${sha256(evidencePath)}\n`);
process.stdout.write(`NOVA_RECOVERY_DATABASE_SHA256=${evidence.database.sha256}\n`);
process.stdout.write(`NOVA_RECOVERY_DOCUMENTS_BUNDLE_SHA256=${actualBundleSha}\n`);
process.stdout.write(`NOVA_RECOVERY_OBJECT_COUNT=${inventoryTotals.objectCount}\n`);
process.stdout.write(`NOVA_RECOVERY_BACKUP_DURATION_SECONDS=${backupTiming.durationSeconds}\n`);
process.stdout.write(`NOVA_RECOVERY_RESTORE_DURATION_SECONDS=${restoreTiming.durationSeconds}\n`);
process.stdout.write("NOVA_RECOVERY_ORDER_VERIFIED=true\n");
