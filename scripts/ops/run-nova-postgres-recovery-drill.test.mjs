import assert from "node:assert/strict";
import test from "node:test";

import {
  DRILL_CONFIRMATION,
  assertRestoredDatabaseAcl,
  assertProjectAbsent,
  assertSafeProjectName,
  expectedMigrationFiles,
  normalizeSchemaDump,
  parseArguments,
  parseKeyValueOutput
} from "./run-nova-postgres-recovery-drill.mjs";

test("requires an exact opt-in confirmation and generates a scoped project", () => {
  const options = parseArguments(["--confirm", DRILL_CONFIRMATION], new Date("2026-07-17T23:59:58.000Z"), "deadbeef");
  assert.equal(options.operationId, "20260717T235958Z");
  assert.equal(options.project, "hyperion-nova-recovery-acceptance-20260717t235958z-deadbeef");
  assert.throws(() => parseArguments(["--confirm", "yes"]), /--confirm must equal/);
});

test("requires the restored NOVA database to preserve its exact provider ACL", () => {
  const exact = ["t", "t", "t", "t", ...Array.from({ length: 4 }, () => ["t", "f", "f"]).flat()].join("\t");
  assert.doesNotThrow(() => assertRestoredDatabaseAcl(exact));
  assert.throws(() => assertRestoredDatabaseAcl(exact.replace(/^t/, "f")), /least-privilege provider boundary/);
});

test("accepts only a narrowly scoped Compose project and refuses existing resources", () => {
  assert.doesNotThrow(() => assertSafeProjectName("hyperion-nova-recovery-acceptance-manual1"));
  assert.throws(() => assertSafeProjectName("plataforma-hyperion"), /--project must match/);
  assert.throws(
    () =>
      assertProjectAbsent(
        { containers: ["abc123"], networks: [], volumes: [], images: [] },
        "hyperion-nova-recovery-acceptance-manual1"
      ),
    /already has resources/
  );
});

test("derives the provider migration ledger and parses wrapper evidence deterministically", () => {
  assert.deepEqual(expectedMigrationFiles(), [
    "047-nova-autonomy.sql",
    "048-nova-correlation-and-domain.sql",
    "049-nova-ui-meta-contactos.sql",
    "050-nova-lead-product-line.sql",
    "051-liwa-accepted-pending.sql",
    "052-nova-conversation-messages.sql",
    "053-nova-tenant-owned-routing.sql",
    "054-nova-voice-orchestration-policy.sql",
    "055-nova-voice-policy-approval-and-exclusions.sql"
  ]);
  const values = parseKeyValueOutput("BACKUP_PROFILE=nova\r\nBACKUP_SHA256=abc=def\r\n");
  assert.equal(values.get("BACKUP_PROFILE"), "nova");
  assert.equal(values.get("BACKUP_SHA256"), "abc=def");
  assert.equal(
    normalizeSchemaDump("\\restrict random-one\r\nschema\r\n\\unrestrict random-one\r\n"),
    "\\restrict <normalized>\nschema\n\\unrestrict <normalized>\n"
  );
});
