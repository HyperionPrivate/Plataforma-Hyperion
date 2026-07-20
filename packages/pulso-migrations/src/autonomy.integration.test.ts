import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertPulsoMigratorDatabaseSecurity,
  assertPulsoRuntimeDatabaseBoundary,
  assertPulsoSchemaCompatible,
  inspectPulsoSchema,
  PULSO_CURRENT_MIGRATION,
  PULSO_CURRENT_SCHEMA_VERSION,
  PULSO_PROVIDER_SCHEMAS,
  PULSO_RUNTIME_ROLES_MIGRATION,
  SOFIA_CURRENT_MIGRATION,
  SOFIA_CURRENT_SCHEMA_VERSION
} from "./schema-manifest.js";
import { computePulsoMigrationChecksum } from "./runner.js";

const { Client } = pg;

const INTEGRATION_ENVIRONMENT = {
  hyperion_pulso_migrator: "TEST_PULSO_MIGRATOR_DATABASE_URL",
  hyperion_pulso: "TEST_PULSO_DATABASE_URL",
  hyperion_sofia: "TEST_SOFIA_DATABASE_URL",
  hyperion_knowledge: "TEST_KNOWLEDGE_DATABASE_URL",
  hyperion_integration: "TEST_INTEGRATION_DATABASE_URL",
  hyperion_channel: "TEST_CHANNEL_DATABASE_URL"
} as const;

type IntegrationRole = keyof typeof INTEGRATION_ENVIRONMENT;
type RuntimeRole = Exclude<IntegrationRole, "hyperion_pulso_migrator">;

const integrationUrls = Object.fromEntries(
  Object.entries(INTEGRATION_ENVIRONMENT).map(([role, variable]) => [role, process.env[variable]?.trim()])
) as Record<IntegrationRole, string | undefined>;
const configuredUrlCount = Object.values(integrationUrls).filter(Boolean).length;
const readinessMutationRequired = process.env.REQUIRE_PULSO_READINESS_ACCEPTANCE?.trim() === "1";
const readinessMutationDatabase = process.env.PULSO_READINESS_ACCEPTANCE_DATABASE_NAME?.trim();
const READINESS_ACCEPTANCE_DATABASE_PATTERN = /^hyperion_pulso_n1_fixture_[a-z0-9_]{1,34}$/;

if (configuredUrlCount !== 0 && configuredUrlCount !== Object.keys(INTEGRATION_ENVIRONMENT).length) {
  const missing = Object.entries(INTEGRATION_ENVIRONMENT)
    .filter(([role]) => !integrationUrls[role as IntegrationRole])
    .map(([, variable]) => variable);
  throw new Error(`Incomplete PULSO autonomy test configuration; missing ${missing.join(", ")}`);
}

if (
  readinessMutationRequired &&
  (configuredUrlCount !== Object.keys(INTEGRATION_ENVIRONMENT).length ||
    !readinessMutationDatabase ||
    !READINESS_ACCEPTANCE_DATABASE_PATTERN.test(readinessMutationDatabase))
) {
  throw new Error(
    "Required PULSO readiness acceptance needs all database URLs and a disposable hyperion_pulso_n1_fixture_* database name"
  );
}

const describeIntegration =
  configuredUrlCount === Object.keys(INTEGRATION_ENVIRONMENT).length ? describe : describe.skip;
const itReadinessMutation = readinessMutationRequired ? it : it.skip;

interface TablePrivilegeExpectation {
  table: string;
  privilege: "DELETE" | "INSERT" | "SELECT" | "UPDATE";
  allowed: boolean;
}

interface FunctionPrivilegeExpectation {
  functionName: string;
  allowed: boolean;
}

