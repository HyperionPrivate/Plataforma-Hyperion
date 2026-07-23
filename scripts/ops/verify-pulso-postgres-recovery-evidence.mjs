#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const EXPECTED_MIGRATIONS = [
  "001-pulso-autonomous-baseline.sql",
  "002-pulso-runtime-roles.sql",
  "003-sofia-readiness-marker.sql",
  "004-access-channel-tenant-projection.sql",
  "005-access-iris-tenant-projection.sql",
  "006-access-sofia-tenant-projection.sql",
  "007-access-integration-tenant-projection.sql",
  "008-access-knowledge-tenant-projection.sql",
  "009-contract-channel-access-tenant-fks.sql",
  "010-contract-integration-access-tenant-fks.sql",
  "011-contract-sofia-access-tenant-fks.sql",
  "012-contract-iris-access-tenant-fks.sql",
  "013-contract-knowledge-access-tenant-fks.sql",
  "014-drop-n-minus-one-legacy-adapters.sql",
  "015-revoke-sofia-pulso-iris-control-plane-grants.sql",
  "016-attest-access-fk-contract.sql"
];

const EXPECTED_GLOBAL_MARKER = "16\t016-attest-access-fk-contract.sql";
const EXPECTED_SOFIA_MARKER = "2\t006-access-sofia-tenant-projection.sql";
const EXPECTED_RUNTIME_ROLES = 5;
const RUNTIME_ROLES = [
  "hyperion_pulso",
  "hyperion_sofia",
  "hyperion_knowledge",
  "hyperion_integration",
  "hyperion_channel"
];
const EXPECTED_OWNER_STATE = "4\t0\t0";
const EXPECTED_USER_SCHEMA_STATE =
  "agent_runtime\nchannel_runtime\nintegration_runtime\nknowledge_runtime\nplatform\npulso_iris";
const EXPECTED_ACL_STATE = ["f", "f", "f", "t", "t", "t", ...RUNTIME_ROLES.flatMap(() => ["t", "f", "f"]), "f"].join(
  "\t"
);
const EXPECTED_COMMAND_SOURCES = [
  "infra/docker-compose.pulso.yml",
  "scripts/ops/postgres-backup.sh",
  "scripts/ops/postgres-restore.sh",
  "scripts/ops/pulso-postgres-backup.sh",
  "scripts/ops/pulso-postgres-restore.sh",
  "scripts/ops/run-pulso-postgres-recovery-drill.mjs"
];
const ARTIFACT_LAYOUT = {
  archive: "postgres-backup.dump.gz",
  schema: "schema.sql",
  ledger: "migration-ledger.tsv",
  catalog: "catalog-evidence.json",
  sourceClosure: "source",
  commandSources: "command-sources",
  logs: {
    backup: "logs/backup.log",
    restore: "logs/restore.log",
    migrationValidation: "logs/migration-validation.log",
    roleValidation: "logs/role-validation.log"
  }
};
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PROJECT_PATTERN = /^hyperion-pulso-recovery-acceptance(?:-[a-z0-9][a-z0-9-]{0,29})?$/;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "cell",
  "scope",
  "operationId",
  "project",
  "dockerContext",
  "dockerEndpointSha256",
  "source",
  "sourceDatabase",
  "sourceDatabaseRemovedBeforeValidation",
  "restoreDatabase",
  "restoreOwner",
  "backupSha256",
  "schemaSha256",
  "ledgerSha256",
  "aclSha256",
  "globalReadinessMarkerSha256",
  "sofiaReadinessMarkerSha256",
  "catalogEvidenceSha256",
  "migrationCount",
  "schemaVersionValue",
  "sofiaSchemaVersionValue",
  "recoveryCanarySha256",
  "sourceRecoveryCanarySha256",
  "restoredRecoveryCanarySha256",
  "recoveryCanaryPreserved",
  "runtimeRolesVerified",
  "migrationsSkippedOnValidation",
  "roleBootstrapCount",
  "publicDatabasePrivilegesRevoked",
  "whatsappSessionsIncluded",
  "schemaVerifier",
  "rawReceipts",
  "logSha256",
  "dockerInventory",
  "cleanupVerified",
  "artifactBundle"
];

