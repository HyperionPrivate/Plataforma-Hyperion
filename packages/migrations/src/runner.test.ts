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
    expect([...files].sort()).toEqual(files);
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
