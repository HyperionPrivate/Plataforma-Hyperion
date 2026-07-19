import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLATFORM_POSTGRES_RECOVERY_MANIFEST } from "./platform-postgres-recovery-manifest.mjs";
import {
  assertProviderRecoveryManifest,
  assertSafeProjectName,
  canonicalizeSchemaDump,
  DRILL_CONFIRMATIONS,
  normalizeSchemaDump,
  parseArguments
} from "./run-platform-postgres-recovery-drill.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");

test("accepts only exact provider-scoped confirmations and projects", () => {
  const now = new Date("2026-07-18T21:30:00.000Z");
  assert.deepEqual(parseArguments(["--provider", "access", "--confirm", DRILL_CONFIRMATIONS.access], now, "abcd1234"), {
    provider: "access",
    confirm: DRILL_CONFIRMATIONS.access,
    operationId: "20260718T213000Z",
    project: "hyperion-access-recovery-acceptance-20260718t213000z-abcd1234"
  });
  assert.throws(
    () => parseArguments(["--provider", "audit", "--confirm", DRILL_CONFIRMATIONS.access], now),
    /--confirm must equal/
  );
  assert.throws(
    () => assertSafeProjectName("hyperion-access-recovery-acceptance-manual", "audit"),
    /isolated audit recovery project/
  );
});

test("pins each recovery ledger to the provider-owned SQL bytes", () => {
  for (const provider of ["access", "audit"]) {
    assert.equal(
      assertProviderRecoveryManifest(provider, repositoryRoot),
      PLATFORM_POSTGRES_RECOVERY_MANIFEST[provider]
    );
  }
  assert.notEqual(
    PLATFORM_POSTGRES_RECOVERY_MANIFEST.access.migrationDirectory,
    PLATFORM_POSTGRES_RECOVERY_MANIFEST.audit.migrationDirectory
  );
  assert.notEqual(
    PLATFORM_POSTGRES_RECOVERY_MANIFEST.access.sourceDatabase,
    PLATFORM_POSTGRES_RECOVERY_MANIFEST.audit.sourceDatabase
  );
  assert.deepEqual(PLATFORM_POSTGRES_RECOVERY_MANIFEST.access.triggers, {
    "platform.tenants.trg_access_tenant_lifecycle_v1": "A"
  });
  assert.deepEqual(PLATFORM_POSTGRES_RECOVERY_MANIFEST.audit.triggers, {});
});

test("keeps production wrappers and ops descriptors free of product credentials", () => {
  for (const provider of ["access", "audit"]) {
    const files = [
      path.join(scriptDirectory, `${provider}-postgres-backup.sh`),
      path.join(scriptDirectory, `${provider}-postgres-restore.sh`),
      path.join(repositoryRoot, "infra", `docker-compose.${provider}-ops.yml`),
      path.join(repositoryRoot, "infra", `${provider}-ops.env.example`)
    ];
    const contents = files.map((file) => readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(contents, /NOVA_|LUMEN_|PULSO_|SOFIA_|WHATSAPP_/i);
    assert.doesNotMatch(contents, /packages\/(?:nova|lumen|pulso)-migrations/i);
  }
});

test("normalizes PostgreSQL transport restriction tokens before schema comparison", () => {
  assert.equal(
    normalizeSchemaDump("\\restrict alpha\r\nCREATE SCHEMA x;\r\n\\unrestrict beta\r\n"),
    "\\restrict <normalized>\nCREATE SCHEMA x;\n\\unrestrict <normalized>\n"
  );
  assert.equal(
    canonicalizeSchemaDump('CONSTRAINT "c" CHECK ((("a" > 0) AND ("b" > 0)))'),
    canonicalizeSchemaDump('CONSTRAINT "c" CHECK (("a" > 0 AND "b" > 0))')
  );
});