function reject(message) {
  throw new Error(message);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateSha(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value) || /^0{64}$/.test(value)) {
    reject(`${label} must be a non-zero lowercase SHA-256`);
  }
}

function validateRevision(value) {
  if (typeof value !== "string" || !REVISION_PATTERN.test(value) || /^0+$/.test(value)) {
    reject("source.revision must be a non-zero lowercase Git object ID");
  }
}

function validateCompactUtc(value) {
  if (typeof value !== "string" || !/^\d{8}T\d{6}Z$/.test(value)) {
    reject("operationId must be a compact UTC timestamp");
  }
  const canonical = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  const timestamp = new Date(canonical);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== canonical) {
    reject("operationId must identify a real UTC instant");
  }
}

function validateSafeInteger(value, expected, label) {
  if (!Number.isSafeInteger(value) || value !== expected) reject(`${label} must equal ${expected}`);
}

function validatePositiveDecimal(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) reject(`${label} must be a positive decimal string`);
}

function validateNonEmptyLine(value, label, maximum = 255) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\r\n\0]/.test(value)) {
    reject(`${label} must be a non-empty single-line string`);
  }
}

function sameArray(actual, expected, label) {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    reject(`${label} must contain the exact ordered PULSO migrations 001-016`);
  }
}

function validateSource(source) {
  exactObject(
    source,
    [
      "branch",
      "revision",
      "workingTreeIncluded",
      "workingTreeStatusSha256",
      "workingTreePatchSha256",
      "closure",
      "migrationSqlClosure",
      "commandSourcesSha256"
    ],
    "source"
  );
  if (
    typeof source.branch !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(source.branch) ||
    source.branch.includes("..") ||
    source.branch.includes("//")
  ) {
    reject("source.branch is invalid");
  }
  validateRevision(source.revision);
  if (source.workingTreeIncluded !== true) reject("source.workingTreeIncluded must be true");
  validateSha(source.workingTreeStatusSha256, "source.workingTreeStatusSha256");
  validateSha(source.workingTreePatchSha256, "source.workingTreePatchSha256");
  validateSha(source.commandSourcesSha256, "source.commandSourcesSha256");

  exactObject(source.closure, ["files", "sha256"], "source.closure");
  if (!Number.isSafeInteger(source.closure.files) || source.closure.files < EXPECTED_MIGRATIONS.length) {
    reject(`source.closure.files must be at least ${EXPECTED_MIGRATIONS.length}`);
  }
  validateSha(source.closure.sha256, "source.closure.sha256");

  exactObject(source.migrationSqlClosure, ["files", "sha256"], "source.migrationSqlClosure");
  validateSafeInteger(source.migrationSqlClosure.files, EXPECTED_MIGRATIONS.length, "source.migrationSqlClosure.files");
  validateSha(source.migrationSqlClosure.sha256, "source.migrationSqlClosure.sha256");
}

function validateSchemaVerifier(schemaVerifier) {
  exactObject(schemaVerifier, ["name", "verified", "expectedGlobalMarker", "expectedSofiaMarker"], "schemaVerifier");
  if (schemaVerifier.name !== "assertPulsoCatalogEvidence" || schemaVerifier.verified !== true) {
    reject("schemaVerifier must attest assertPulsoCatalogEvidence");
  }
  if (schemaVerifier.expectedGlobalMarker !== EXPECTED_GLOBAL_MARKER) {
    reject(`schemaVerifier.expectedGlobalMarker must equal ${JSON.stringify(EXPECTED_GLOBAL_MARKER)}`);
  }
  if (schemaVerifier.expectedSofiaMarker !== EXPECTED_SOFIA_MARKER) {
    reject(`schemaVerifier.expectedSofiaMarker must equal ${JSON.stringify(EXPECTED_SOFIA_MARKER)}`);
  }
}

