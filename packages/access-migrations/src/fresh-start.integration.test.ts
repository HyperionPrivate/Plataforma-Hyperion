import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCESS_MIGRATOR_ROLE, ACCESS_RUNTIME_DATABASE_ROLES } from "./config.js";
import { assertAccessRuntimeDatabaseBoundary } from "./runtime-boundary.js";

const { Client } = pg;
const adminUrl = process.env.TEST_ACCESS_POSTGRES_ADMIN_URL?.trim();
const migratorUrl = process.env.TEST_ACCESS_MIGRATOR_DATABASE_URL?.trim();
const identityUrl = process.env.TEST_IDENTITY_DATABASE_URL?.trim();
const tenantUrl = process.env.TEST_TENANT_DATABASE_URL?.trim();
const databaseName = process.env.TEST_ACCESS_POSTGRES_DB?.trim();
const integration = adminUrl && migratorUrl && identityUrl && tenantUrl && databaseName ? describe : describe.skip;

integration("Access provider fresh-start autonomy", () => {
  let admin: InstanceType<typeof Client>;
  let migrator: InstanceType<typeof Client>;
  let identity: InstanceType<typeof Client>;
  let tenant: InstanceType<typeof Client>;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    migrator = new Client({ connectionString: migratorUrl });
    identity = new Client({ connectionString: identityUrl });
    tenant = new Client({ connectionString: tenantUrl });
    await Promise.all([admin.connect(), migrator.connect(), identity.connect(), tenant.connect()]);
  });

  afterAll(async () => {
    await Promise.all([admin?.end(), migrator?.end(), identity?.end(), tenant?.end()]);
  });

  it("owns one isolated logical database with the exact safe role matrix", async () => {
    const database = await admin.query<{ datname: string; owner: string }>(
      "select datname, pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
      [databaseName]
    );
    expect(database.rows).toEqual([{ datname: databaseName, owner: ACCESS_MIGRATOR_ROLE }]);

    const expectedRoles = [ACCESS_MIGRATOR_ROLE, ...ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role)].sort();
    const roles = await admin.query<{
      rolname: string;
      can_login: boolean;
      unsafe_capabilities: boolean;
      has_memberships: boolean;
    }>(
      `select role.rolname,
              role.rolcanlogin as can_login,
              (role.rolsuper or role.rolcreatedb or role.rolcreaterole or role.rolinherit
                or role.rolreplication or role.rolbypassrls) as unsafe_capabilities,
              exists (
                select 1 from pg_auth_members membership
                 where membership.member = role.oid or membership.roleid = role.oid
              ) as has_memberships
         from pg_roles role
        where role.rolname = any($1::text[])
        order by role.rolname`,
      [expectedRoles]
    );
    expect(roles.rows.map(({ rolname }) => rolname)).toEqual(expectedRoles);
    expect(
      roles.rows.every(
        ({ can_login, unsafe_capabilities, has_memberships }) => can_login && !unsafe_capabilities && !has_memberships
      )
    ).toBe(true);
  });

  it("creates only the provider-owned Access closure from an empty database", async () => {
    const expectedMigrations = readdirSync(fileURLToPath(new URL("../sql/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const migrations = await migrator.query<{ name: string }>(
      "select name from access_runtime.migration_ledger order by name"
    );
    expect(migrations.rows.map(({ name }) => name)).toEqual(expectedMigrations);

    const tables = await migrator.query<{ table_name: string; table_schema: string }>(
      `select table_schema, table_name
         from information_schema.tables
        where table_schema = any($1::text[])
          and table_type = 'BASE TABLE'
        order by table_schema, table_name`,
      [["platform", "access_runtime"]]
    );
    expect(tables.rows).toEqual([
      { table_schema: "access_runtime", table_name: "bootstrap_tenants" },
      { table_schema: "access_runtime", table_name: "lumen_projection_outbox" },
      { table_schema: "access_runtime", table_name: "lumen_projection_state" },
      { table_schema: "access_runtime", table_name: "migration_ledger" },
      { table_schema: "access_runtime", table_name: "product_grants" },
      { table_schema: "access_runtime", table_name: "tenant_projection_outbox" },
      { table_schema: "access_runtime", table_name: "tenant_projection_state" },
      { table_schema: "platform", table_name: "access_token_denylist" },
      { table_schema: "platform", table_name: "operator_sessions" },
      { table_schema: "platform", table_name: "operator_tenants" },
      { table_schema: "platform", table_name: "operators" },
      { table_schema: "platform", table_name: "tenants" }
    ]);

    const siblingSchemas = await migrator.query<{ schema_name: string }>(
      `select schema_name from information_schema.schemata
        where schema_name = any($1::text[])`,
      [["audit_runtime", "lumen", "pulso_iris", "nova", "voice", "liwa", "documents"]]
    );
    expect(siblingSchemas.rows).toEqual([]);

    const ownership = await migrator.query<{ object_name: string; owner: string }>(
      `select namespace.nspname || '.' || object_catalog.relname as object_name,
              pg_get_userbyid(object_catalog.relowner) as owner
         from pg_class object_catalog
         join pg_namespace namespace on namespace.oid = object_catalog.relnamespace
        where namespace.nspname = any($1::text[])
          and object_catalog.relkind in ('r', 'i', 'S')
        order by object_name`,
      [["platform", "access_runtime"]]
    );
    expect(ownership.rows.length).toBeGreaterThan(9);
    expect(ownership.rows.every(({ owner }) => owner === ACCESS_MIGRATOR_ROLE)).toBe(true);

    const schemaOwnership = await migrator.query<{ owner: string; schema_name: string }>(
      `select namespace.nspname as schema_name, pg_get_userbyid(namespace.nspowner) as owner
         from pg_namespace namespace
        where namespace.nspname = any($1::text[])
        order by schema_name`,
      [["platform", "access_runtime"]]
    );
    expect(schemaOwnership.rows).toEqual([
      { schema_name: "access_runtime", owner: ACCESS_MIGRATOR_ROLE },
      { schema_name: "platform", owner: ACCESS_MIGRATOR_ROLE }
    ]);
    const routineOwnership = await migrator.query<{
      configuration: string[] | null;
      owner: string;
      routine_name: string;
    }>(
      `select routine_catalog.proname as routine_name,
              pg_get_userbyid(routine_catalog.proowner) as owner,
              routine_catalog.proconfig as configuration
         from pg_proc routine_catalog
         join pg_namespace namespace on namespace.oid = routine_catalog.pronamespace
        where namespace.nspname = 'access_runtime'
          and routine_catalog.proname = any($1::text[])
        order by routine_name`,
      [["enforce_tenant_lifecycle_v1", "valid_grant_values"]]
    );
    expect(routineOwnership.rows).toEqual([
      {
        routine_name: "enforce_tenant_lifecycle_v1",
        owner: ACCESS_MIGRATOR_ROLE,
        configuration: ["search_path=pg_catalog"]
      },
      { routine_name: "valid_grant_values", owner: ACCESS_MIGRATOR_ROLE, configuration: null }
    ]);

    const lifecycleTrigger = await migrator.query<{ definition: string; enabled: string; trigger_name: string }>(
      `select trigger_catalog.tgname as trigger_name,
              pg_get_triggerdef(trigger_catalog.oid) as definition,
              trigger_catalog.tgenabled as enabled
         from pg_trigger trigger_catalog
        where trigger_catalog.tgrelid = 'platform.tenants'::regclass
          and not trigger_catalog.tgisinternal`
    );
    expect(lifecycleTrigger.rows).toHaveLength(1);
    expect(lifecycleTrigger.rows[0]?.trigger_name).toBe("trg_access_tenant_lifecycle_v1");
    expect(lifecycleTrigger.rows[0]?.enabled).toBe("A");
    expect(lifecycleTrigger.rows[0]?.definition).toContain("BEFORE INSERT OR DELETE OR UPDATE");
  });

  it("advances every tenant source watermark and rejects hard deletion before cascades", async () => {
    const tenantId = "00000000-0000-4000-8000-00000000f004";
    await migrator.query("begin");
    try {
      const inserted = await migrator.query<{ normalized: boolean; source_updated_at: string }>(
        `insert into platform.tenants (id, slug, display_name, updated_at)
         values ($1, 'access-lifecycle-integrity', 'Access Lifecycle Integrity', '2000-01-01T00:00:00Z')
         returning updated_at > '2000-01-01T00:00:00Z'::timestamptz as normalized,
                   updated_at::text as source_updated_at`,
        [tenantId]
      );
      expect(inserted.rows[0]?.normalized).toBe(true);

      const firstWatermark = inserted.rows[0]?.source_updated_at;
      const updated = await migrator.query<{ advanced: boolean; source_updated_at: string }>(
        `update platform.tenants
            set status = 'paused', updated_at = '1999-01-01T00:00:00Z'
          where id = $1
          returning updated_at > $2::timestamptz as advanced, updated_at::text as source_updated_at`,
        [tenantId, firstWatermark]
      );
      expect(updated.rows).toHaveLength(1);
      expect(updated.rows[0]?.advanced).toBe(true);

      const secondWatermark = updated.rows[0]?.source_updated_at;
      const repeated = await migrator.query<{ advanced: boolean }>(
        `update platform.tenants set updated_at = updated_at
          where id = $1
          returning updated_at > $2::timestamptz as advanced`,
        [tenantId, secondWatermark]
      );
      expect(repeated.rows).toEqual([{ advanced: true }]);

      await migrator.query("savepoint hard_delete_probe");
      await expect(migrator.query("delete from platform.tenants where id = $1", [tenantId])).rejects.toMatchObject({
        code: "55000",
        message: "platform.tenants hard delete is disabled while access.tenant.snapshot.v1 has no tombstone"
      });
      await migrator.query("rollback to savepoint hard_delete_probe");
      const retained = await migrator.query<{ retained: boolean }>(
        "select exists(select 1 from platform.tenants where id = $1) as retained",
        [tenantId]
      );
      expect(retained.rows).toEqual([{ retained: true }]);
    } finally {
      await migrator.query("rollback");
    }
  });

  it("gives Identity its effective CRUD and denies migration or tenant-provisioning authority", async () => {
    const privileges = await identity.query<{
      can_create_database_objects: boolean;
      can_use_temporary_tables: boolean;
      can_insert_tenants: boolean;
      can_delete_grants: boolean;
      can_write_ledger: boolean;
    }>(`
      select
        has_database_privilege(current_user, current_database(), 'create') as can_create_database_objects,
        has_database_privilege(current_user, current_database(), 'temporary') as can_use_temporary_tables,
        has_table_privilege(current_user, 'platform.tenants', 'insert') as can_insert_tenants,
        has_table_privilege(current_user, 'access_runtime.product_grants', 'delete') as can_delete_grants,
        has_table_privilege(current_user, 'access_runtime.migration_ledger', 'insert') as can_write_ledger
    `);
    expect(privileges.rows[0]).toEqual({
      can_create_database_objects: false,
      can_use_temporary_tables: false,
      can_insert_tenants: false,
      can_delete_grants: true,
      can_write_ledger: false
    });

    const grants = await migrator.query<{ grantee: string; privilege: string; relation: string }>(
      `select grantee, table_schema || '.' || table_name as relation, privilege_type as privilege
         from information_schema.role_table_grants
        where grantee = any($1::text[])
          and table_schema = any($2::text[])
        order by grantee, relation, privilege`,
      [
        ["hyperion_identity", "hyperion_tenant"],
        ["platform", "access_runtime"]
      ]
    );
    expect(grants.rows).toEqual([
      { grantee: "hyperion_identity", relation: "access_runtime.bootstrap_tenants", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "access_runtime.lumen_projection_outbox", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "access_runtime.lumen_projection_outbox", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "access_runtime.lumen_projection_outbox", privilege: "UPDATE" },
      { grantee: "hyperion_identity", relation: "access_runtime.lumen_projection_state", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "access_runtime.lumen_projection_state", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "access_runtime.lumen_projection_state", privilege: "UPDATE" },
      { grantee: "hyperion_identity", relation: "access_runtime.migration_ledger", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "access_runtime.product_grants", privilege: "DELETE" },
      { grantee: "hyperion_identity", relation: "access_runtime.product_grants", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "access_runtime.product_grants", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "access_runtime.product_grants", privilege: "UPDATE" },
      { grantee: "hyperion_identity", relation: "access_runtime.tenant_projection_outbox", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "access_runtime.tenant_projection_outbox", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "access_runtime.tenant_projection_outbox", privilege: "UPDATE" },
      { grantee: "hyperion_identity", relation: "access_runtime.tenant_projection_state", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "access_runtime.tenant_projection_state", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "access_runtime.tenant_projection_state", privilege: "UPDATE" },
      { grantee: "hyperion_identity", relation: "platform.access_token_denylist", privilege: "DELETE" },
      { grantee: "hyperion_identity", relation: "platform.access_token_denylist", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "platform.access_token_denylist", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "platform.operator_sessions", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "platform.operator_sessions", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "platform.operator_sessions", privilege: "UPDATE" },
      { grantee: "hyperion_identity", relation: "platform.operator_tenants", privilege: "DELETE" },
      { grantee: "hyperion_identity", relation: "platform.operator_tenants", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "platform.operator_tenants", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "platform.operators", privilege: "INSERT" },
      { grantee: "hyperion_identity", relation: "platform.operators", privilege: "SELECT" },
      { grantee: "hyperion_identity", relation: "platform.operators", privilege: "UPDATE" },
      { grantee: "hyperion_identity", relation: "platform.tenants", privilege: "SELECT" },
      { grantee: "hyperion_tenant", relation: "access_runtime.migration_ledger", privilege: "SELECT" },
      { grantee: "hyperion_tenant", relation: "platform.tenants", privilege: "SELECT" }
    ]);

    await identity.query("begin");
    try {
      const operatorId = "11111111-1111-4111-8111-111111111111";
      const controlTenantId = "00000000-0000-4000-8000-000000000001";
      await identity.query(
        `insert into platform.operators (id, email, display_name, role)
         values ($1, 'fresh-start@example.com', 'Fresh Start', 'admin')`,
        [operatorId]
      );
      await identity.query("insert into platform.operator_tenants (operator_id, tenant_id) values ($1, $2)", [
        operatorId,
        controlTenantId
      ]);
      await identity.query(
        `insert into access_runtime.product_grants
           (operator_id, tenant_id, product_id, roles, capabilities, granted_by)
         values ($1, $2, 'PLATFORM', array['platform-admin'], array['manage:platform'], $1)`,
        [operatorId, controlTenantId]
      );
      const removed = await identity.query(
        `delete from access_runtime.product_grants
          where operator_id = $1 and tenant_id = $2 and product_id = 'PLATFORM'
          returning operator_id`,
        [operatorId, controlTenantId]
      );
      expect(removed.rows).toHaveLength(1);
    } finally {
      await identity.query("rollback");
    }

    await expect(
      identity.query("insert into access_runtime.migration_ledger values ('forbidden', repeat('a', 64))")
    ).rejects.toMatchObject({ code: "42501" });
    await expect(identity.query("create schema forbidden_identity")).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps Tenant read-only and unable to inspect operator identity data", async () => {
    const identity = await tenant.query<{ current_role: string }>("select current_user as current_role");
    expect(identity.rows).toEqual([{ current_role: "hyperion_tenant" }]);
    const controlTenant = await tenant.query<{ id: string }>(
      "select id::text from platform.tenants where id = '00000000-0000-4000-8000-000000000001'::uuid"
    );
    expect(controlTenant.rows).toHaveLength(1);

    await expect(tenant.query("select id from platform.operators limit 1")).rejects.toMatchObject({ code: "42501" });
    await expect(
      tenant.query("insert into platform.tenants (slug, display_name) values ('forbidden-tenant', 'Forbidden')")
    ).rejects.toMatchObject({ code: "42501" });
    await expect(tenant.query("create schema forbidden_tenant")).rejects.toMatchObject({ code: "42501" });
  });

  it("passes the same structural and ACL boundary probes used by service readiness", async () => {
    await expect(assertAccessRuntimeDatabaseBoundary(identity, "hyperion_identity")).resolves.toBeUndefined();
    await expect(assertAccessRuntimeDatabaseBoundary(tenant, "hyperion_tenant")).resolves.toBeUndefined();
  });
});