const TABLE_PRIVILEGE_MATRIX: Readonly<Record<RuntimeRole, readonly TablePrivilegeExpectation[]>> = {
  hyperion_pulso: [
    { table: "pulso_iris.schema_version", privilege: "SELECT", allowed: true },
    { table: "agent_runtime.schema_version", privilege: "SELECT", allowed: false },
    { table: "pulso_iris.appointments", privilege: "INSERT", allowed: true },
    { table: "pulso_iris.tenant_snapshots", privilege: "SELECT", allowed: true },
    { table: "pulso_iris.tenant_snapshots", privilege: "INSERT", allowed: true },
    { table: "platform.agents", privilege: "SELECT", allowed: false },
    { table: "agent_runtime.jobs", privilege: "SELECT", allowed: false },
    { table: "channel_runtime.connections", privilege: "SELECT", allowed: false },
    { table: "channel_runtime.tenant_snapshots", privilege: "SELECT", allowed: false },
    { table: "pulso_iris.migration_ledger", privilege: "SELECT", allowed: false }
  ],
  hyperion_sofia: [
    { table: "pulso_iris.schema_version", privilege: "SELECT", allowed: true },
    { table: "agent_runtime.schema_version", privilege: "SELECT", allowed: true },
    { table: "platform.agents", privilege: "SELECT", allowed: true },
    { table: "platform.prompt_flows", privilege: "SELECT", allowed: true },
    { table: "agent_runtime.jobs", privilege: "INSERT", allowed: true },
    { table: "agent_runtime.tenant_snapshots", privilege: "SELECT", allowed: true },
    { table: "agent_runtime.tenant_snapshots", privilege: "INSERT", allowed: true },
    { table: "agent_runtime.tenant_snapshots", privilege: "UPDATE", allowed: true },
    { table: "agent_runtime.tenant_snapshots", privilege: "DELETE", allowed: false },
    { table: "agent_runtime.access_projection_inbox", privilege: "SELECT", allowed: true },
    { table: "agent_runtime.access_projection_inbox", privilege: "INSERT", allowed: true },
    { table: "agent_runtime.access_projection_inbox", privilege: "UPDATE", allowed: true },
    { table: "agent_runtime.access_projection_inbox", privilege: "DELETE", allowed: false },
    { table: "pulso_iris.appointments", privilege: "SELECT", allowed: false },
    { table: "channel_runtime.connections", privilege: "SELECT", allowed: false },
    { table: "channel_runtime.tenant_snapshots", privilege: "SELECT", allowed: false },
    { table: "pulso_iris.migration_ledger", privilege: "SELECT", allowed: false }
  ],
  hyperion_knowledge: [
    { table: "pulso_iris.schema_version", privilege: "SELECT", allowed: true },
    { table: "agent_runtime.schema_version", privilege: "SELECT", allowed: false },
    { table: "platform.knowledge_sources", privilege: "SELECT", allowed: true },
    { table: "platform.knowledge_sources", privilege: "UPDATE", allowed: false },
    { table: "platform.integrations", privilege: "SELECT", allowed: false },
    { table: "channel_runtime.tenant_snapshots", privilege: "SELECT", allowed: false },
    { table: "pulso_iris.appointments", privilege: "SELECT", allowed: false },
    { table: "pulso_iris.migration_ledger", privilege: "SELECT", allowed: false }
  ],
  hyperion_integration: [
    { table: "pulso_iris.schema_version", privilege: "SELECT", allowed: true },
    { table: "agent_runtime.schema_version", privilege: "SELECT", allowed: false },
    { table: "platform.integrations", privilege: "SELECT", allowed: true },
    { table: "platform.integrations", privilege: "UPDATE", allowed: false },
    { table: "platform.knowledge_sources", privilege: "SELECT", allowed: false },
    { table: "channel_runtime.tenant_snapshots", privilege: "SELECT", allowed: false },
    { table: "pulso_iris.appointments", privilege: "SELECT", allowed: false },
    { table: "pulso_iris.migration_ledger", privilege: "SELECT", allowed: false }
  ],
  hyperion_channel: [
    { table: "pulso_iris.schema_version", privilege: "SELECT", allowed: true },
    { table: "agent_runtime.schema_version", privilege: "SELECT", allowed: false },
    { table: "channel_runtime.outbound_messages", privilege: "INSERT", allowed: true },
    { table: "channel_runtime.inbound_events", privilege: "UPDATE", allowed: true },
    { table: "channel_runtime.tenant_snapshots", privilege: "SELECT", allowed: true },
    { table: "channel_runtime.tenant_snapshots", privilege: "INSERT", allowed: true },
    { table: "channel_runtime.tenant_snapshots", privilege: "UPDATE", allowed: true },
    { table: "channel_runtime.tenant_snapshots", privilege: "DELETE", allowed: false },
    { table: "channel_runtime.access_projection_inbox", privilege: "SELECT", allowed: true },
    { table: "channel_runtime.access_projection_inbox", privilege: "INSERT", allowed: true },
    { table: "channel_runtime.access_projection_inbox", privilege: "UPDATE", allowed: true },
    { table: "channel_runtime.access_projection_inbox", privilege: "DELETE", allowed: false },
    { table: "pulso_iris.appointments", privilege: "SELECT", allowed: false },
    { table: "platform.integrations", privilege: "SELECT", allowed: false },
    { table: "agent_runtime.jobs", privilege: "SELECT", allowed: false },
    { table: "pulso_iris.migration_ledger", privilege: "SELECT", allowed: false }
  ]
};

