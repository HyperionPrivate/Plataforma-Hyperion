import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeChecksum, listMigrationFiles } from "./runner.js";

describe("migrations runner", () => {
  it("computes the same checksum regardless of line endings", () => {
    const unix = "create table t (\n  id int\n);\n";
    const windows = "create table t (\r\n  id int\r\n);\r\n";

    expect(computeChecksum(windows)).toBe(computeChecksum(unix));
  });

  it("changes the checksum when content changes", () => {
    expect(computeChecksum("select 1")).not.toBe(computeChecksum("select 2"));
  });

  it("lists the repository migrations in order", async () => {
    const sqlDir = fileURLToPath(new URL("../sql", import.meta.url));
    const files = await listMigrationFiles(sqlDir);

    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files[0]).toBe("001-platform.sql");
    expect(files[1]).toBe("002-pulso-iris.sql");
    expect(files).toContain("011-configurable-agenda.sql");
    expect(files).toContain("012-whatsapp-sofia-runtime.sql");
    expect(files).toContain("013-sofia-confirmation-protocol.sql");
    expect(files).toContain("014-sofia-local-time-protocol.sql");
    expect(files).toContain("015-sofia-fresh-availability.sql");
    expect(files).toContain("016-sofia-search-constraints.sql");
    expect(files).toContain("017-whatsapp-channel-durability.sql");
    expect(files).toContain("018-lumen-clinical-demo.sql");
    expect(files).toContain("019-lumen-clinical-invariants.sql");
    expect(files).toContain("020-lumen-real-audio-pipeline.sql");
    expect(files).toContain("023-channel-inbound-outbox-backfill.sql");
    expect(files).toContain("024-service-database-roles.sql");
    expect(files).toContain("025-audit-ledger-autonomy.sql");
    expect(files).toContain("026-audit-source-provenance.sql");
    expect([...files].sort()).toEqual(files);
  });

  it("migrates Audit provenance without trusting the legacy SOFIA default", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/026-audit-source-provenance.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("alter column source_service drop default");
    expect(migration).toContain("sofia.audit.event.record.v1");
    expect(migration).toContain("lumen.audit.event.record.v1");
    expect(migration).toContain("legacy-unknown");
    expect(migration).toContain("contract_hash");
    expect(migration).toContain("source_service = 'sofia-automation'");
    expect(migration).toContain("source_service = 'lumen-service'");
    expect(migration).not.toMatch(/source_service\s+text\s+not\s+null\s+default/i);
  });

  it("keeps Audit tenant identifiers external and immutable across Access deletion", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/025-audit-ledger-autonomy.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("drop constraint if exists audit_events_tenant_id_fkey");
    expect(migration).toContain("constraint_record.confrelid = 'platform.tenants'::regclass");
    expect(migration).not.toMatch(/on\s+delete\s+set\s+null/i);
  });

  it("never records service role isolation as a conditional no-op", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/024-service-database-roles.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("create role %I with nologin nosuperuser");
    expect(migration).toContain("grant connect on database %I to %I");
    expect(migration).toContain("grant usage on schema lumen to hyperion_lumen");
    expect(migration).not.toContain("skipping service privilege grants");
  });

  it("backfills only contract-valid legacy channel events and terminalizes missing identity", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/023-channel-inbound-outbox-backfill.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("from channel_runtime.inbound_events event");
    expect(migration).toContain("join channel_runtime.thread_bindings binding");
    expect(migration).toContain("on conflict (tenant_id, event_type, aggregate_id) do nothing");
    expect(migration).toContain("legacy_inbound_binding_missing");
    expect(migration).toContain("legacy_inbound_contract_invalid");
    expect(migration).not.toContain("references platform.");
    expect(migration).not.toContain("references pulso_iris.");
  });

  it("refuses duplicate WhatsApp source messages without deleting evidence", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/017-whatsapp-channel-durability.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("lock table channel_runtime.outbound_messages in share row exclusive mode");
    expect(migration).toContain("group by tenant_id, provider, message_id");
    expect(migration).toContain("having count(*) > 1");
    expect(migration).toContain("raise exception");
    expect(migration).toContain("on channel_runtime.outbound_messages(tenant_id, provider, message_id)");
    expect(migration).not.toMatch(/\b(delete|update)\s+channel_runtime\.outbound_messages\b/i);
  });

  it("keeps LUMEN processing attempts tenant-scoped without persistent audio", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/020-lumen-real-audio-pipeline.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("unique (tenant_id, encounter_id, operation, idempotency_key)");
    expect(migration).toContain("foreign key (tenant_id, encounter_id)");
    expect(migration).toContain("input_sha256");
    expect(migration).toContain("temp_audio_deleted_at");
    expect(migration).toContain("provider_transcript");
    expect(migration).toContain("reviewed_by");
    expect(migration).toContain("result_snapshot");
    expect(migration).toContain("result_sha256");
    expect(migration).toContain("result_version");
    expect(migration).toContain("new.result_snapshot->>'tenantId' = record.tenant_id::text");
    expect(migration).toContain("terminal LUMEN processing attempts are immutable");
    expect(migration).toContain("LUMEN provider transcript is immutable after dictation creation");
    expect(migration).toContain("dictation.processing_attempt_id = new.id");
    expect(migration).not.toMatch(/\b(audio_base64|audio_bytes|audio_data|bytea)\b/i);
  });
});
