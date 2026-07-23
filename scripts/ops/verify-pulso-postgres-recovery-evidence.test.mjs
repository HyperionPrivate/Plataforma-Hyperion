import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { EXPECTED_MIGRATIONS } from "./verify-pulso-postgres-recovery-evidence.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const verifier = path.join(scriptDirectory, "verify-pulso-postgres-recovery-evidence.mjs");
const historicalV4 = path.join(repositoryRoot, "docs", "evidence", "pulso-postgres-recovery-20260719-v4.json");
const temporaryDirectories = [];
const fixtureArtifacts = Symbol("fixtureArtifacts");
const runtimeRoles = [
  "hyperion_pulso",
  "hyperion_sofia",
  "hyperion_knowledge",
  "hyperion_integration",
  "hyperion_channel"
];
const expectedGlobalMarker = "16\t016-attest-access-fk-contract.sql";
const expectedSofiaMarker = "2\t006-access-sofia-tenant-projection.sql";
const expectedAclState = ["f", "f", "f", "t", "t", "t", ...runtimeRoles.flatMap(() => ["t", "f", "f"]), "f"].join("\t");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(label) {
  return sha256(`pulso-recovery-evidence-test:${label}`);
}

function closure(entries) {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const rows = sorted.map((entry) => `${entry.path}\t${sha256(entry.content)}`);
  return { files: rows.length, sha256: sha256(`${rows.join("\n")}\n`) };
}

function runtimeState(role) {
  const canReadGlobalMarker = role !== "hyperion_sofia";
  const canReadSofiaMarker = role === "hyperion_sofia";
  const marker = canReadGlobalMarker
    ? expectedGlobalMarker
    : "15\t015-revoke-sofia-pulso-iris-control-plane-grants.sql";
  return `${role}\thyperion_pulso_restore_drill\t${marker}\t${canReadGlobalMarker}\t${canReadSofiaMarker}\ttrue\ttrue\tfalse\tfalse\tfalse`;
}