function validateRawReceipts(rawReceipts, evidence) {
  exactObject(rawReceipts, ["backup", "restore", "migrationValidation", "roleValidation"], "rawReceipts");
  exactObject(
    rawReceipts.backup,
    [
      "BACKUP_CATALOG_ENTRIES",
      "BACKUP_DATABASE",
      "BACKUP_DIRECTORY_MODE",
      "BACKUP_DIRECTORY_OWNER",
      "BACKUP_FILE",
      "BACKUP_FILE_MODE",
      "BACKUP_FILE_OWNER",
      "BACKUP_PROFILE",
      "BACKUP_SHA256",
      "BACKUP_SIZE_BYTES"
    ],
    "rawReceipts.backup"
  );
  const expectedArchive = `pulso-${evidence.operationId}.dump.gz`;
  if (
    rawReceipts.backup.BACKUP_PROFILE !== "pulso" ||
    rawReceipts.backup.BACKUP_DATABASE !== "hyperion_pulso" ||
    rawReceipts.backup.BACKUP_FILE !== expectedArchive ||
    rawReceipts.backup.BACKUP_SHA256 !== evidence.backupSha256
  ) {
    reject("rawReceipts.backup does not match the exact PULSO operation and backup digest");
  }
  if (rawReceipts.backup.BACKUP_DIRECTORY_MODE !== "700" || rawReceipts.backup.BACKUP_FILE_MODE !== "600") {
    reject("rawReceipts.backup must prove directory mode 700 and archive mode 600");
  }
  validatePositiveDecimal(rawReceipts.backup.BACKUP_CATALOG_ENTRIES, "rawReceipts.backup.BACKUP_CATALOG_ENTRIES");
  validatePositiveDecimal(rawReceipts.backup.BACKUP_SIZE_BYTES, "rawReceipts.backup.BACKUP_SIZE_BYTES");
  validateNonEmptyLine(rawReceipts.backup.BACKUP_DIRECTORY_OWNER, "rawReceipts.backup.BACKUP_DIRECTORY_OWNER");
  validateNonEmptyLine(rawReceipts.backup.BACKUP_FILE_OWNER, "rawReceipts.backup.BACKUP_FILE_OWNER");

  exactObject(
    rawReceipts.restore,
    [
      "RESTORE_CATALOG_ENTRIES",
      "RESTORE_DATABASE",
      "RESTORE_FILE",
      "RESTORE_OWNER",
      "RESTORE_PROFILE",
      "RESTORE_SHA256"
    ],
    "rawReceipts.restore"
  );
  if (
    rawReceipts.restore.RESTORE_PROFILE !== "pulso" ||
    rawReceipts.restore.RESTORE_DATABASE !== "hyperion_pulso_restore_drill" ||
    rawReceipts.restore.RESTORE_OWNER !== "hyperion_pulso_migrator" ||
    rawReceipts.restore.RESTORE_FILE !== expectedArchive ||
    rawReceipts.restore.RESTORE_SHA256 !== evidence.backupSha256
  ) {
    reject("rawReceipts.restore does not match the exact isolated PULSO restore and backup digest");
  }
  validatePositiveDecimal(rawReceipts.restore.RESTORE_CATALOG_ENTRIES, "rawReceipts.restore.RESTORE_CATALOG_ENTRIES");
  if (rawReceipts.restore.RESTORE_CATALOG_ENTRIES !== rawReceipts.backup.BACKUP_CATALOG_ENTRIES) {
    reject("backup and restore catalog entry counts differ");
  }

  exactObject(
    rawReceipts.migrationValidation,
    ["event", "applied", "adopted", "skipped"],
    "rawReceipts.migrationValidation"
  );
  if (rawReceipts.migrationValidation.event !== "pulso_migrations_complete") {
    reject("rawReceipts.migrationValidation.event must be pulso_migrations_complete");
  }
  if (
    !Array.isArray(rawReceipts.migrationValidation.applied) ||
    rawReceipts.migrationValidation.applied.length !== 0 ||
    !Array.isArray(rawReceipts.migrationValidation.adopted) ||
    rawReceipts.migrationValidation.adopted.length !== 0
  ) {
    reject("restored migration validation must not apply or adopt migrations");
  }
  sameArray(rawReceipts.migrationValidation.skipped, EXPECTED_MIGRATIONS, "rawReceipts.migrationValidation.skipped");

  exactObject(rawReceipts.roleValidation, ["event", "roleCount"], "rawReceipts.roleValidation");
  if (rawReceipts.roleValidation.event !== "pulso_database_roles_ready") {
    reject("rawReceipts.roleValidation.event must be pulso_database_roles_ready");
  }
  validateSafeInteger(
    rawReceipts.roleValidation.roleCount,
    EXPECTED_RUNTIME_ROLES,
    "rawReceipts.roleValidation.roleCount"
  );
}

