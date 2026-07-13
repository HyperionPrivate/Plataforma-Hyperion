import pg from "pg";
import { describe, expect, it } from "vitest";
import { SERVICE_DATABASE_ROLES } from "./bootstrap-roles.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const verifyNoLogin = process.env.EXPECT_SERVICE_ROLES_NOLOGIN === "true";
const describeIntegration = TEST_DATABASE_URL && verifyNoLogin ? describe : describe.skip;

describeIntegration("024 service roles before Compose bootstrap", () => {
  it("creates NOLOGIN identities and applies grants instead of recording a no-op", async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      const migration = await admin.query<{ count: number }>(
        `select count(*)::int as count
           from platform.schema_migrations
          where name = '024-service-database-roles.sql'`
      );
      expect(migration.rows[0]?.count).toBe(1);

      const roles = await admin.query<{
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolname: string;
        rolsuper: boolean;
      }>(
        `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit
           from pg_roles
          where rolname = any($1::text[])
          order by rolname`,
        [SERVICE_DATABASE_ROLES.map((definition) => definition.role)]
      );
      expect(roles.rows).toHaveLength(SERVICE_DATABASE_ROLES.length);
      for (const role of roles.rows) {
        expect(role).toMatchObject({
          rolcanlogin: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolsuper: false
        });
      }

      const grants = await admin.query<{
        channelOwn: boolean;
        channelToLumen: boolean;
        lumenOwn: boolean;
        lumenToPlatform: boolean;
        lumenToPulso: boolean;
      }>(
        `select has_table_privilege('hyperion_lumen', 'lumen.encounters', 'SELECT') as "lumenOwn",
                has_table_privilege('hyperion_lumen', 'platform.tenants', 'SELECT') as "lumenToPlatform",
                has_table_privilege('hyperion_lumen', 'pulso_iris.messages', 'SELECT') as "lumenToPulso",
                has_table_privilege('hyperion_channel', 'channel_runtime.connections', 'SELECT') as "channelOwn",
                has_table_privilege('hyperion_channel', 'lumen.encounters', 'SELECT') as "channelToLumen"`
      );
      expect(grants.rows[0]).toEqual({
        channelOwn: true,
        channelToLumen: false,
        lumenOwn: true,
        lumenToPlatform: false,
        lumenToPulso: false
      });
    } finally {
      await admin.end();
    }
  });
});