const FUNCTION_PRIVILEGE_MATRIX: Readonly<Record<RuntimeRole, readonly FunctionPrivilegeExpectation[]>> = {
  hyperion_pulso: [
    { functionName: "agent_runtime.claim_next_job(text)", allowed: false },
    { functionName: "channel_runtime.claim_next_outbound_message(text)", allowed: false }
  ],
  hyperion_sofia: [
    { functionName: "agent_runtime.claim_next_job(text)", allowed: true },
    { functionName: "agent_runtime.prepare_ordered_job()", allowed: false },
    { functionName: "channel_runtime.claim_next_outbound_message(text)", allowed: false }
  ],
  hyperion_knowledge: [
    { functionName: "agent_runtime.claim_next_job(text)", allowed: false },
    { functionName: "channel_runtime.claim_next_outbound_message(text)", allowed: false }
  ],
  hyperion_integration: [
    { functionName: "agent_runtime.claim_next_job(text)", allowed: false },
    { functionName: "channel_runtime.claim_next_outbound_message(text)", allowed: false }
  ],
  hyperion_channel: [
    { functionName: "channel_runtime.claim_next_inbound_event(text)", allowed: true },
    { functionName: "channel_runtime.claim_next_outbound_message(text)", allowed: true },
    { functionName: "channel_runtime.defer_non_head_outbox_event()", allowed: false },
    { functionName: "agent_runtime.claim_next_job(text)", allowed: false }
  ]
};