function validateLogHashes(logSha256) {
  exactObject(logSha256, ["backup", "restore", "migrationValidation", "roleValidation"], "logSha256");
  for (const [name, value] of Object.entries(logSha256)) validateSha(value, `logSha256.${name}`);
}

function validateInventoryEntries(entries, label) {
  if (!Array.isArray(entries)) reject(`${label} must be an array`);
  const names = new Set();
  const identifiers = new Set();
  let previousName = "";
  for (const [index, entry] of entries.entries()) {
    exactObject(entry, ["id", "name", "image"], `${label}[${index}]`);
    if (typeof entry.id !== "string" || !/^[a-f0-9]{12,64}$/.test(entry.id) || /^0+$/.test(entry.id)) {
      reject(`${label}[${index}].id must be a non-zero lowercase Docker object ID`);
    }
    validateNonEmptyLine(entry.name, `${label}[${index}].name`);
    validateNonEmptyLine(entry.image, `${label}[${index}].image`, 2048);
    if (names.has(entry.name) || identifiers.has(entry.id)) reject(`${label} entries must have unique names and IDs`);
    if (previousName && entry.name.localeCompare(previousName) < 0) reject(`${label} must be sorted by container name`);
    names.add(entry.name);
    identifiers.add(entry.id);
    previousName = entry.name;
  }
}

function validateDockerInventory(dockerInventory, project) {
  exactObject(
    dockerInventory,
    ["before", "after", "beforeSha256", "afterSha256", "preexistingResourcesPreserved"],
    "dockerInventory"
  );
  validateInventoryEntries(dockerInventory.before, "dockerInventory.before");
  validateInventoryEntries(dockerInventory.after, "dockerInventory.after");
  validateSha(dockerInventory.beforeSha256, "dockerInventory.beforeSha256");
  validateSha(dockerInventory.afterSha256, "dockerInventory.afterSha256");
  if (dockerInventory.beforeSha256 !== sha256(`${JSON.stringify(dockerInventory.before)}\n`)) {
    reject("dockerInventory.beforeSha256 differs from the embedded inventory");
  }
  if (dockerInventory.afterSha256 !== sha256(`${JSON.stringify(dockerInventory.after)}\n`)) {
    reject("dockerInventory.afterSha256 differs from the embedded inventory");
  }
  if (dockerInventory.preexistingResourcesPreserved !== true) {
    reject("dockerInventory.preexistingResourcesPreserved must be true");
  }
  const afterByName = new Map(dockerInventory.after.map((entry) => [entry.name, entry]));
  for (const expected of dockerInventory.before) {
    const observed = afterByName.get(expected.name);
    if (!observed || observed.id !== expected.id || observed.image !== expected.image) {
      reject(`preexisting Docker resource changed during recovery: ${expected.name}`);
    }
  }
  const leaked = dockerInventory.after.find(
    (entry) => entry.name === project || entry.name.startsWith(`${project}-`) || entry.name.startsWith(`${project}_`)
  );
  if (leaked) reject(`isolated recovery project resource remains after cleanup: ${leaked.name}`);
}

function expectedRuntimeState(role) {
  const canReadGlobalMarker = role !== "hyperion_sofia";
  const canReadSofiaMarker = role === "hyperion_sofia";
  const globalMarker = canReadGlobalMarker
    ? EXPECTED_GLOBAL_MARKER
    : "15\t015-revoke-sofia-pulso-iris-control-plane-grants.sql";
  return `${role}\thyperion_pulso_restore_drill\t${globalMarker}\t${canReadGlobalMarker}\t${canReadSofiaMarker}\ttrue\ttrue\tfalse\tfalse\tfalse`;
}

function inside(parent, candidate, label) {
  const fromParent = path.relative(parent, candidate);
  if (!fromParent || fromParent === ".." || fromParent.startsWith(`..${path.sep}`) || path.isAbsolute(fromParent)) {
    reject(`${label} is outside its artifact bundle`);
  }
}

