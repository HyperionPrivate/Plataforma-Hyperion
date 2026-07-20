import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createService, type SchemaVersionRequirement, type ServiceHandle } from "./index.js";

// This is a frozen contract fixture, not proof that a previously published OCI
// image was executed. It keeps the former 002 readiness behavior executable
// until an immutable N-1 image and digest are available for a real rehearsal.
const FROZEN_002_SOFIA_REQUIREMENT = Object.freeze<SchemaVersionRequirement>({
  schema: "pulso_iris",
  serviceName: "pulso",
  minimumVersion: 2
});
const CURRENT_SOFIA_REQUIREMENT = Object.freeze<SchemaVersionRequirement>({
  schema: "agent_runtime",
  serviceName: "sofia",
  minimumVersion: 2
});
const CURRENT_PULSO_MARKER = Object.freeze({
  currentVersion: 6,
  migrationName: "006-access-sofia-tenant-projection.sql"
});
const CURRENT_SOFIA_MARKER = Object.freeze({
  currentVersion: 2,
  migrationName: "006-access-sofia-tenant-projection.sql"
});

const migratorUrl = process.env.TEST_PULSO_MIGRATOR_DATABASE_URL?.trim();
const sofiaUrl = process.env.TEST_SOFIA_DATABASE_URL?.trim();
const expectedDatabaseName = process.env.SOFIA_N_MINUS_ONE_FIXTURE_DATABASE_NAME?.trim();
const configuredUrlCount = [migratorUrl, sofiaUrl].filter(Boolean).length;
const fixtureRequired = process.env.REQUIRE_SOFIA_N_MINUS_ONE_FIXTURE?.trim() === "1";

if ((fixtureRequired && configuredUrlCount !== 2) || (configuredUrlCount !== 0 && configuredUrlCount !== 2)) {
  throw new Error(
    "Incomplete SOFIA N-1 readiness fixture configuration; TEST_PULSO_MIGRATOR_DATABASE_URL and TEST_SOFIA_DATABASE_URL are both required"
  );
}
if (
  configuredUrlCount === 2 &&
  (!expectedDatabaseName || !/^hyperion_pulso_n1_fixture_[a-z0-9_]{1,34}$/.test(expectedDatabaseName))
) {
  throw new Error(
    "SOFIA_N_MINUS_ONE_FIXTURE_DATABASE_NAME must explicitly identify a hyperion_pulso_n1_fixture_* database"
  );
}

const describeIntegration = configuredUrlCount === 2 ? describe : describe.skip;

interface MarkerRow {
  current_version: number;
  migration_name: string;
  updated_at: Date;
}

interface ReadinessDependency {
  detail?: string;
  name: string;
  status: "degraded" | "down" | "ok";
}

interface ReadinessBody {
  dependencies: ReadinessDependency[];
  service: string;
  status: "degraded" | "down" | "ok";
}

const ENVIRONMENT_KEYS = [
  "DATABASE_URL",
  "EXPECTED_DATABASE_ROLE",
  "HYPERION_ENVIRONMENT",
  "NODE_ENV",
  "DURABLE_EVENT_TRANSPORT",
  "REQUIRE_SOFIA_N_MINUS_ONE_FIXTURE",
  "SOFIA_N_MINUS_ONE_FIXTURE_DATABASE_NAME"
] as const;