describeIntegration("PULSO autonomous PostgreSQL closure", () => {
  const clients = new Map<IntegrationRole, pg.Client>();

  beforeAll(async () => {
    for (const role of Object.keys(INTEGRATION_ENVIRONMENT) as IntegrationRole[]) {
      const client = new Client({ connectionString: integrationUrls[role] });
      await client.connect();
      clients.set(role, client);
    }
    if (readinessMutationRequired) {
      await Promise.all(
        [...clients.entries()].map(async ([role, client]) => assertExactReadinessMutationDatabase(client, role))
      );
    }
  });

  afterAll(async () => {
    await Promise.all([...clients.values()].map(async (client) => client.end()));
  });

  it("materializes exactly the provider-owned fresh v4 catalog, ledgers and owner-local SOFIA marker", async () => {
    const migrator = requiredClient(clients, "hyperion_pulso_migrator");
    const security = await assertPulsoMigratorDatabaseSecurity(migrator);
    expect(security).toMatchObject({
      current_user: "hyperion_pulso_migrator",
      owns_current_database: true,
      owns_other_database: false,
      owns_unexpected_objects: false,
      public_database_privileges: []
    });

    const inspection = await inspectPulsoSchema(migrator, "migrator");
    assertPulsoSchemaCompatible(inspection);
    expect(inspection).toMatchObject({
      state: "managed",
      issues: [],
      currentVersion: PULSO_CURRENT_SCHEMA_VERSION,
      migrationName: PULSO_CURRENT_MIGRATION
    });
    expect(inspection.ledgerEntries.map(({ name }) => name)).toEqual([
      "001-pulso-autonomous-baseline.sql",
      "002-pulso-runtime-roles.sql",
      "003-sofia-readiness-marker.sql",
      "004-access-channel-tenant-projection.sql",
      "005-access-iris-tenant-projection.sql",
      "006-access-sofia-tenant-projection.sql"
    ]);
    expect(inspection.ledgerEntries.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum))).toBe(true);

    const sofiaMarker = await migrator.query<{ current_version: number; migration_name: string }>(
      `select current_version, migration_name
         from agent_runtime.schema_version
        where service_name = 'sofia'`
    );
    expect(sofiaMarker.rows).toEqual([
      { current_version: SOFIA_CURRENT_SCHEMA_VERSION, migration_name: SOFIA_CURRENT_MIGRATION }
    ]);

    const catalog = await migrator.query<{
      functions: number;
      invalid_constraints: number;
      invalid_indexes: number;
      tables: number;
      triggers: number;
      wrongly_owned_objects: number;
    }>(
      `
      with provider_namespaces as (
        select oid from pg_namespace where nspname = any($1::text[])
      )
      select
        (select count(*)::int from information_schema.tables
          where table_schema = any($1::text[]) and table_type = 'BASE TABLE') as tables,
        (select count(*)::int from pg_proc where pronamespace in (select oid from provider_namespaces)) as functions,
        (select count(*)::int from pg_trigger trigger_catalog
          join pg_class relation on relation.oid = trigger_catalog.tgrelid
          where relation.relnamespace in (select oid from provider_namespaces)
            and not trigger_catalog.tgisinternal) as triggers,
        (select count(*)::int from pg_constraint
          where connamespace in (select oid from provider_namespaces) and not convalidated) as invalid_constraints,
        (select count(*)::int from pg_index index_catalog
          join pg_class relation on relation.oid = index_catalog.indrelid
          where relation.relnamespace in (select oid from provider_namespaces)
            and (not index_catalog.indisvalid or not index_catalog.indisready)) as invalid_indexes,
        ((select count(*) from pg_namespace
           where oid in (select oid from provider_namespaces) and nspowner <> current_user::regrole)
         + (select count(*) from pg_class
           where relnamespace in (select oid from provider_namespaces) and relowner <> current_user::regrole)
         + (select count(*) from pg_proc
           where pronamespace in (select oid from provider_namespaces) and proowner <> current_user::regrole)
         + (select count(*) from pg_type
           where typnamespace in (select oid from provider_namespaces) and typowner <> current_user::regrole))::int
          as wrongly_owned_objects
    `,
      [PULSO_PROVIDER_SCHEMAS]
    );
    expect(catalog.rows[0]).toEqual({
      tables: 61,
      functions: 19,
      triggers: 17,
      invalid_constraints: 0,
      invalid_indexes: 0,
      wrongly_owned_objects: 0
    });

    const userSchemas = await migrator.query<{ schema_name: string }>(`
      select schema_name
        from information_schema.schemata
       where schema_name <> 'public'
         and schema_name <> 'information_schema'
         and schema_name not like 'pg\\_%' escape '\\'
       order by schema_name
    `);
    expect(userSchemas.rows.map(({ schema_name }) => schema_name)).toEqual([...PULSO_PROVIDER_SCHEMAS].sort());

    const siblingObjects = await migrator.query<{ identity: string }>(`
      select table_schema || '.' || table_name as identity
        from information_schema.tables
       where table_schema in ('nova', 'lumen', 'audit', 'voice', 'liwa', 'documents')
          or (table_schema = 'platform' and table_name in ('audit_events', 'operator_accounts', 'operator_sessions'))
       order by identity
    `);
    expect(siblingObjects.rows).toEqual([]);
  });

  itReadinessMutation("upgrades an exact managed 003 closure to 004 and rolls the rehearsal back", async () => {
    const migrator = requiredClient(clients, "hyperion_pulso_migrator");
    await assertExactReadinessMutationDatabase(migrator, "hyperion_pulso_migrator");
    const migrationSql = await readFile(
      new URL("../sql/004-access-channel-tenant-projection.sql", import.meta.url),
      "utf8"
    );
    const checksum = computePulsoMigrationChecksum(migrationSql);

    await migrator.query("begin");
    try {
      await migrator.query("delete from pulso_iris.migration_ledger where name = $1", [PULSO_CURRENT_MIGRATION]);
      await migrator.query("drop table channel_runtime.access_projection_inbox");
      await migrator.query("drop table channel_runtime.tenant_snapshots");
      await migrator.query("delete from pulso_iris.service_migrations where version = 4");
      await migrator.query(
        `update pulso_iris.schema_version
            set current_version = 3,
                migration_name = $1,
                updated_at = now()
          where service_name = 'pulso'`,
        [SOFIA_CURRENT_MIGRATION]
      );

      const beforeUpgrade = await inspectPulsoSchema(migrator, "migrator");
      assertPulsoSchemaCompatible(beforeUpgrade);
      expect(beforeUpgrade).toMatchObject({
        state: "managed",
        issues: [],
        currentVersion: 3,
        migrationName: SOFIA_CURRENT_MIGRATION
      });

      await migrator.query(migrationSql);
      await migrator.query("insert into pulso_iris.migration_ledger(name, checksum) values ($1, $2)", [
        PULSO_CURRENT_MIGRATION,
        checksum
      ]);

      const afterUpgrade = await inspectPulsoSchema(migrator, "migrator");
      assertPulsoSchemaCompatible(afterUpgrade);
      expect(afterUpgrade).toMatchObject({
        state: "managed",
        issues: [],
        currentVersion: PULSO_CURRENT_SCHEMA_VERSION,
        migrationName: PULSO_CURRENT_MIGRATION
      });
      const marker = await migrator.query<{ current_version: number; migration_name: string }>(
        "select current_version, migration_name from agent_runtime.schema_version where service_name = 'sofia'"
      );
      expect(marker.rows).toEqual([
        { current_version: SOFIA_CURRENT_SCHEMA_VERSION, migration_name: SOFIA_CURRENT_MIGRATION }
      ]);
    } finally {
      await migrator.query("rollback");
    }
  });

  itReadinessMutation(
    "keeps current SOFIA runtimes ready on the N-1 global marker and fails closed without their local marker",
    async () => {
      const migrator = requiredClient(clients, "hyperion_pulso_migrator");
      await assertExactReadinessMutationDatabase(migrator, "hyperion_pulso_migrator");
      const sofia = requiredClient(clients, "hyperion_sofia");
      const databaseUrl = integrationUrls.hyperion_sofia!;
      const readinessProcesses: ReadinessProcess[] = [];

      try {
        const agent = await startReadinessProcess("agent-service", databaseUrl, await reserveLoopbackPort(), {
          DURABLE_EVENT_TRANSPORT: "http",
          DURABLE_HTTP_OUTBOX_ENABLED: "false",
          SOFIA_WORKER_ENABLED: "false"
        });
        readinessProcesses.push(agent);
        const promptFlow = await startReadinessProcess("prompt-flow-service", databaseUrl, await reserveLoopbackPort());
        readinessProcesses.push(promptFlow);

        await Promise.all([waitForStatus(agent.url, 200, agent), waitForStatus(promptFlow.url, 200, promptFlow)]);

        await migrator.query(
          `update pulso_iris.schema_version
            set current_version = 2,
                migration_name = $1,
                updated_at = now()
          where service_name = 'pulso'`,
          [PULSO_RUNTIME_ROLES_MIGRATION]
        );
        await Promise.all([waitForStatus(agent.url, 200, agent), waitForStatus(promptFlow.url, 200, promptFlow)]);

        const nMinusOneMarker = await sofia.query<{ current_version: number }>(
          "select current_version from pulso_iris.schema_version where service_name = 'pulso'"
        );
        expect(nMinusOneMarker.rows).toEqual([{ current_version: 2 }]);

        await migrator.query("delete from agent_runtime.schema_version where service_name = 'sofia'");
        await Promise.all([waitForStatus(agent.url, 503, agent), waitForStatus(promptFlow.url, 503, promptFlow)]);

        await restoreCurrentReadinessMarkers(migrator);
        await Promise.all([waitForStatus(agent.url, 200, agent), waitForStatus(promptFlow.url, 200, promptFlow)]);
      } finally {
        await cleanupReadinessAcceptance(migrator, readinessProcesses);
      }
    },
    45_000
  );

  for (const role of Object.keys(INTEGRATION_ENVIRONMENT).filter(
    (candidate): candidate is RuntimeRole => candidate !== "hyperion_pulso_migrator"
  )) {
    it(`enforces the exact non-owning ACL and DDL boundary for ${role}`, async () => {
      const client = requiredClient(clients, role);
      const boundary = await assertPulsoRuntimeDatabaseBoundary(client);
      expect(boundary.schema).toMatchObject({
        state: "managed",
        issues: [],
        currentVersion: PULSO_CURRENT_SCHEMA_VERSION,
        migrationName: PULSO_CURRENT_MIGRATION
      });
      expect(boundary.security).toMatchObject({
        role: {
          current_user: role,
          owns_current_database: false,
          owns_other_database: false,
          owns_provider_objects: false,
          owns_unexpected_objects: false,
          can_create_in_database: false,
          can_create_temporary: false,
          public_database_privileges: []
        },
        issues: []
      });

      for (const expectation of TABLE_PRIVILEGE_MATRIX[role]) {
        const privilege = await client.query<{ allowed: boolean }>(
          `select has_table_privilege(current_user, relation.oid, $2) as allowed
             from pg_class relation
             join pg_namespace namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = split_part($1, '.', 1)
              and relation.relname = split_part($1, '.', 2)
              and relation.relkind in ('r', 'p')`,
          [expectation.table, expectation.privilege]
        );
        expect(privilege.rows).toHaveLength(1);
        expect(privilege.rows[0]?.allowed, `${role} ${expectation.privilege} ${expectation.table}`).toBe(
          expectation.allowed
        );
      }

      for (const expectation of FUNCTION_PRIVILEGE_MATRIX[role]) {
        const privilege = await client.query<{ allowed: boolean }>(
          `select has_function_privilege(current_user, procedure.oid, 'EXECUTE') as allowed
             from pg_proc procedure
             join pg_namespace namespace on namespace.oid = procedure.pronamespace
            where namespace.nspname || '.' || procedure.proname ||
                    '(' || oidvectortypes(procedure.proargtypes) || ')' = $1`,
          [expectation.functionName]
        );
        expect(privilege.rows).toHaveLength(1);
        expect(privilege.rows[0]?.allowed, `${role} EXECUTE ${expectation.functionName}`).toBe(expectation.allowed);
      }

      await client.query("begin");
      try {
        await expect(client.query(`create schema autonomy_forbidden_${role}`)).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("rollback");
      }
    });
  }
});