function keyValueLog(receipt) {
  return `${Object.entries(receipt)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

function createEvidence() {
  const operationId = "20260722T120000Z";
  const project = `hyperion-pulso-recovery-acceptance-${operationId.toLowerCase()}-a1b2c3d4`;
  const before = [
    {
      id: "a".repeat(64),
      name: "preexisting-postgres",
      image: "postgres:16-alpine@sha256:" + "b".repeat(64)
    }
  ];
  const after = structuredClone(before);
  const archive = gzipSync("PGDMP_PULSO_SYNTHETIC_DATABASE_DRILL");
  const schema = "CREATE SCHEMA pulso_iris;\nCREATE SCHEMA platform;\n";
  const migrationFiles = EXPECTED_MIGRATIONS.map((name) => ({ path: name, content: `-- ${name}\nSELECT 1;\n` }));
  const ledger = `${migrationFiles.map((entry) => `${entry.path}\t${sha256(entry.content)}`).join("\n")}\n`;
  const sourceFiles = [
    ...migrationFiles.map((entry) => ({
      path: `packages/pulso-migrations/sql/${entry.path}`,
      content: entry.content
    })),
    { path: "services/pulso-iris-service/src/index.ts", content: "export {};\n" }
  ];
  const commandSourceFiles = [
    "infra/docker-compose.pulso.yml",
    "scripts/ops/postgres-backup.sh",
    "scripts/ops/postgres-restore.sh",
    "scripts/ops/pulso-postgres-backup.sh",
    "scripts/ops/pulso-postgres-restore.sh",
    "scripts/ops/run-pulso-postgres-recovery-drill.mjs"
  ].map((name) => ({ path: name, content: `fixture for ${name}\n` }));
  const runtimeStates = Object.fromEntries(runtimeRoles.map((role) => [role, runtimeState(role)]));
  const catalog = {
    aclState: expectedAclState,
    ledger: ledger.trimEnd(),
    ownerState: "4\t0\t0",
    runtimeStates,
    schemaVersion: expectedGlobalMarker,
    sofiaSchemaVersion: expectedSofiaMarker,
    userSchemas: "agent_runtime\nchannel_runtime\nintegration_runtime\nknowledge_runtime\nplatform\npulso_iris"
  };
  const serializedRuntimeStates = runtimeRoles.map((role) => runtimeStates[role]).join("\n");
  const backupSha256 = sha256(archive);
  const backupReceipt = {
    BACKUP_CATALOG_ENTRIES: "800",
    BACKUP_DATABASE: "hyperion_pulso",
    BACKUP_DIRECTORY_MODE: "700",
    BACKUP_DIRECTORY_OWNER: "runner:runner",
    BACKUP_FILE: `pulso-${operationId}.dump.gz`,
    BACKUP_FILE_MODE: "600",
    BACKUP_FILE_OWNER: "runner:runner",
    BACKUP_PROFILE: "pulso",
    BACKUP_SHA256: backupSha256,
    BACKUP_SIZE_BYTES: String(archive.length)
  };
  const restoreReceipt = {
    RESTORE_CATALOG_ENTRIES: "800",
    RESTORE_DATABASE: "hyperion_pulso_restore_drill",
    RESTORE_FILE: `pulso-${operationId}.dump.gz`,
    RESTORE_OWNER: "hyperion_pulso_migrator",
    RESTORE_PROFILE: "pulso",
    RESTORE_SHA256: backupSha256
  };
  const migrationReceipt = {
    event: "pulso_migrations_complete",
    applied: [],
    adopted: [],
    skipped: [...EXPECTED_MIGRATIONS]
  };
  const roleReceipt = { event: "pulso_database_roles_ready", roleCount: 5 };
  const logs = {
    backup: keyValueLog(backupReceipt),
    restore: keyValueLog(restoreReceipt),
    migrationValidation: `${JSON.stringify(migrationReceipt)}\n`,
    roleValidation: `${JSON.stringify(roleReceipt)}\n`
  };
  const evidence = {
    schemaVersion: 2,
    cell: "pulso",
    scope: "postgres-only",
    operationId,
    project,
    dockerContext: "desktop-linux",
    dockerEndpointSha256: digest("docker-endpoint"),
    source: {
      branch: "agent/current-pulso-recovery",
      revision: "c".repeat(40),
      workingTreeIncluded: true,
      workingTreeStatusSha256: digest("working-tree-status"),
      workingTreePatchSha256: digest("working-tree-patch"),
      closure: closure(sourceFiles),
      migrationSqlClosure: closure(migrationFiles),
      commandSourcesSha256: closure(commandSourceFiles).sha256
    },
    sourceDatabase: "hyperion_pulso",
    sourceDatabaseRemovedBeforeValidation: true,
    restoreDatabase: "hyperion_pulso_restore_drill",
    restoreOwner: "hyperion_pulso_migrator",
    backupSha256,
    schemaSha256: sha256(schema),
    ledgerSha256: sha256(ledger),
    aclSha256: sha256(`${catalog.aclState}\n${catalog.sofiaSchemaVersion}\n${serializedRuntimeStates}\n`),
    globalReadinessMarkerSha256: sha256(`${expectedGlobalMarker}\n`),
    sofiaReadinessMarkerSha256: sha256(`${expectedSofiaMarker}\n`),
    catalogEvidenceSha256: sha256(
      `${catalog.ledger}\n${catalog.ownerState}\n${catalog.aclState}\n${catalog.userSchemas}\n${serializedRuntimeStates}\n`
    ),
    migrationCount: 16,
    schemaVersionValue: 16,
    sofiaSchemaVersionValue: 2,
    recoveryCanarySha256: digest("canary"),
    sourceRecoveryCanarySha256: digest("canary"),
    restoredRecoveryCanarySha256: digest("canary"),
    recoveryCanaryPreserved: true,
    runtimeRolesVerified: 5,
    migrationsSkippedOnValidation: [...EXPECTED_MIGRATIONS],
    roleBootstrapCount: 5,
    publicDatabasePrivilegesRevoked: true,
    whatsappSessionsIncluded: false,
    schemaVerifier: {
      name: "assertPulsoCatalogEvidence",
      verified: true,
      expectedGlobalMarker,
      expectedSofiaMarker
    },
    rawReceipts: {
      backup: backupReceipt,
      restore: restoreReceipt,
      migrationValidation: migrationReceipt,
      roleValidation: roleReceipt
    },
    logSha256: {
      backup: sha256(logs.backup),
      restore: sha256(logs.restore),
      migrationValidation: sha256(logs.migrationValidation),
      roleValidation: sha256(logs.roleValidation)
    },
    dockerInventory: {
      before,
      after,
      beforeSha256: sha256(`${JSON.stringify(before)}\n`),
      afterSha256: sha256(`${JSON.stringify(after)}\n`),
      preexistingResourcesPreserved: true
    },
    cleanupVerified: true,
    artifactBundle: {
      schemaVersion: 1,
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
      },
      directory: "evidence.json.artifacts"
    }
  };
  Object.defineProperty(evidence, fixtureArtifacts, {
    value: { archive, schema, ledger, catalog, logs, sourceFiles, commandSourceFiles }
  });
  return evidence;
}

function writeEntries(root, entries) {
  for (const entry of entries) {
    const target = path.join(root, ...entry.path.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.content);
  }
}

function writeEvidence(evidence) {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperion-pulso-evidence-test."));
  temporaryDirectories.push(directory);
  const evidencePath = path.join(directory, "evidence.json");
  const bundleRoot = `${evidencePath}.artifacts`;
  const artifacts = evidence[fixtureArtifacts];
  mkdirSync(bundleRoot);
  writeFileSync(path.join(bundleRoot, "postgres-backup.dump.gz"), artifacts.archive);
  writeFileSync(path.join(bundleRoot, "schema.sql"), artifacts.schema);
  writeFileSync(path.join(bundleRoot, "migration-ledger.tsv"), artifacts.ledger);
  writeFileSync(path.join(bundleRoot, "catalog-evidence.json"), `${JSON.stringify(artifacts.catalog, null, 2)}\n`);
  for (const [name, relativePath] of Object.entries(evidence.artifactBundle.logs)) {
    const target = path.join(bundleRoot, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, artifacts.logs[name]);
  }
  writeEntries(path.join(bundleRoot, "source"), artifacts.sourceFiles);
  writeEntries(path.join(bundleRoot, "command-sources"), artifacts.commandSourceFiles);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidencePath;
}

function runPath(evidencePath, arguments_ = ["--evidence", evidencePath]) {
  return spawnSync(process.execPath, [verifier, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}

function runEvidence(evidence) {
  return runPath(writeEvidence(evidence));
}

function expectRejected(mutate, pattern) {
  const evidence = createEvidence();
  mutate(evidence);
  const result = runEvidence(evidence);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
}

function expectArtifactRejected(mutate, pattern) {
  const evidence = createEvidence();
  const evidencePath = writeEvidence(evidence);
  mutate(`${evidencePath}.artifacts`, evidencePath, evidence);
  const result = runPath(evidencePath);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
}

test("accepts a self-consistent current PULSO 16/16/2 PostgreSQL recovery receipt", () => {
  const result = runEvidence(createEvidence());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PULSO_POSTGRES_RECOVERY_OPERATION_ID=20260722T120000Z/);
  assert.match(result.stdout, /PULSO_POSTGRES_RECOVERY_MIGRATION_COUNT=16/);
  assert.match(result.stdout, /PULSO_POSTGRES_RECOVERY_RUNTIME_ROLES_VERIFIED=5/);
  assert.match(result.stdout, /PULSO_POSTGRES_RECOVERY_SCOPE=postgres-only/);
  assert.match(result.stdout, /PULSO_POSTGRES_RECOVERY_ARTIFACT_BUNDLE_VERIFIED=true/);
});

test("explicitly rejects the preserved historical v4 receipt as current evidence", () => {
  const result = runPath(historicalV4);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /historical PULSO provider migration catalog v4 evidence is not current/);
});

test("recalculates every material synthetic artifact instead of trusting receipt hashes", async (t) => {
  const cases = [
    [
      "corrupt gzip archive",
      (root) => writeFileSync(path.join(root, "postgres-backup.dump.gz"), Buffer.from([0x1f, 0x8b, 0x00])),
      /failed gzip integrity validation/
    ],
    [
      "non-pg_dump gzip payload",
      (root) => writeFileSync(path.join(root, "postgres-backup.dump.gz"), gzipSync("not a database dump")),
      /not a pg_dump custom-format payload/
    ],
    [
      "PostgreSQL archive",
      (root) => writeFileSync(path.join(root, "postgres-backup.dump.gz"), gzipSync("PGDMP_different database")),
      /PostgreSQL archive SHA-256 differs/
    ],
    [
      "schema",
      (root) => writeFileSync(path.join(root, "schema.sql"), "CREATE SCHEMA forged;\n"),
      /schema artifact SHA-256 differs/
    ],
    [
      "ledger",
      (root) => writeFileSync(path.join(root, "migration-ledger.tsv"), "forged\n"),
      /ledger artifact SHA-256 differs/
    ],
    [
      "ACL catalog",
      (root, _evidencePath, evidence) => {
        const forged = { ...evidence[fixtureArtifacts].catalog, aclState: expectedAclState.replace(/^f/, "t") };
        writeFileSync(path.join(root, "catalog-evidence.json"), `${JSON.stringify(forged, null, 2)}\n`);
      },
      /catalog artifact does not contain the exact current ledger, ownership, ACL/
    ],
    [
      "backup log",
      (root) => writeFileSync(path.join(root, "logs", "backup.log"), "BACKUP_PROFILE=forged\n"),
      /backup log SHA-256 differs/
    ],
    [
      "source closure",
      (root) =>
        writeFileSync(
          path.join(root, "source", "packages", "pulso-migrations", "sql", EXPECTED_MIGRATIONS[0]),
          "SELECT forged;\n"
        ),
      /source closure files or SHA-256 differ/
    ],
    [
      "command sources",
      (root) => writeFileSync(path.join(root, "command-sources", "scripts", "ops", "postgres-backup.sh"), "forged\n"),
      /command sources SHA-256 differs/
    ]
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => expectArtifactRejected(mutate, pattern));
  }
});

test("fails closed on receipt identity and exact schema", async (t) => {
  const cases = [
    ["schema version", (value) => (value.schemaVersion = 1), /schemaVersion 2/],
    ["cell", (value) => (value.cell = "nova"), /cell pulso/],
    ["scope", (value) => (value.scope = "coordinated"), /scope postgres-only/],
    ["invalid operation time", (value) => (value.operationId = "20260230T120000Z"), /real UTC instant/],
    ["foreign project", (value) => (value.project = "hyperion-other"), /outside the isolated PULSO/],
    ["unexpected field", (value) => (value.untrusted = true), /evidence must contain exactly/]
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => expectRejected(mutate, pattern));
  }
});

test("requires the exact current 001-016 migration catalog and markers", async (t) => {
  const cases = [
    ["migration count", (value) => (value.migrationCount = 15), /migrationCount must equal 16/],
    ["global schema version", (value) => (value.schemaVersionValue = 15), /schemaVersionValue must equal 16/],
    ["SOFIA schema version", (value) => (value.sofiaSchemaVersionValue = 1), /sofiaSchemaVersionValue must equal 2/],
    [
      "missing migration",
      (value) => value.migrationsSkippedOnValidation.pop(),
      /exact ordered PULSO migrations 001-016/
    ],
    [
      "reordered migration",
      (value) => value.migrationsSkippedOnValidation.reverse(),
      /exact ordered PULSO migrations 001-016/
    ],
    [
      "raw restored migration mismatch",
      (value) => value.rawReceipts.migrationValidation.skipped.pop(),
      /exact ordered PULSO migrations 001-016/
    ],
    [
      "migration unexpectedly applied",
      (value) => value.rawReceipts.migrationValidation.applied.push(EXPECTED_MIGRATIONS[0]),
      /must not apply or adopt migrations/
    ],
    [
      "wrong global marker declaration",
      (value) => (value.schemaVerifier.expectedGlobalMarker = "15\t015-revoke.sql"),
      /expectedGlobalMarker/
    ],
    [
      "wrong global marker digest",
      (value) => (value.globalReadinessMarkerSha256 = digest("wrong-global-marker")),
      /does not attest the current 16\/016 marker/
    ],
    [
      "wrong SOFIA marker digest",
      (value) => (value.sofiaReadinessMarkerSha256 = digest("wrong-sofia-marker")),
      /does not attest the current owner-local 2\/006 marker/
    ]
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => expectRejected(mutate, pattern));
  }
});

test("requires non-zero hashes and sufficient source provenance", async (t) => {
  const cases = [
    ["zero backup SHA", (value) => (value.backupSha256 = "0".repeat(64)), /non-zero lowercase SHA-256/],
    ["zero ACL SHA", (value) => (value.aclSha256 = "0".repeat(64)), /aclSha256/],
    [
      "zero working tree status SHA",
      (value) => (value.source.workingTreeStatusSha256 = "0".repeat(64)),
      /source.workingTreeStatusSha256/
    ],
    ["zero revision", (value) => (value.source.revision = "0".repeat(40)), /non-zero lowercase Git object ID/],
    ["unbound working tree", (value) => (value.source.workingTreeIncluded = false), /workingTreeIncluded must be true/],
    ["small source closure", (value) => (value.source.closure.files = 15), /closure.files must be at least 16/],
    [
      "old migration closure",
      (value) => (value.source.migrationSqlClosure.files = 4),
      /migrationSqlClosure.files must equal 16/
    ],
    ["extra provenance field", (value) => (value.source.note = "unbound"), /source must contain exactly/],
    ["zero log SHA", (value) => (value.logSha256.restore = "0".repeat(64)), /logSha256.restore/]
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => expectRejected(mutate, pattern));
  }
});

test("requires role, ACL and isolated restore attestations", async (t) => {
  const cases = [
    ["runtime role count", (value) => (value.runtimeRolesVerified = 4), /runtimeRolesVerified must equal 5/],
    ["bootstrap role count", (value) => (value.roleBootstrapCount = 4), /roleBootstrapCount must equal 5/],
    [
      "raw role count",
      (value) => (value.rawReceipts.roleValidation.roleCount = 4),
      /rawReceipts.roleValidation.roleCount must equal 5/
    ],
    [
      "PUBLIC grants not revoked",
      (value) => (value.publicDatabasePrivilegesRevoked = false),
      /publicDatabasePrivilegesRevoked must be true/
    ],
    [
      "schema verifier false",
      (value) => (value.schemaVerifier.verified = false),
      /must attest assertPulsoCatalogEvidence/
    ],
    [
      "source database retained",
      (value) => (value.sourceDatabaseRemovedBeforeValidation = false),
      /sourceDatabaseRemovedBeforeValidation must be true/
    ],
    ["WhatsApp scope mixed in", (value) => (value.whatsappSessionsIncluded = true), /must explicitly exclude WhatsApp/]
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => expectRejected(mutate, pattern));
  }
});

test("requires an identical source and restored recovery canary", async (t) => {
  const cases = [
    ["preservation flag", (value) => (value.recoveryCanaryPreserved = false)],
    ["source canary", (value) => (value.sourceRecoveryCanarySha256 = digest("different-source-canary"))],
    ["restored canary", (value) => (value.restoredRecoveryCanarySha256 = digest("different-restore-canary"))]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => expectRejected(mutate, /source and restored recovery canaries must be identical/));
  }
});

test("binds backup and restore raw receipts to the operation", async (t) => {
  const cases = [
    [
      "backup archive name",
      (value) => (value.rawReceipts.backup.BACKUP_FILE = "pulso-other.dump.gz"),
      /backup does not match/
    ],
    [
      "restore digest",
      (value) => (value.rawReceipts.restore.RESTORE_SHA256 = digest("different-backup")),
      /restore does not match/
    ],
    ["unsafe archive mode", (value) => (value.rawReceipts.backup.BACKUP_FILE_MODE = "644"), /archive mode 600/],
    [
      "catalog count mismatch",
      (value) => (value.rawReceipts.restore.RESTORE_CATALOG_ENTRIES = "799"),
      /catalog entry counts differ/
    ],
    [
      "missing raw field",
      (value) => delete value.rawReceipts.restore.RESTORE_OWNER,
      /rawReceipts.restore must contain exactly/
    ]
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => expectRejected(mutate, pattern));
  }
});

test("verifies cleanup and the embedded Docker inventory", async (t) => {
  const cases = [
    ["cleanup flag", (value) => (value.cleanupVerified = false), /cleanupVerified must be true/],
    [
      "inventory preservation flag",
      (value) => (value.dockerInventory.preexistingResourcesPreserved = false),
      /preexistingResourcesPreserved must be true/
    ],
    [
      "tampered inventory hash",
      (value) => (value.dockerInventory.beforeSha256 = digest("tampered-inventory")),
      /beforeSha256 differs from the embedded inventory/
    ],
    [
      "changed preexisting resource",
      (value) => {
        value.dockerInventory.after[0].image = "postgres:changed";
        value.dockerInventory.afterSha256 = sha256(`${JSON.stringify(value.dockerInventory.after)}\n`);
      },
      /preexisting Docker resource changed/
    ],
    [
      "leaked project resource",
      (value) => {
        value.dockerInventory.after.push({
          id: "d".repeat(64),
          name: `${value.project}-postgres-1`,
          image: "postgres:16"
        });
        value.dockerInventory.after.sort((left, right) => left.name.localeCompare(right.name));
        value.dockerInventory.afterSha256 = sha256(`${JSON.stringify(value.dockerInventory.after)}\n`);
      },
      /isolated recovery project resource remains after cleanup/
    ]
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => expectRejected(mutate, pattern));
  }
});

test("rejects malformed input and an incomplete CLI invocation", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperion-pulso-evidence-test."));
  temporaryDirectories.push(directory);
  const malformed = path.join(directory, "malformed.json");
  writeFileSync(malformed, "{not-json\n");
  const malformedResult = runPath(malformed);
  assert.notEqual(malformedResult.status, 0);
  assert.match(malformedResult.stderr, /evidence is not valid JSON/);

  const missingArgument = runPath(malformed, []);
  assert.notEqual(missingArgument.status, 0);
  assert.match(missingArgument.stderr, /usage:/);
});