describeIntegration("SOFIA N-1 readiness contract fixture (not an old-image rehearsal)", () => {
  const originalEnvironment = new Map<string, string | undefined>();
  let migrator: DatabaseClient | undefined;
  let sofia: DatabaseClient | undefined;
  let frozen002Service: ServiceHandle | undefined;
  let currentService: ServiceHandle | undefined;
  let restoreGlobalMarker = false;
  let restoreLocalMarker = false;
  let originalGlobalMarker: MarkerRow | undefined;
  let originalLocalMarker: MarkerRow | undefined;

  beforeAll(async () => {
    for (const key of ENVIRONMENT_KEYS) originalEnvironment.set(key, process.env[key]);
    process.env.DATABASE_URL = requiredUrl(sofiaUrl, "TEST_SOFIA_DATABASE_URL");
    process.env.EXPECTED_DATABASE_ROLE = "hyperion_sofia";
    process.env.HYPERION_ENVIRONMENT = "ci";
    process.env.NODE_ENV = "test";
    process.env.DURABLE_EVENT_TRANSPORT = "http";

    migrator = createDatabase(requiredUrl(migratorUrl, "TEST_PULSO_MIGRATOR_DATABASE_URL"));
    sofia = createDatabase(requiredUrl(sofiaUrl, "TEST_SOFIA_DATABASE_URL"));

    const databaseIdentity = await migrator.query<{ current_database: string; server_version_num: number }>(
      "select current_database(), current_setting('server_version_num')::int as server_version_num"
    );
    const databaseIdentityRow = requiredRow(databaseIdentity.rows, "PostgreSQL identity");
    expect(databaseIdentityRow.current_database).toBe(
      requiredUrl(expectedDatabaseName, "SOFIA_N_MINUS_ONE_FIXTURE_DATABASE_NAME")
    );
    expect(Math.floor(databaseIdentityRow.server_version_num / 10_000)).toBe(16);
    originalGlobalMarker = await readGlobalMarker(migrator);
    expect(originalGlobalMarker).toMatchObject({
      current_version: CURRENT_PULSO_MARKER.currentVersion,
      migration_name: CURRENT_PULSO_MARKER.migrationName
    });
    originalLocalMarker = await readLocalMarker(migrator);
    expect(originalLocalMarker).toMatchObject({
      current_version: CURRENT_SOFIA_MARKER.currentVersion,
      migration_name: CURRENT_SOFIA_MARKER.migrationName
    });

    const runtimeBoundary = await sofia.query<{
      can_read_global: boolean;
      can_read_local: boolean;
      current_user: string;
      session_user: string;
    }>(`
      select current_user,
             session_user,
             has_table_privilege(current_user, 'pulso_iris.schema_version', 'SELECT') as can_read_global,
             has_table_privilege(current_user, 'agent_runtime.schema_version', 'SELECT') as can_read_local
    `);
    expect(runtimeBoundary.rows).toEqual([
      {
        can_read_global: true,
        can_read_local: true,
        current_user: "hyperion_sofia",
        session_user: "hyperion_sofia"
      }
    ]);

    frozen002Service = await createService({
      serviceName: "agent-service",
      databaseRequired: true,
      requiredSchemaVersion: FROZEN_002_SOFIA_REQUIREMENT
    });
    currentService = await createService({
      serviceName: "prompt-flow-service",
      databaseRequired: true,
      requiredSchemaVersion: CURRENT_SOFIA_REQUIREMENT
    });
  }, 30_000);

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      if (migrator && restoreGlobalMarker) {
        try {
          await writeGlobalMarker(migrator, requiredMarker(originalGlobalMarker, "global PULSO marker"));
          restoreGlobalMarker = false;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (migrator && restoreLocalMarker) {
        try {
          await writeLocalMarker(migrator, requiredMarker(originalLocalMarker, "local SOFIA marker"));
          restoreLocalMarker = false;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      for (const close of [
        () => frozen002Service?.app.close(),
        () => currentService?.app.close(),
        () => sofia?.close(),
        () => migrator?.close()
      ]) {
        try {
          await close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } finally {
      for (const key of ENVIRONMENT_KEYS) restoreEnvironment(key, originalEnvironment.get(key));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "SOFIA N-1 readiness fixture cleanup failed");
    }
  });

  it("keeps the frozen 002 and current markers independent through the 004 expansion", async () => {
    const frozenInitial = await injectReadiness(requiredHandle(frozen002Service, "frozen 002"));
    expectReadiness(frozenInitial, 200, "ok", "pulso_iris.schema_version", "ok", "schema version >= 2");

    const currentInitial = await injectReadiness(requiredHandle(currentService, "current"));
    expectReadiness(currentInitial, 200, "ok", "agent_runtime.schema_version", "ok", "schema version >= 2");

    restoreGlobalMarker = true;
    await requiredDatabase(migrator, "migrator").query(
      `update pulso_iris.schema_version
          set current_version = 1,
              updated_at = now()
        where service_name = 'pulso'`
    );
    try {
      const frozenWithStaleGlobal = await injectReadiness(requiredHandle(frozen002Service, "frozen 002"));
      expectReadiness(
        frozenWithStaleGlobal,
        503,
        "down",
        "pulso_iris.schema_version",
        "down",
        "schema version 1 is below required 2"
      );

      const currentWithStaleGlobal = await injectReadiness(requiredHandle(currentService, "current"));
      expectReadiness(currentWithStaleGlobal, 200, "ok", "agent_runtime.schema_version", "ok", "schema version >= 2");
    } finally {
      await writeGlobalMarker(
        requiredDatabase(migrator, "migrator"),
        requiredMarker(originalGlobalMarker, "global PULSO marker")
      );
      restoreGlobalMarker = false;
    }

    expect(await readGlobalMarker(requiredDatabase(migrator, "migrator"))).toEqual(originalGlobalMarker);

    restoreLocalMarker = true;
    await requiredDatabase(migrator, "migrator").query(
      "delete from agent_runtime.schema_version where service_name = 'sofia'"
    );
    try {
      const currentWithoutLocal = await injectReadiness(requiredHandle(currentService, "current"));
      expectReadiness(
        currentWithoutLocal,
        503,
        "down",
        "agent_runtime.schema_version",
        "down",
        "schema version is missing; require >= 2"
      );

      const frozenWithCurrentGlobal = await injectReadiness(requiredHandle(frozen002Service, "frozen 002"));
      expectReadiness(frozenWithCurrentGlobal, 200, "ok", "pulso_iris.schema_version", "ok", "schema version >= 2");
    } finally {
      await writeLocalMarker(
        requiredDatabase(migrator, "migrator"),
        requiredMarker(originalLocalMarker, "local SOFIA marker")
      );
      restoreLocalMarker = false;
    }

    expect(await readLocalMarker(requiredDatabase(migrator, "migrator"))).toEqual(originalLocalMarker);
    const currentRestored = await injectReadiness(requiredHandle(currentService, "current"));
    expectReadiness(currentRestored, 200, "ok", "agent_runtime.schema_version", "ok", "schema version >= 2");
  }, 60_000);
});

async function injectReadiness(handle: ServiceHandle): Promise<{ body: ReadinessBody; statusCode: number }> {
  const response = await handle.app.inject({ method: "GET", url: "/ready" });
  return { body: response.json<ReadinessBody>(), statusCode: response.statusCode };
}

function expectReadiness(
  response: { body: ReadinessBody; statusCode: number },
  expectedCode: number,
  expectedStatus: ReadinessBody["status"],
  markerName: string,
  markerStatus: ReadinessDependency["status"],
  markerDetail: string
): void {
  expect(response.statusCode).toBe(expectedCode);
  expect(response.body.status).toBe(expectedStatus);
  expect(response.body.dependencies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "postgres", status: "ok" }),
      expect.objectContaining({
        name: "postgres_role",
        status: "ok",
        detail: "connected as hyperion_sofia"
      }),
      expect.objectContaining({ name: markerName, status: markerStatus, detail: markerDetail })
    ])
  );
  expect(response.body.dependencies.filter(({ name }) => name.endsWith(".schema_version"))).toEqual([
    expect.objectContaining({ name: markerName, status: markerStatus, detail: markerDetail })
  ]);
}