function requiredClient(clients: ReadonlyMap<IntegrationRole, pg.Client>, role: IntegrationRole): pg.Client {
  const client = clients.get(role);
  if (!client) throw new Error(`Missing connected PULSO autonomy client for ${role}`);
  return client;
}

async function assertExactReadinessMutationDatabase(client: pg.Client, role: IntegrationRole): Promise<void> {
  if (!readinessMutationRequired || !readinessMutationDatabase) {
    throw new Error("PULSO readiness mutations require the explicit disposable-database guards");
  }
  const identity = await client.query<{ current_database: string }>("select current_database() as current_database");
  if (identity.rows.length !== 1 || identity.rows[0]?.current_database !== readinessMutationDatabase) {
    throw new Error(
      `${role} is connected to ${identity.rows[0]?.current_database ?? "an unknown database"}; expected the exact disposable database ${readinessMutationDatabase}`
    );
  }
}

interface ReadinessProcess {
  child: ChildProcess;
  output: string[];
  url: string;
}

async function startReadinessProcess(
  service: "agent-service" | "prompt-flow-service",
  databaseUrl: string,
  port: number,
  environment: NodeJS.ProcessEnv = {}
): Promise<ReadinessProcess> {
  const entrypoint = fileURLToPath(new URL(`../../../services/${service}/dist/index.js`, import.meta.url));
  const output: string[] = [];
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      ...environment,
      DATABASE_URL: databaseUrl,
      EXPECTED_DATABASE_ROLE: "hyperion_sofia",
      HOST: "127.0.0.1",
      HYPERION_ENVIRONMENT: "ci",
      NODE_ENV: "test",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  return { child, output, url: `http://127.0.0.1:${port}/ready` };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Could not reserve a loopback port for PULSO readiness acceptance");
  return port;
}

