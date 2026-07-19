import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DRILL_CONFIRMATION,
  EXPECTED_ACL_STATE,
  EXPECTED_MIGRATIONS,
  EXPECTED_OWNER_STATE,
  EXPECTED_SCHEMA_VERSION,
  assertLumenCatalogEvidence,
  assertProjectAbsent,
  assertSafeProjectName,
  expectedMigrationFiles,
  isExpectedRuntimeDdlDenial,
  normalizeSchemaDump,
  parseArguments,
  parseKeyValueOutput
} from "./run-lumen-postgres-recovery-drill.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = "a".repeat(64);
const ledger = EXPECTED_MIGRATIONS.map((name) => `${name}\t${digest}`).join("\n");
const validCatalogEvidence = {
  aclState: EXPECTED_ACL_STATE,
  ledger,
  ownerState: EXPECTED_OWNER_STATE,
  runtimeState: "hyperion_lumen\thyperion_lumen_restore_drill\t40\t002-lumen-runtime-role.sql\ttrue\tfalse",
  schemaVersion: EXPECTED_SCHEMA_VERSION,
  siblingSchemas: ""
};

test("requires an exact opt-in confirmation and generates a scoped LUMEN project", () => {
  const options = parseArguments(["--confirm", DRILL_CONFIRMATION], new Date("2026-07-18T12:34:56.000Z"), "deadbeef");
  assert.equal(options.operationId, "20260718T123456Z");
  assert.equal(options.project, "hyperion-lumen-recovery-acceptance-20260718t123456z-deadbeef");
  assert.throws(() => parseArguments(["--confirm", "yes"]), /--confirm must equal/);
});

test("accepts only a narrow unused Compose project", () => {
  assert.doesNotThrow(() => assertSafeProjectName("hyperion-lumen-recovery-acceptance-manual1"));
  assert.throws(() => assertSafeProjectName("plataforma-hyperion"), /--project must match/);
  assert.throws(
    () =>
      assertProjectAbsent(
        { containers: [], images: [], networks: ["occupied"], volumes: [] },
        "hyperion-lumen-recovery-acceptance-manual1"
      ),
    /already has resources/
  );
});

test("pins the provider ledger to LUMEN migrations 001 and 002", () => {
  assert.deepEqual(expectedMigrationFiles(), EXPECTED_MIGRATIONS);
  assert.doesNotThrow(() => assertLumenCatalogEvidence(validCatalogEvidence));
  assert.throws(
    () => assertLumenCatalogEvidence({ ...validCatalogEvidence, ledger: ledger.split("\n")[0] }),
    /migration ledger differs/
  );
});

test("requires version 40, migrator ownership, exact ACL and a real runtime boundary", () => {
  assert.throws(
    () =>
      assertLumenCatalogEvidence({ ...validCatalogEvidence, schemaVersion: "39\t001-lumen-autonomous-baseline.sql" }),
    /schema version mismatch/
  );
  assert.throws(
    () => assertLumenCatalogEvidence({ ...validCatalogEvidence, ownerState: "hyperion_lumen\t1\t0" }),
    /ownership mismatch/
  );
  assert.throws(
    () => assertLumenCatalogEvidence({ ...validCatalogEvidence, aclState: EXPECTED_ACL_STATE.replace(/^f/, "t") }),
    /ACL mismatch/
  );
  assert.throws(
    () =>
      assertLumenCatalogEvidence({
        ...validCatalogEvidence,
        runtimeState: validCatalogEvidence.runtimeState.replace(/\ttrue\tfalse$/, "\ttrue\ttrue")
      }),
    /runtime access mismatch/
  );
  assert.throws(
    () => assertLumenCatalogEvidence({ ...validCatalogEvidence, siblingSchemas: "pulso_iris" }),
    /sibling schemas/
  );
});

test("the ops descriptor is exec-only and parsing helpers are deterministic", () => {
  const descriptor = readFileSync(path.join(repositoryRoot, "infra", "docker-compose.lumen-ops.yml"), "utf8");
  assert.match(descriptor, /^name: hyperion-lumen$/m);
  assert.match(descriptor, /profiles: \["lumen-ops"\]/);
  assert.doesNotMatch(descriptor, /volumes:|ports:|POSTGRES_PASSWORD|services:\s*\n\s{2}(?!postgres:)/);
  const restoreEngine = readFileSync(path.join(repositoryRoot, "scripts", "ops", "postgres-restore.sh"), "utf8");
  assert.equal([...restoreEngine.matchAll(/\$\{profile_database_acl_sql\}/g)].length, 2);
  assert.match(restoreEngine, /REVOKE ALL ON DATABASE.*FROM PUBLIC/);
  assert.match(restoreEngine, /REVOKE CREATE, TEMPORARY ON DATABASE/);
  const values = parseKeyValueOutput("BACKUP_PROFILE=lumen\nBACKUP_SHA256=abc=def\n");
  assert.equal(values.get("BACKUP_PROFILE"), "lumen");
  assert.equal(values.get("BACKUP_SHA256"), "abc=def");
  assert.equal(
    normalizeSchemaDump("\\restrict random-one\r\nschema\r\n\\unrestrict random-one\r\n"),
    "\\restrict <normalized>\nschema\n\\unrestrict <normalized>\n"
  );
});

test("accepts only a PostgreSQL permission denial as the expected runtime DDL failure", () => {
  assert.equal(isExpectedRuntimeDdlDenial("ERROR: permission denied to create schema"), true);
  assert.equal(isExpectedRuntimeDdlDenial("ERROR: permission denied for database hyperion_lumen_restore_drill"), true);
  assert.equal(isExpectedRuntimeDdlDenial("connection refused"), false);
  assert.equal(isExpectedRuntimeDdlDenial("container disappeared"), false);
});