async function readGlobalMarker(database: DatabaseClient): Promise<MarkerRow> {
  const result = await database.query<MarkerRow>(
    "select current_version, migration_name, updated_at from pulso_iris.schema_version where service_name = 'pulso'"
  );
  return requiredRow(result.rows, "global PULSO marker");
}

async function readLocalMarker(database: DatabaseClient): Promise<MarkerRow> {
  const result = await database.query<MarkerRow>(
    "select current_version, migration_name, updated_at from agent_runtime.schema_version where service_name = 'sofia'"
  );
  return requiredRow(result.rows, "local SOFIA marker");
}

async function writeGlobalMarker(database: DatabaseClient, marker: Readonly<MarkerRow>): Promise<void> {
  await database.query(
    `insert into pulso_iris.schema_version(service_name, current_version, migration_name, updated_at)
     values ('pulso', $1, $2, $3)
     on conflict (service_name) do update
       set current_version = excluded.current_version,
           migration_name = excluded.migration_name,
           updated_at = excluded.updated_at`,
    [marker.current_version, marker.migration_name, marker.updated_at]
  );
}

async function writeLocalMarker(database: DatabaseClient, marker: Readonly<MarkerRow>): Promise<void> {
  await database.query(
    `insert into agent_runtime.schema_version(service_name, current_version, migration_name, updated_at)
     values ('sofia', $1, $2, $3)
     on conflict (service_name) do update
       set current_version = excluded.current_version,
           migration_name = excluded.migration_name,
           updated_at = excluded.updated_at`,
    [marker.current_version, marker.migration_name, marker.updated_at]
  );
}

function requiredRow<T>(rows: readonly T[], label: string): T {
  expect(rows, `${label} must contain exactly one row`).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error(`${label} is missing`);
  return row;
}

function requiredUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredDatabase(database: DatabaseClient | undefined, label: string): DatabaseClient {
  if (!database) throw new Error(`${label} database is unavailable`);
  return database;
}

function requiredMarker(marker: MarkerRow | undefined, label: string): MarkerRow {
  if (!marker) throw new Error(`${label} snapshot is unavailable`);
  return marker;
}

function requiredHandle(handle: ServiceHandle | undefined, label: string): ServiceHandle {
  if (!handle) throw new Error(`${label} service is unavailable`);
  return handle;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