async function waitForStatus(url: string, expectedStatus: number, processState: ReadinessProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  let observed = "no response";
  while (Date.now() < deadline) {
    if (hasProcessExited(processState.child)) {
      throw new Error(`Readiness process exited before ${expectedStatus}: ${processState.output.join("")}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      observed = `${response.status} ${await response.text()}`;
      if (response.status === expectedStatus) return;
    } catch (error) {
      observed = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${url}=${expectedStatus}; observed ${observed}; logs ${processState.output.join("")}`
  );
}

async function restoreCurrentReadinessMarkers(migrator: pg.Client): Promise<void> {
  await assertExactReadinessMutationDatabase(migrator, "hyperion_pulso_migrator");
  await migrator.query(
    `insert into pulso_iris.schema_version(service_name, current_version, migration_name)
     values ('pulso', $1, $2)
     on conflict (service_name) do update set
       current_version = excluded.current_version,
       migration_name = excluded.migration_name,
       updated_at = now()`,
    [PULSO_CURRENT_SCHEMA_VERSION, PULSO_CURRENT_MIGRATION]
  );
  await migrator.query(
    `insert into agent_runtime.schema_version(service_name, current_version, migration_name)
     values ('sofia', $1, $2)
     on conflict (service_name) do update set
       current_version = excluded.current_version,
       migration_name = excluded.migration_name,
       updated_at = now()`,
    [SOFIA_CURRENT_SCHEMA_VERSION, SOFIA_CURRENT_MIGRATION]
  );
}

async function cleanupReadinessAcceptance(migrator: pg.Client, processes: readonly ReadinessProcess[]): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await restoreCurrentReadinessMarkers(migrator);
  } catch (error) {
    cleanupErrors.push(error);
  }

  const processResults = await Promise.allSettled(
    processes.map(async (processState) => stopReadinessProcess(processState))
  );
  for (const result of processResults) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "PULSO readiness acceptance cleanup failed");
  }
}

async function stopReadinessProcess(processState: ReadinessProcess): Promise<void> {
  if (hasProcessExited(processState.child)) return;
  if (await signalAndWaitForProcessExit(processState.child, "SIGTERM", 2_000)) return;
  if (!(await signalAndWaitForProcessExit(processState.child, "SIGKILL", 2_000))) {
    throw new Error(`Could not stop readiness process: ${processState.output.join("")}`);
  }
}

async function signalAndWaitForProcessExit(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number
): Promise<boolean> {
  if (hasProcessExited(child)) return true;
  child.kill(signal);
  const deadline = Date.now() + timeoutMs;
  while (!hasProcessExited(child) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return hasProcessExited(child);
}

function hasProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}