function resolveArtifact(bundleRoot, relativePath, label, kind = "file") {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    reject(`${label} must be a portable bundle-relative path`);
  }
  const candidate = path.resolve(bundleRoot, relativePath);
  inside(bundleRoot, candidate, label);
  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch {
    reject(`${label} is missing from the artifact bundle`);
  }
  if (metadata.isSymbolicLink() || (kind === "file" ? !metadata.isFile() : !metadata.isDirectory())) {
    reject(`${label} must be a real ${kind} without symbolic links`);
  }
  const canonical = realpathSync(candidate);
  inside(bundleRoot, canonical, label);
  return canonical;
}

function hashDirectoryClosure(root, label) {
  const rows = [];
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        const relativePath = path.relative(root, absolute).replaceAll("\\", "/");
        paths.push(relativePath);
        rows.push(`${relativePath}\t${sha256(readFileSync(absolute))}`);
      } else {
        reject(`${label} contains an unsupported filesystem entry: ${entry.name}`);
      }
    }
  };
  visit(root);
  return { files: rows.length, sha256: sha256(`${rows.join("\n")}\n`), paths };
}

function parseKeyValueLog(contents, label) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (values.has(key)) reject(`${label} contains duplicate key ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function parseJsonEventLog(contents, event, label) {
  const matches = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value?.event === event) matches.push(value);
    } catch {
      // Non-JSON command output is allowed, but one exact receipt event remains mandatory.
    }
  }
  if (matches.length !== 1) reject(`${label} must contain exactly one ${event} event`);
  return matches[0];
}

function sameJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) reject(`${label} differs from the embedded receipt`);
}

function validateArtifactBundle(evidence, evidencePath) {
  if (!evidencePath) reject("artifact-backed verification requires the evidence file path");
  exactObject(
    evidence.artifactBundle,
    ["schemaVersion", "directory", ...Object.keys(ARTIFACT_LAYOUT).filter((key) => key !== "logs"), "logs"],
    "artifactBundle"
  );
  if (evidence.artifactBundle.schemaVersion !== 1) reject("artifactBundle.schemaVersion must equal 1");
  const expectedDirectory = `${path.basename(evidencePath)}.artifacts`;
  if (evidence.artifactBundle.directory !== expectedDirectory) {
    reject(`artifactBundle.directory must equal ${expectedDirectory}`);
  }
  for (const name of ["archive", "schema", "ledger", "catalog", "sourceClosure", "commandSources"]) {
    if (evidence.artifactBundle[name] !== ARTIFACT_LAYOUT[name]) {
      reject(`artifactBundle.${name} must equal ${ARTIFACT_LAYOUT[name]}`);
    }
  }
  exactObject(evidence.artifactBundle.logs, Object.keys(ARTIFACT_LAYOUT.logs), "artifactBundle.logs");
  for (const [name, expected] of Object.entries(ARTIFACT_LAYOUT.logs)) {
    if (evidence.artifactBundle.logs[name] !== expected) reject(`artifactBundle.logs.${name} must equal ${expected}`);
  }

  const candidateRoot = path.resolve(path.dirname(evidencePath), evidence.artifactBundle.directory);
  let rootMetadata;
  try {
    rootMetadata = lstatSync(candidateRoot);
  } catch {
    reject("artifact bundle directory is missing");
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    reject("artifact bundle must be a real directory without symbolic links");
  }
  const bundleRoot = realpathSync(candidateRoot);
  if (path.dirname(bundleRoot) !== realpathSync(path.dirname(evidencePath))) {
    reject("artifact bundle must be a sibling of the evidence file");
  }

  const archivePath = resolveArtifact(bundleRoot, ARTIFACT_LAYOUT.archive, "PostgreSQL archive");
  const archive = readFileSync(archivePath);
  if (archive.length === 0 || archive.subarray(0, 2).toString("hex") !== "1f8b") {
    reject("PostgreSQL archive is not non-empty gzip data");
  }
  let customDump;
  try {
    customDump = gunzipSync(archive);
  } catch (error) {
    reject(`PostgreSQL archive failed gzip integrity validation: ${error.message}`);
  }
  if (customDump.subarray(0, 5).toString("ascii") !== "PGDMP") {
    reject("PostgreSQL archive is not a pg_dump custom-format payload");
  }
  if (sha256(archive) !== evidence.backupSha256) reject("PostgreSQL archive SHA-256 differs from evidence");
  if (BigInt(evidence.rawReceipts.backup.BACKUP_SIZE_BYTES) !== BigInt(archive.length)) {
    reject("PostgreSQL archive size differs from the backup receipt");
  }

  const schema = readFileSync(resolveArtifact(bundleRoot, ARTIFACT_LAYOUT.schema, "schema artifact"));
  if (schema.length === 0 || sha256(schema) !== evidence.schemaSha256) {
    reject("schema artifact SHA-256 differs from evidence");
  }
  const ledger = readFileSync(resolveArtifact(bundleRoot, ARTIFACT_LAYOUT.ledger, "ledger artifact"), "utf8");
  if (sha256(ledger) !== evidence.ledgerSha256) reject("ledger artifact SHA-256 differs from evidence");
  const ledgerRows = ledger.endsWith("\n") ? ledger.slice(0, -1).split("\n") : [];
  const ledgerNames = ledgerRows.map((row) => row.split("\t", 1)[0]);
  sameArray(ledgerNames, EXPECTED_MIGRATIONS, "ledger artifact migrations");
  if (ledgerRows.some((row) => !/^\d{3}-.+\.sql\t[a-f0-9]{64}$/.test(row) || /\t0{64}$/.test(row))) {
    reject("ledger artifact contains an invalid or zero migration checksum");
  }

  const catalogPath = resolveArtifact(bundleRoot, ARTIFACT_LAYOUT.catalog, "catalog artifact");
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch (error) {
    reject(`catalog artifact is not valid JSON: ${error.message}`);
  }
  exactObject(
    catalog,
    ["aclState", "ledger", "ownerState", "runtimeStates", "schemaVersion", "sofiaSchemaVersion", "userSchemas"],
    "catalog artifact"
  );
  if (
    catalog.ledger !== ledger.trimEnd() ||
    catalog.ownerState !== EXPECTED_OWNER_STATE ||
    catalog.aclState !== EXPECTED_ACL_STATE ||
    catalog.schemaVersion !== EXPECTED_GLOBAL_MARKER ||
    catalog.sofiaSchemaVersion !== EXPECTED_SOFIA_MARKER ||
    catalog.userSchemas !== EXPECTED_USER_SCHEMA_STATE
  ) {
    reject("catalog artifact does not contain the exact current ledger, ownership, ACL, markers and schema whitelist");
  }
  exactObject(catalog.runtimeStates, RUNTIME_ROLES, "catalog artifact runtimeStates");
  for (const role of RUNTIME_ROLES) {
    if (catalog.runtimeStates[role] !== expectedRuntimeState(role)) {
      reject(`catalog artifact runtime state differs for ${role}`);
    }
  }
  const serializedRuntimeStates = RUNTIME_ROLES.map((role) => catalog.runtimeStates[role]).join("\n");
  if (
    sha256(`${catalog.aclState}\n${catalog.sofiaSchemaVersion}\n${serializedRuntimeStates}\n`) !== evidence.aclSha256
  ) {
    reject("ACL/runtime artifact SHA-256 differs from evidence");
  }
  if (
    sha256(
      `${catalog.ledger}\n${catalog.ownerState}\n${catalog.aclState}\n${catalog.userSchemas}\n${serializedRuntimeStates}\n`
    ) !== evidence.catalogEvidenceSha256
  ) {
    reject("catalog artifact SHA-256 differs from evidence");
  }

  const logContents = {};
  for (const [name, relativePath] of Object.entries(ARTIFACT_LAYOUT.logs)) {
    logContents[name] = readFileSync(resolveArtifact(bundleRoot, relativePath, `${name} log`), "utf8");
    if (sha256(logContents[name]) !== evidence.logSha256[name]) {
      reject(`${name} log SHA-256 differs from evidence`);
    }
  }
  sameJson(parseKeyValueLog(logContents.backup, "backup log"), evidence.rawReceipts.backup, "backup log receipt");
  sameJson(parseKeyValueLog(logContents.restore, "restore log"), evidence.rawReceipts.restore, "restore log receipt");
  sameJson(
    parseJsonEventLog(logContents.migrationValidation, "pulso_migrations_complete", "migration validation log"),
    evidence.rawReceipts.migrationValidation,
    "migration validation log receipt"
  );
  sameJson(
    parseJsonEventLog(logContents.roleValidation, "pulso_database_roles_ready", "role validation log"),
    evidence.rawReceipts.roleValidation,
    "role validation log receipt"
  );

  const sourceRoot = resolveArtifact(bundleRoot, ARTIFACT_LAYOUT.sourceClosure, "source closure", "directory");
  const sourceClosure = hashDirectoryClosure(sourceRoot, "source closure");
  if (
    sourceClosure.files !== evidence.source.closure.files ||
    sourceClosure.sha256 !== evidence.source.closure.sha256
  ) {
    reject("source closure files or SHA-256 differ from evidence");
  }
  const migrationsRoot = resolveArtifact(
    sourceRoot,
    "packages/pulso-migrations/sql",
    "migration SQL closure",
    "directory"
  );
  const migrationClosure = hashDirectoryClosure(migrationsRoot, "migration SQL closure");
  if (
    migrationClosure.files !== evidence.source.migrationSqlClosure.files ||
    migrationClosure.sha256 !== evidence.source.migrationSqlClosure.sha256
  ) {
    reject("migration SQL closure files or SHA-256 differ from evidence");
  }
  sameArray(migrationClosure.paths, EXPECTED_MIGRATIONS, "migration SQL closure paths");

  const commandsRoot = resolveArtifact(bundleRoot, ARTIFACT_LAYOUT.commandSources, "command sources", "directory");
  const commandClosure = hashDirectoryClosure(commandsRoot, "command sources");
  if (commandClosure.sha256 !== evidence.source.commandSourcesSha256) {
    reject("command sources SHA-256 differs from evidence");
  }
  if (JSON.stringify(commandClosure.paths) !== JSON.stringify(EXPECTED_COMMAND_SOURCES)) {
    reject("command sources do not contain the exact runner, wrappers, engines and Compose descriptor");
  }
}

export function verifyEvidence(evidence, evidencePath) {
  if (evidence.migrationCount === 4 && evidence.schemaVersionValue === 4 && evidence.sofiaSchemaVersionValue === 1) {
    reject("historical PULSO provider migration catalog v4 evidence is not current; current evidence requires 16/16/2");
  }
  exactObject(evidence, TOP_LEVEL_KEYS, "evidence");
  if (evidence.schemaVersion !== 2 || evidence.cell !== "pulso" || evidence.scope !== "postgres-only") {
    reject("evidence must be schemaVersion 2 for cell pulso with scope postgres-only");
  }
  validateCompactUtc(evidence.operationId);
  if (typeof evidence.project !== "string" || !PROJECT_PATTERN.test(evidence.project) || evidence.project.length > 63) {
    reject("project is outside the isolated PULSO recovery namespace");
  }
  if (
    typeof evidence.dockerContext !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(evidence.dockerContext)
  ) {
    reject("dockerContext is invalid");
  }
  validateSha(evidence.dockerEndpointSha256, "dockerEndpointSha256");
  validateSource(evidence.source);

  if (
    evidence.sourceDatabase !== "hyperion_pulso" ||
    evidence.restoreDatabase !== "hyperion_pulso_restore_drill" ||
    evidence.restoreOwner !== "hyperion_pulso_migrator"
  ) {
    reject("evidence does not identify the exact isolated PULSO source, restore database and owner");
  }
  if (evidence.sourceDatabaseRemovedBeforeValidation !== true) {
    reject("sourceDatabaseRemovedBeforeValidation must be true");
  }

  for (const name of [
    "backupSha256",
    "schemaSha256",
    "ledgerSha256",
    "aclSha256",
    "globalReadinessMarkerSha256",
    "sofiaReadinessMarkerSha256",
    "catalogEvidenceSha256",
    "recoveryCanarySha256",
    "sourceRecoveryCanarySha256",
    "restoredRecoveryCanarySha256"
  ]) {
    validateSha(evidence[name], name);
  }
  if (evidence.globalReadinessMarkerSha256 !== sha256(`${EXPECTED_GLOBAL_MARKER}\n`)) {
    reject("globalReadinessMarkerSha256 does not attest the current 16/016 marker");
  }
  if (evidence.sofiaReadinessMarkerSha256 !== sha256(`${EXPECTED_SOFIA_MARKER}\n`)) {
    reject("sofiaReadinessMarkerSha256 does not attest the current owner-local 2/006 marker");
  }

  validateSafeInteger(evidence.migrationCount, 16, "migrationCount");
  validateSafeInteger(evidence.schemaVersionValue, 16, "schemaVersionValue");
  validateSafeInteger(evidence.sofiaSchemaVersionValue, 2, "sofiaSchemaVersionValue");
  sameArray(evidence.migrationsSkippedOnValidation, EXPECTED_MIGRATIONS, "migrationsSkippedOnValidation");

  if (
    evidence.recoveryCanaryPreserved !== true ||
    evidence.recoveryCanarySha256 !== evidence.sourceRecoveryCanarySha256 ||
    evidence.recoveryCanarySha256 !== evidence.restoredRecoveryCanarySha256
  ) {
    reject("source and restored recovery canaries must be identical and explicitly preserved");
  }
  validateSafeInteger(evidence.runtimeRolesVerified, EXPECTED_RUNTIME_ROLES, "runtimeRolesVerified");
  validateSafeInteger(evidence.roleBootstrapCount, EXPECTED_RUNTIME_ROLES, "roleBootstrapCount");
  if (evidence.publicDatabasePrivilegesRevoked !== true) {
    reject("publicDatabasePrivilegesRevoked must be true");
  }
  if (evidence.whatsappSessionsIncluded !== false) {
    reject("postgres-only evidence must explicitly exclude WhatsApp sessions");
  }
  if (evidence.cleanupVerified !== true) reject("cleanupVerified must be true");

  validateSchemaVerifier(evidence.schemaVerifier);
  validateRawReceipts(evidence.rawReceipts, evidence);
  validateLogHashes(evidence.logSha256);
  validateDockerInventory(evidence.dockerInventory, evidence.project);
  validateArtifactBundle(evidence, evidencePath);

  return {
    operationId: evidence.operationId,
    evidenceSha256: sha256(`${JSON.stringify(evidence, null, 2)}\n`),
    migrationCount: evidence.migrationCount,
    runtimeRolesVerified: evidence.runtimeRolesVerified
  };
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.length !== 2 || argv[0] !== "--evidence" || !argv[1] || argv[1].startsWith("--")) {
    reject("usage: node scripts/ops/verify-pulso-postgres-recovery-evidence.mjs --evidence <receipt.json>");
  }
  return { evidence: argv[1] };
}

function readEvidence(file) {
  const candidate = path.resolve(file);
  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch {
    reject("evidence file is missing");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > MAX_EVIDENCE_BYTES) {
    reject("evidence must be a non-empty regular file without symbolic links and at most 8 MiB");
  }
  const canonical = realpathSync(candidate);
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(canonical, "utf8"));
  } catch (error) {
    reject(`evidence is not valid JSON: ${error.message}`);
  }
  return { evidence, canonical };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/ops/verify-pulso-postgres-recovery-evidence.mjs --evidence <receipt.json>\n"
    );
    return;
  }
  const { evidence, canonical } = readEvidence(options.evidence);
  const result = verifyEvidence(evidence, canonical);
  process.stdout.write(`PULSO_POSTGRES_RECOVERY_OPERATION_ID=${result.operationId}\n`);
  process.stdout.write(`PULSO_POSTGRES_RECOVERY_EVIDENCE_FILE_SHA256=${sha256(readFileSync(canonical))}\n`);
  process.stdout.write(`PULSO_POSTGRES_RECOVERY_MIGRATION_COUNT=${result.migrationCount}\n`);
  process.stdout.write(`PULSO_POSTGRES_RECOVERY_RUNTIME_ROLES_VERIFIED=${result.runtimeRolesVerified}\n`);
  process.stdout.write("PULSO_POSTGRES_RECOVERY_SCOPE=postgres-only\n");
  process.stdout.write("PULSO_POSTGRES_RECOVERY_ARTIFACT_BUNDLE_VERIFIED=true\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`PULSO recovery evidence verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
