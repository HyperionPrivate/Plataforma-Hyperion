import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertLumenMigratorDatabaseSecurity, assertLumenRuntimeDatabaseBoundary } from "./schema-manifest.js";

const ADMIN_URL = process.env.TEST_LUMEN_MIGRATOR_DATABASE_URL;
const RUNTIME_URL = process.env.TEST_LUMEN_DATABASE_URL;
const describeIntegration = ADMIN_URL && RUNTIME_URL ? describe : describe.skip;
const { Client } = pg;

describeIntegration("LUMEN autonomous PostgreSQL closure", () => {
  let admin: pg.Client;
  let runtime: pg.Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    runtime = new Client({ connectionString: RUNTIME_URL });
    await admin.connect();
    await runtime.connect();
  });

  afterAll(async () => {
    await Promise.all([admin?.end(), runtime?.end()]);
  });

  it("materializes the complete v40 provider catalog without sibling schemas", async () => {
    const migratorSecurity = await assertLumenMigratorDatabaseSecurity(admin);
    expect(migratorSecurity).toMatchObject({
      current_user: "hyperion_lumen_migrator",
      owns_current_database: true,
      owns_lumen_objects: true,
      owns_non_lumen_objects: false
    });

    const catalog = await admin.query<{
      tables: number;
      functions: number;
      triggers: number;
      invalid_constraints: number;
      invalid_indexes: number;
      current_version: number;
    }>(`
      select
        (select count(*)::int from information_schema.tables
          where table_schema = 'lumen' and table_type = 'BASE TABLE'
            and table_name <> 'migration_ledger') as tables,
        (select count(*)::int from pg_proc procedure
          join pg_namespace namespace on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'lumen') as functions,
        (select count(*)::int from pg_trigger trigger_catalog
          join pg_class table_catalog on table_catalog.oid = trigger_catalog.tgrelid
          join pg_namespace namespace on namespace.oid = table_catalog.relnamespace
          where namespace.nspname = 'lumen' and not trigger_catalog.tgisinternal) as triggers,
        (select count(*)::int from pg_constraint constraint_catalog
          join pg_class table_catalog on table_catalog.oid = constraint_catalog.conrelid
          join pg_namespace namespace on namespace.oid = table_catalog.relnamespace
          where namespace.nspname = 'lumen' and not constraint_catalog.convalidated) as invalid_constraints,
        (select count(*)::int from pg_index index_catalog
          join pg_class table_catalog on table_catalog.oid = index_catalog.indrelid
          join pg_namespace namespace on namespace.oid = table_catalog.relnamespace
          where namespace.nspname = 'lumen'
            and (not index_catalog.indisvalid or not index_catalog.indisready)) as invalid_indexes,
        (select current_version::int from lumen.schema_version where service_name = 'lumen') as current_version
    `);
    expect(catalog.rows[0]).toEqual({
      tables: 15,
      functions: 9,
      triggers: 9,
      invalid_constraints: 0,
      invalid_indexes: 0,
      current_version: 40
    });

    const siblingSchemas = await admin.query<{ schema_name: string }>(
      `select schema_name from information_schema.schemata
        where schema_name in ('platform', 'pulso_iris', 'nova', 'voice', 'liwa', 'documents')`
    );
    expect(siblingSchemas.rows).toEqual([]);
  });

  it("activates only the non-owning LUMEN runtime with no ledger or DDL authority", async () => {
    const boundary = await assertLumenRuntimeDatabaseBoundary(runtime);
    expect(boundary.schema).toMatchObject({
      state: "managed",
      currentVersion: 40,
      migrationName: "002-lumen-runtime-role.sql"
    });
    expect(boundary.security.issues).toEqual([]);

    const privileges = await runtime.query<{
      current_user: string;
      can_read_version: boolean;
      can_write_clinical: boolean;
      can_write_migration_ledger: boolean;
      can_read_n1_admin: boolean;
      can_create_schema: boolean;
    }>(`
      select current_user,
        has_table_privilege(current_user, 'lumen.schema_version', 'select') as can_read_version,
        has_table_privilege(current_user, 'lumen.clinical_records', 'insert') as can_write_clinical,
        has_table_privilege(current_user, 'lumen.migration_ledger', 'insert') as can_write_migration_ledger,
        has_table_privilege(current_user, 'lumen.n_minus_one_compatibility_windows', 'select') as can_read_n1_admin,
        has_database_privilege(current_user, current_database(), 'create') as can_create_schema
    `);
    expect(privileges.rows[0]).toEqual({
      current_user: "hyperion_lumen",
      can_read_version: true,
      can_write_clinical: true,
      can_write_migration_ledger: false,
      can_read_n1_admin: false,
      can_create_schema: false
    });
    await expect(runtime.query("create schema platform")).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects and recovers from direct column-level ACL drift", async () => {
    await admin.query("grant update(name) on lumen.service_migrations to hyperion_lumen");
    try {
      await expect(assertLumenRuntimeDatabaseBoundary(runtime)).rejects.toThrow(
        "unexpected runtime ACL object column:service_migrations.name"
      );
    } finally {
      await admin.query("revoke update(name) on lumen.service_migrations from hyperion_lumen");
    }
    await expect(assertLumenRuntimeDatabaseBoundary(runtime)).resolves.toMatchObject({
      schema: { state: "managed" },
      security: { issues: [] }
    });
  });
});
