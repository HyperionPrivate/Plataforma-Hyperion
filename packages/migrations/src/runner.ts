import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createLogger } from "@hyperion/logger";
import pg from "pg";

const { Client } = pg;

const logger = createLogger("migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrationExecutionOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 300_000;
export const MIGRATION_ADVISORY_LOCK_KEYS = [0x48595045, 0x52494f4e] as const;
const LEGACY_AUTONOMOUS_EVENT_FLOW_CHECKSUM = "8453d1ffd7f2e40a8ed5899d15c1609b0380d30faad12e3b57fa7e18c1e7942f";
const LEGACY_AUDIT_PROVENANCE_CHECKSUM = "8fd9c9105633c4dbc2ffab66588fcd878733cb585eb3e05811e7c72d581277b7";

/** Checksum over LF-normalized content so Windows and Linux checkouts agree. */
export function computeChecksum(content: string): string {
  return createHash("sha256").update(content.replaceAll("\r\n", "\n")).digest("hex");
}

export async function listMigrationFiles(sqlDir: string): Promise<string[]> {
  const entries = await readdir(sqlDir);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

export function readMigrationExecutionOptions(environment: NodeJS.ProcessEnv = process.env): MigrationExecutionOptions {
  return {
    lockTimeoutMs: readPositiveInteger(
      environment.MIGRATION_LOCK_TIMEOUT_MS,
      "MIGRATION_LOCK_TIMEOUT_MS",
      DEFAULT_LOCK_TIMEOUT_MS
    ),
    statementTimeoutMs: readPositiveInteger(
      environment.MIGRATION_STATEMENT_TIMEOUT_MS,
      "MIGRATION_STATEMENT_TIMEOUT_MS",
      DEFAULT_STATEMENT_TIMEOUT_MS
    )
  };
}

export function migrationRunsInTransaction(content: string): boolean {
  return !content
    .replace(/^\uFEFF/, "")
    .trimStart()
    .startsWith("-- hyperion:no-transaction");
}

/**
 * Splits an explicitly non-transactional migration into independently
 * autocommitted statements. PostgreSQL's extended query protocol can wrap a
 * multi-statement query in one implicit transaction, which would make
 * CREATE/DROP INDEX CONCURRENTLY illegal. Requiring an explicit marker also
 * keeps semicolons inside DO/function bodies intact.
 */
export function readNonTransactionalStatements(content: string): string[] {
  if (migrationRunsInTransaction(content)) {
    throw new Error("Non-transactional statements require the hyperion:no-transaction marker");
  }

  const normalized = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
  const sections = normalized.split(/^\s*-- hyperion:statement\s*$/gm);
  if (sections.length === 1) {
    throw new Error("Non-transactional migrations require a hyperion:statement marker per statement");
  }

  const preamble = sections.shift() ?? "";
  const executablePreamble = preamble
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("--"));
  if (executablePreamble.length > 0) {
    throw new Error("Non-transactional migration preamble may only contain comments");
  }

  const statements = sections.map((section) => section.trim()).filter((section) => section !== "");
  if (statements.length !== sections.length) {
    throw new Error("Non-transactional migration contains an empty hyperion:statement block");
  }
  return statements;
}

export async function runMigrations(
  databaseUrl: string,
  sqlDir: string,
  executionOptions: MigrationExecutionOptions = readMigrationExecutionOptions()
): Promise<MigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let migrationLockAcquired = false;

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // Session-level locking also covers the autocommitted CONCURRENTLY blocks.
    // It is acquired before inspecting the ledger so a waiting runner cannot
    // make decisions from state that the active runner is still changing. An
    // explicit statement budget prevents an abandoned runner from blocking a
    // deployment indefinitely because advisory locks ignore lock_timeout.
    await client.query("select set_config('statement_timeout', $1, false)", [`${executionOptions.lockTimeoutMs}ms`]);
    try {
      await client.query("select pg_advisory_lock($1::integer, $2::integer)", [...MIGRATION_ADVISORY_LOCK_KEYS]);
    } finally {
      await client.query("reset statement_timeout");
    }
    migrationLockAcquired = true;

    await client.query("create schema if not exists platform");
    await client.query(`
      create table if not exists platform.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const files = await listMigrationFiles(sqlDir);
    const existing = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from platform.schema_migrations"
    );
    const alreadyApplied = new Map(existing.rows.map((row) => [row.name, row.checksum]));

    for (const file of files) {
      const content = await readFile(path.join(sqlDir, file), "utf8");
      const checksum = computeChecksum(content);
      const appliedChecksum = alreadyApplied.get(file);

      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== checksum) {
          const upgraded = await upgradeCompatibleDraftChecksum(
            client,
            file,
            appliedChecksum,
            checksum,
            content,
            executionOptions
          );
          if (!upgraded) {
            throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
          }
          logger.info("validated migration checksum transition", { file });
        }
        skipped.push(file);
        continue;
      }

      if (migrationRunsInTransaction(content)) {
        await client.query("begin");
        try {
          await configureTimeouts(client, executionOptions, true);
          await client.query(content);
          await client.query("insert into platform.schema_migrations (name, checksum) values ($1, $2)", [
            file,
            checksum
          ]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      } else {
        // PostgreSQL forbids operations such as CREATE INDEX CONCURRENTLY in a
        // transaction block. Each marked block is sent separately so it is
        // autocommitted. The migration's final block must validate the durable
        // result; only then may the runner insert the migration ledger row.
        const statements = readNonTransactionalStatements(content);
        await configureTimeouts(client, executionOptions, false);
        try {
          for (const statement of statements) {
            await client.query(statement);
          }
          await client.query("insert into platform.schema_migrations (name, checksum) values ($1, $2)", [
            file,
            checksum
          ]);
        } finally {
          await client.query("reset lock_timeout");
          await client.query("reset statement_timeout");
        }
      }

      applied.push(file);
      logger.info("migration applied", { file });
    }

    return { applied, skipped };
  } finally {
    try {
      if (migrationLockAcquired) {
        await client.query("select pg_advisory_unlock($1::integer, $2::integer)", [...MIGRATION_ADVISORY_LOCK_KEYS]);
      }
    } finally {
      await client.end();
    }
  }
}

/**
 * PR #18 phased two unreleased migrations after their audited drafts had
 * already been exercised in rehearsal databases. Accept only the two exact
 * prior digests and only after PostgreSQL proves their complete prior contract.
 * No other migration or checksum receives an exception.
 */
async function upgradeCompatibleDraftChecksum(
  client: InstanceType<typeof Client>,
  file: string,
  appliedChecksum: string,
  currentChecksum: string,
  currentContent: string,
  executionOptions: MigrationExecutionOptions
): Promise<boolean> {
  if (file === "021-autonomous-event-flow.sql" && appliedChecksum === LEGACY_AUTONOMOUS_EVENT_FLOW_CHECKSUM) {
    return upgradeLegacyAutonomousEventFlowChecksum(
      client,
      file,
      appliedChecksum,
      currentChecksum,
      currentContent,
      executionOptions
    );
  }

  if (file !== "026-audit-source-provenance.sql" || appliedChecksum !== LEGACY_AUDIT_PROVENANCE_CHECKSUM) {
    return false;
  }

  await client.query("begin");
  try {
    await configureTimeouts(client, executionOptions, true);
    const result = await client.query<{ compatible: boolean }>(`
      select
        exists (
          select 1
            from information_schema.columns
           where table_schema = 'audit_runtime'
             and table_name = 'inbox_events'
             and column_name = 'contract_hash'
             and is_nullable = 'NO'
             and column_default is null
        )
        and (
          select count(*) = 2
            from pg_catalog.pg_constraint
           where conrelid = 'audit_runtime.inbox_events'::regclass
             and conname in ('ck_audit_inbox_contract_hash', 'ck_audit_inbox_source_contract')
             and contype = 'c'
             and convalidated
        )
        and exists (
          select 1
            from pg_catalog.pg_class index_class
            join pg_catalog.pg_namespace index_namespace
              on index_namespace.oid = index_class.relnamespace
            join pg_catalog.pg_index index_info
              on index_info.indexrelid = index_class.oid
           where index_namespace.nspname = 'audit_runtime'
             and index_class.relname = 'ix_audit_inbox_source_received'
             and index_info.indisvalid
             and index_info.indisready
        )
        and not exists (
          select 1
            from audit_runtime.inbox_events
           where contract_hash !~ '^[a-f0-9]{64}$'
              or not (
                (source_service = 'sofia-automation' and event_type = 'sofia.audit.event.record.v1')
                or (source_service = 'lumen-service' and event_type = 'lumen.audit.event.record.v1')
                or (source_service = 'pulso-iris-service' and event_type = 'pulso.audit.event.record.v1')
                or (source_service = 'whatsapp-channel-service' and event_type = 'channel.audit.event.record.v1')
                or (source_service = 'legacy-unknown' and event_type = 'legacy.audit.event.record.v1')
              )
        )
        and not exists (
          select 1 from agent_runtime.outbox_events where event_type = 'audit.event.record.v1'
        )
        and not exists (
          select 1 from lumen.outbox_events where event_type = 'audit.event.record.v1'
        )
        and position(
          'lumen.audit.event.record.v1'
          in coalesce(pg_catalog.pg_get_functiondef(
            pg_catalog.to_regprocedure('lumen.finalize_clinical_record_approval()')
          ), '')
        ) > 0 as compatible
    `);
    if (!result.rows[0]?.compatible) {
      await client.query("rollback");
      return false;
    }

    const updated = await client.query(
      `update platform.schema_migrations
          set checksum = $1
        where name = $2 and checksum = $3`,
      [currentChecksum, file, appliedChecksum]
    );
    if (updated.rowCount !== 1) {
      throw new Error("migration checksum transition lost its ledger precondition");
    }
    await client.query("commit");
    return true;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the validation failure; closing the session releases state.
    }
    throw error;
  }
}

async function upgradeLegacyAutonomousEventFlowChecksum(
  client: InstanceType<typeof Client>,
  file: string,
  appliedChecksum: string,
  currentChecksum: string,
  currentContent: string,
  executionOptions: MigrationExecutionOptions
): Promise<boolean> {
  const statements = readNonTransactionalStatements(currentContent);
  const catalogValidation = statements.at(-1);
  if (catalogValidation === undefined || !/^do\s+\$migration\$/i.test(catalogValidation)) {
    throw new Error("021 checksum transition requires its final catalog validation block");
  }

  await client.query("begin");
  try {
    await configureTimeouts(client, executionOptions, true);
    await client.query(catalogValidation);
    const updated = await client.query(
      `update platform.schema_migrations
          set checksum = $1
        where name = $2 and checksum = $3`,
      [currentChecksum, file, appliedChecksum]
    );
    if (updated.rowCount !== 1) {
      throw new Error("migration checksum transition lost its ledger precondition");
    }
    await client.query("commit");
    return true;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Preserve the validation failure; closing the session releases state.
    }
    throw error;
  }
}

async function configureTimeouts(
  client: InstanceType<typeof Client>,
  executionOptions: MigrationExecutionOptions,
  local: boolean
): Promise<void> {
  await client.query("select set_config('lock_timeout', $1, $2)", [`${executionOptions.lockTimeoutMs}ms`, local]);
  await client.query("select set_config('statement_timeout', $1, $2)", [
    `${executionOptions.statementTimeoutMs}ms`,
    local
  ]);
}

function readPositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
