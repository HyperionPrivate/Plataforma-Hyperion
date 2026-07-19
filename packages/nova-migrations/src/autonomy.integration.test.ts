import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOVA_CELL_DATABASE_ROLES, NOVA_MIGRATOR_ROLE } from "./config.js";
import { assertNovaRuntimeDatabaseBoundary } from "./runtime-boundary.js";

const { Client } = pg;
const adminUrl = process.env.TEST_NOVA_POSTGRES_ADMIN_URL?.trim();
const migratorUrl = process.env.TEST_NOVA_MIGRATOR_DATABASE_URL?.trim();
const databaseName = process.env.TEST_NOVA_POSTGRES_DB?.trim();
const runtimeUrls = new Map([
  ["hyperion_nova", process.env.TEST_NOVA_DATABASE_URL?.trim()],
  ["hyperion_voice", process.env.TEST_VOICE_DATABASE_URL?.trim()],
  ["hyperion_liwa", process.env.TEST_LIWA_DATABASE_URL?.trim()],
  ["hyperion_documents", process.env.TEST_DOCUMENTS_DATABASE_URL?.trim()]
]);
const integration =
  adminUrl && migratorUrl && databaseName && [...runtimeUrls.values()].every(Boolean) ? describe : describe.skip;

integration("NOVA autonomous logical database", () => {
  let admin: InstanceType<typeof Client>;
  let migrator: InstanceType<typeof Client>;
  const runtimes = new Map<string, InstanceType<typeof Client>>();

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    migrator = new Client({ connectionString: migratorUrl });
    for (const [role, url] of runtimeUrls) runtimes.set(role, new Client({ connectionString: url! }));
    await Promise.all([
      admin.connect(),
      migrator.connect(),
      ...[...runtimes.values()].map((client) => client.connect())
    ]);
  });

  afterAll(async () => {
    await Promise.all([migrator?.end(), admin?.end(), ...[...runtimes.values()].map((client) => client.end())]);
  });

  it("uses an isolated database owned by the dedicated NOVA migrator", async () => {
    const database = await admin.query<{ datname: string; owner: string }>(
      "select datname, pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
      [databaseName]
    );
    expect(database.rows).toEqual([{ datname: databaseName, owner: NOVA_MIGRATOR_ROLE }]);

    const identity = await migrator.query<{ database: string; role: string }>(
      "select current_database() as database, current_user as role"
    );
    expect(identity.rows).toEqual([{ database: databaseName, role: NOVA_MIGRATOR_ROLE }]);
  });

  it("activates only the safe NOVA runtime role matrix", async () => {
    const expectedRoles = [NOVA_MIGRATOR_ROLE, ...NOVA_CELL_DATABASE_ROLES.map(({ role }) => role)].sort();
    const result = await admin.query<{
      rolname: string;
      can_login: boolean;
      unsafe_capabilities: boolean;
    }>(
      `select rolname,
              rolcanlogin as can_login,
              (rolsuper or rolcreatedb or rolcreaterole or rolinherit
                or rolreplication or rolbypassrls) as unsafe_capabilities
         from pg_roles
        where rolname = any($1::text[])
        order by rolname`,
      [expectedRoles]
    );
    expect(result.rows.map(({ rolname }) => rolname)).toEqual(expectedRoles);
    expect(result.rows.every(({ can_login, unsafe_capabilities }) => can_login && !unsafe_capabilities)).toBe(true);
    await expect(assertNovaRuntimeDatabaseBoundary(migrator)).resolves.toBeUndefined();
  });

  it("connects every runtime only to its owned schema and denies sibling reads", async () => {
    const ownedTable = new Map([
      ["hyperion_nova", "nova.contacts"],
      ["hyperion_voice", "voice.calls"],
      ["hyperion_liwa", "liwa.messages"],
      ["hyperion_documents", "documents.objects"]
    ]);
    for (const [role, client] of runtimes) {
      const identity = await client.query<{ database: string; role: string }>(
        "select current_database() as database, current_user as role"
      );
      expect(identity.rows).toEqual([{ database: databaseName, role }]);
      await expect(client.query(`select count(*) from ${ownedTable.get(role)}`)).resolves.toBeDefined();
      const sibling = [...ownedTable].find(([otherRole]) => otherRole !== role)?.[1];
      await expect(client.query(`select count(*) from ${sibling}`)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("applies every provider-owned migration without sibling product schemas", async () => {
    const expectedMigrations = readdirSync(fileURLToPath(new URL("../sql/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const migrations = await migrator.query<{ name: string }>("select name from nova.migration_ledger order by name");
    expect(migrations.rows.map(({ name }) => name)).toEqual(expectedMigrations);

    const ownedSchemas = await migrator.query<{ schema_name: string; owner: string }>(
      `select nspname as schema_name, pg_get_userbyid(nspowner) as owner
         from pg_namespace
        where nspname = any($1::text[])
        order by nspname`,
      [["nova", "voice", "liwa", "documents"]]
    );
    expect(ownedSchemas.rows.map(({ schema_name }) => schema_name)).toEqual(["documents", "liwa", "nova", "voice"]);
    expect(ownedSchemas.rows.every(({ owner }) => owner === NOVA_MIGRATOR_ROLE)).toBe(true);

    const siblingSchemas = await migrator.query<{ schema_name: string }>(
      `select schema_name
         from information_schema.schemata
        where schema_name = any($1::text[])`,
      [["lumen", "pulso_iris", "sofia", "integration"]]
    );
    expect(siblingSchemas.rows).toEqual([]);
  });
});
