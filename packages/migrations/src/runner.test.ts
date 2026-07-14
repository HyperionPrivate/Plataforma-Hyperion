import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeChecksum,
  listMigrationFiles,
  migrationRunsInTransaction,
  readNonTransactionalStatements,
  readMigrationExecutionOptions
} from "./runner.js";

describe("migrations runner", () => {
  it("computes the same checksum regardless of line endings", () => {
    const unix = "create table t (\n  id int\n);\n";
    const windows = "create table t (\r\n  id int\r\n);\r\n";

    expect(computeChecksum(windows)).toBe(computeChecksum(unix));
  });

  it("changes the checksum when content changes", () => {
    expect(computeChecksum("select 1")).not.toBe(computeChecksum("select 2"));
  });

  it("applies finite lock and statement budgets with validated overrides", () => {
    expect(readMigrationExecutionOptions({})).toEqual({
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 300_000
    });
    expect(
      readMigrationExecutionOptions({
        MIGRATION_LOCK_TIMEOUT_MS: "2500",
        MIGRATION_STATEMENT_TIMEOUT_MS: "90000"
      })
    ).toEqual({ lockTimeoutMs: 2500, statementTimeoutMs: 90_000 });
    expect(() => readMigrationExecutionOptions({ MIGRATION_LOCK_TIMEOUT_MS: "0" })).toThrow(
      "MIGRATION_LOCK_TIMEOUT_MS must be a positive integer"
    );
  });

  it("requires an explicit autocommit block for every non-transactional statement", () => {
    expect(migrationRunsInTransaction("create table example(id int)")).toBe(true);
    const migration = `-- hyperion:no-transaction
-- recovery preamble
-- hyperion:statement
drop index concurrently if exists ix_example;
-- hyperion:statement
create index concurrently ix_example on example(id);
-- hyperion:statement
do $$
begin
  if false then raise exception 'invalid'; end if;
end;
$$;`;

    expect(migrationRunsInTransaction(migration)).toBe(false);
    expect(readNonTransactionalStatements(migration)).toEqual([
      "drop index concurrently if exists ix_example;",
      "create index concurrently ix_example on example(id);",
      `do $$
begin
  if false then raise exception 'invalid'; end if;
end;
$$;`
    ]);
    expect(() =>
      readNonTransactionalStatements("-- hyperion:no-transaction\ncreate index concurrently ix_example on example(id)")
    ).toThrow("hyperion:statement marker per statement");
    expect(() =>
      readNonTransactionalStatements(
        "-- hyperion:no-transaction\nselect 1;\n-- hyperion:statement\ncreate index concurrently ix_example on example(id)"
      )
    ).toThrow("preamble may only contain comments");
  });

  it("phases migration 021 and validates every concurrent index before ledger insertion", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/021-autonomous-event-flow.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");
    const statements = readNonTransactionalStatements(migration);

    expect(migrationRunsInTransaction(migration)).toBe(false);
    expect(statements).toHaveLength(30);
    expect(statements.filter((statement) => /^drop index concurrently/i.test(statement))).toHaveLength(8);
    expect(statements.filter((statement) => /^create (unique )?index concurrently/i.test(statement))).toHaveLength(8);
    expect(statements.some((statement) => /^create index if not exists/i.test(statement))).toBe(false);
    expect(statements.at(-1)).toMatch(/^do\s+\$migration\$/i);
    expect(statements.at(-1)).toContain("attribute.attnum between 1 and target.original_columns");
    expect(statements.at(-1)).toContain("constraint_info.convalidated");
    expect(statements.at(-1)).toContain("index_info.indisvalid");
    expect(statements.at(-1)).toContain("index_info.indisready");
    expect(statements.at(-1)).toContain("pg_get_indexdef(index_info.indexrelid)");
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
    expect(files).toContain("020-service-role-nologin-fence.sql");
    expect(files).toContain("021-autonomous-event-flow.sql");
    expect(files).toContain("022-channel-inbound-outbox-fence.sql");
    expect(files).toContain("023-channel-inbound-outbox-backfill.sql");
    expect(files).toContain("024-service-database-roles.sql");
    expect(files).toContain("024-service-role-membership-fence.sql");
    expect(files).toContain("025-audit-ledger-autonomy.sql");
    expect(files).toContain("026-audit-source-provenance.sql");
    expect(files).toContain("027-audit-source-provenance-contract.sql");
    expect(files).toContain("028-audit-source-provenance-index.sql");
    expect([...files].sort()).toEqual(files);
    expect(files.indexOf("020-service-role-nologin-fence.sql")).toBeLessThan(
      files.indexOf("021-autonomous-event-flow.sql")
    );
  });

  it("commits the service-role fence before checking for sessions that must drain", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/020-service-role-nologin-fence.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");
    const statements = readNonTransactionalStatements(migration);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("alter role %I nologin");
    expect(statements[1]).toContain("from pg_stat_activity");
    expect(statements[1]).toContain("drain all Hyperion service database sessions");
  });

  it("migrates Audit provenance without trusting the legacy SOFIA default", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/026-audit-source-provenance.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("alter column source_service drop default");
    expect(migration).toContain("sofia.audit.event.record.v1");
    expect(migration).toContain("lumen.audit.event.record.v1");
    expect(migration).toContain("legacy-unknown");
    expect(migration).toContain("contract_hash");
    expect(migration).toContain("then 'sofia-automation'");
    expect(migration).toContain("then 'lumen-service'");
    expect(migration).not.toMatch(/source_service\s+text\s+not\s+null\s+default/i);
    expect(migration).not.toContain("create index if not exists ix_audit_inbox_source_received");
  });

  it("adds durable PULSO/Channel audit outbox dedupe and expands the inbox contract", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/041-pulso-channel-audit-outbox.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("uq_pulso_outbox_dedupe");
    expect(migration).toContain("uq_channel_outbox_dedupe");
    expect(migration).toContain("pulso.audit.event.record.v1");
    expect(migration).toContain("channel.audit.event.record.v1");
    expect(migration).toContain("pulso-iris-service");
    expect(migration).toContain("whatsapp-channel-service");
  });

  it("contracts and indexes Audit provenance in bounded follow-up phases", async () => {
    const contractPath = fileURLToPath(new URL("../sql/027-audit-source-provenance-contract.sql", import.meta.url));
    const indexPath = fileURLToPath(new URL("../sql/028-audit-source-provenance-index.sql", import.meta.url));
    const [contract, index] = await Promise.all([readFile(contractPath, "utf8"), readFile(indexPath, "utf8")]);

    expect(contract).toContain("not valid");
    expect(contract).toContain("validate constraint ck_audit_inbox_contract_hash");
    expect(contract).toContain("alter column contract_hash set not null");
    expect(contract).toContain("source_service = 'sofia-automation'");
    expect(contract).toContain("source_service = 'lumen-service'");
    expect(index.trimStart()).toMatch(/^-- hyperion:no-transaction/);
    expect(index).toContain("drop index concurrently if exists audit_runtime.ix_audit_inbox_source_received");
    expect(index).toContain("create index concurrently ix_audit_inbox_source_received");
    expect(index).toContain("index_info.indisvalid");
    expect(index).toContain("pg_catalog.pg_get_indexdef(index_info.indexrelid)");
    expect(readNonTransactionalStatements(index)).toHaveLength(3);
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
    expect(migration).not.toContain("create trigger trg_channel_inbound_outbox_compat");
    expect(migration).not.toContain("mirror_inbound_event_to_outbox");
    expect(migration).not.toContain("references platform.");
    expect(migration).not.toContain("references pulso_iris.");
  });

  it("installs the Channel writer fence and repairs missing outbox rows before historical 023", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/022-channel-inbound-outbox-fence.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("create trigger trg_channel_inbound_outbox_compat");
    expect(migration).toContain("mirror_inbound_event_to_outbox");
    expect(migration).toContain("on conflict (tenant_id, event_type, aggregate_id) do nothing");
    expect(migration).toContain("022-channel-inbound-outbox-fence.sql");
  });

  it("rebuilds and validates every Channel ordering index before ledger insertion", async () => {
    const migrationPath = fileURLToPath(
      new URL("../sql/031-channel-conversation-ordering-indexes.sql", import.meta.url)
    );
    const migration = await readFile(migrationPath, "utf8");
    const statements = readNonTransactionalStatements(migration);

    expect(statements).toHaveLength(7);
    expect(statements.filter((statement) => /^drop index concurrently/i.test(statement))).toHaveLength(3);
    expect(statements.filter((statement) => /^create (unique )?index concurrently/i.test(statement))).toHaveLength(3);
    expect(statements.at(-1)).toContain("index_info.indisvalid");
    expect(statements.at(-1)).toContain("index_info.indisready");
    expect(statements.at(-1)).toContain("pg_catalog.pg_get_indexdef(index_info.indexrelid)");
  });

  it("backfills only the contiguous PULSO checkpoint instead of skipping historical holes", async () => {
    const migrationPath = fileURLToPath(new URL("../sql/030-channel-conversation-ordering.sql", import.meta.url));
    const migration = await readFile(migrationPath, "utf8");
    const statements = readNonTransactionalStatements(migration);

    expect(migration).toContain("row_number() over");
    expect(migration).toContain("where stream_sequence = contiguous_rank");
    expect(migrationRunsInTransaction(migration)).toBe(false);
    expect(migration).toContain("not valid");
    expect(migration).not.toContain("to hyperion_pulso");
    expect(migration).not.toMatch(
      /with processed_positions as \(\s*select tenant_id, stream_id, max\(stream_sequence\)/i
    );
    expect(statements.at(-1)).toMatch(/^do\s+\$migration\$/i);
    expect(statements.at(-1)).toContain("Channel ordering backfill is incomplete");
  });

  it("validates Channel ordering constraints in a replayable contract phase", async () => {
    const migrationPath = fileURLToPath(
      new URL("../sql/034-channel-conversation-ordering-contract.sql", import.meta.url)
    );
    const migration = await readFile(migrationPath, "utf8");
    const statements = readNonTransactionalStatements(migration);

    expect(statements).toHaveLength(3);
    expect(statements.filter((statement) => /validate constraint/i.test(statement))).toHaveLength(2);
    expect(statements.at(-1)).toContain("not convalidated");
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
