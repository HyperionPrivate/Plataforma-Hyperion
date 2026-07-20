import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapDatabaseRoles,
  SERVICE_DATABASE_ROLES,
  type ServiceDatabaseRole,
  type ServiceRolePasswords
} from "./bootstrap-roles.js";
import { readNonTransactionalStatements } from "./runner.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;
const itOwnershipGuard = process.env.EXPECT_SERVICE_ROLE_OWNERSHIP_GUARD === "true" ? it : it.skip;

const passwords = new Map<ServiceDatabaseRole, string>();

describeIntegration("PostgreSQL service role isolation", () => {
  beforeAll(async () => {
    for (const [index, definition] of SERVICE_DATABASE_ROLES.entries()) {
      passwords.set(definition.role, `${String(index)}${randomUUID().replaceAll("-", "")}`);
    }
    await bootstrapDatabaseRoles(TEST_DATABASE_URL ?? "", passwords as ServiceRolePasswords);

    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      const applied = await admin.query<{ applied: boolean }>(
        `select exists(
           select 1 from platform.schema_migrations
            where name = '024-service-database-roles.sql'
         ) as applied`
      );
      if (!applied.rows[0]?.applied) {
        throw new Error("024-service-database-roles.sql must be applied before role bootstrap");
      }
    } finally {
      await admin.end();
    }
  });

  it("creates fixed LOGIN identities without administrative capabilities or memberships", async () => {
    await withAdmin(async (admin) => {
      const roles = await admin.query<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolname: string;
        rolreplication: boolean;
        rolsuper: boolean;
      }>(
        `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolinherit, rolreplication, rolbypassrls
           from pg_roles
          where rolname = any($1::text[])
          order by rolname`,
        [SERVICE_DATABASE_ROLES.map((definition) => definition.role)]
      );

      expect(roles.rows).toHaveLength(SERVICE_DATABASE_ROLES.length);
      for (const role of roles.rows) {
        expect(role).toMatchObject({
          rolbypassrls: false,
          rolcanlogin: true,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolsuper: false
        });
      }

      const memberships = await admin.query<{ count: number }>(
        `select count(*)::int as count
           from pg_auth_members membership
           join pg_roles member_role on member_role.oid = membership.member
           join pg_roles granted_role on granted_role.oid = membership.roleid
          where member_role.rolname = any($1::text[])
             or granted_role.rolname = any($1::text[])`,
        [SERVICE_DATABASE_ROLES.map((definition) => definition.role)]
      );
      expect(memberships.rows[0]?.count).toBe(0);
    });
  });

  it("reapplies the least-privilege matrix on every credential rotation", async () => {
    await withAdmin(async (admin) => {
      await admin.query("grant select on table platform.tenants to hyperion_lumen");
      const drifted = await admin.query<{ allowed: boolean }>(
        `select has_table_privilege('hyperion_lumen', 'platform.tenants', 'SELECT') as allowed`
      );
      expect(drifted.rows[0]?.allowed).toBe(true);
    });

    await bootstrapDatabaseRoles(TEST_DATABASE_URL ?? "", passwords as ServiceRolePasswords);

    await withAdmin(async (admin) => {
      const repaired = await admin.query<{ allowed: boolean }>(
        `select has_table_privilege('hyperion_lumen', 'platform.tenants', 'SELECT') as allowed`
      );
      expect(repaired.rows[0]?.allowed).toBe(false);
    });
  });

  it("rejects a role that can impersonate a service identity", async () => {
    const probeRole = `role_probe_${randomUUID().replaceAll("-", "")}`;
    await withAdmin(async (admin) => {
      await admin.query(`create role "${probeRole}" nologin`);
      await admin.query(`grant hyperion_lumen to "${probeRole}"`);
    });

    try {
      await expect(bootstrapDatabaseRoles(TEST_DATABASE_URL ?? "", passwords as ServiceRolePasswords)).rejects.toThrow(
        "unsafe role privilege matrix"
      );

      await withAdmin(async (admin) => {
        const state = await admin.query<{ loginCount: number }>(
          `select count(*) filter (where rolcanlogin)::int as "loginCount"
             from pg_roles
            where rolname = any($1::text[])`,
          [SERVICE_DATABASE_ROLES.map((definition) => definition.role)]
        );
        expect(state.rows[0]?.loginCount).toBe(0);
      });
    } finally {
      await withAdmin(async (admin) => {
        await admin.query(`revoke hyperion_lumen from "${probeRole}"`);
        await admin.query(`drop role "${probeRole}"`);
      });
      await bootstrapDatabaseRoles(TEST_DATABASE_URL ?? "", passwords as ServiceRolePasswords);
    }
  });

  it("fails the NOLOGIN migration fence while a service session is still active", async () => {
    await withRole("hyperion_lumen", async () => {
      await withAdmin(async (admin) => {
        const fence = await readFile(
          fileURLToPath(new URL("../sql/020-service-role-nologin-fence.sql", import.meta.url)),
          "utf8"
        );
        const statements = readNonTransactionalStatements(fence);
        expect(statements).toHaveLength(2);
        await admin.query(statements[0]!);
        await expect(admin.query(statements[1]!)).rejects.toThrow("drain all Hyperion service database sessions");

        const loginState = await admin.query<{ canLogin: boolean }>(
          `select rolcanlogin as "canLogin" from pg_roles where rolname = 'hyperion_lumen'`
        );
        expect(loginState.rows[0]?.canLogin).toBe(false);
      });
    });

    await bootstrapDatabaseRoles(TEST_DATABASE_URL ?? "", passwords as ServiceRolePasswords);
  });

  it("fences every role and refuses credential rotation until old service sessions drain", async () => {
    await withRole("hyperion_lumen", async () => {
      await expect(bootstrapDatabaseRoles(TEST_DATABASE_URL ?? "", passwords as ServiceRolePasswords)).rejects.toThrow(
        "requires all service sessions to be drained"
      );

      await withAdmin(async (admin) => {
        const state = await admin.query<{ loginCount: number }>(
          `select count(*) filter (where rolcanlogin)::int as "loginCount"
             from pg_roles
            where rolname = any($1::text[])`,
          [SERVICE_DATABASE_ROLES.map((definition) => definition.role)]
        );
        expect(state.rows[0]?.loginCount).toBe(0);
      });
    });

    // Once the old connection is gone, the same all-or-nothing activation can
    // safely restore service availability for the remaining permission tests.
    await bootstrapDatabaseRoles(TEST_DATABASE_URL ?? "", passwords as ServiceRolePasswords);
  });

  it("runs a representative real query in every service database context", async () => {
    const checks: Array<{ queries: string[]; role: ServiceDatabaseRole }> = [
      {
        role: "hyperion_access",
        queries: [
          "select count(*) from platform.tenants",
          "select count(*) from platform.operators",
          "select count(*) from platform.schema_migrations"
        ]
      },
      {
        role: "hyperion_sofia",
        queries: [
          "select count(*) from platform.agents",
          "select count(*) from agent_runtime.jobs",
          "select count(*) from agent_runtime.pulso_stream_positions",
          "select count(*) from agent_runtime.job_stream_positions",
          "select count(*) from pulso_iris.messages",
          "select count(*) from channel_runtime.outbound_messages",
          "select count(*) from agent_runtime.claim_next_job('role-permission-test')"
        ]
      },
      {
        role: "hyperion_knowledge",
        queries: ["select count(*) from platform.knowledge_sources", "select count(*) from platform.schema_migrations"]
      },
      {
        role: "hyperion_integration",
        queries: [
          "select count(*) from platform.integrations",
          "select count(*) from platform.agents",
          "select count(*) from pulso_iris.agenda_settings",
          "select count(*) from platform.schema_migrations"
        ]
      },
      {
        role: "hyperion_pulso",
        queries: [
          "select count(*) from pulso_iris.sites",
          "select count(*) from platform.audit_events",
          "select count(*) from pulso_iris.outbox_stream_positions",
          "select count(*) from pulso_iris.outbox_event_positions",
          "select count(*) from platform.schema_migrations"
        ]
      },
      {
        role: "hyperion_channel",
        queries: [
          "select count(*) from channel_runtime.connections",
          "select count(*) from channel_runtime.claim_next_inbound_event('role-permission-test')",
          "select count(*) from platform.schema_migrations"
        ]
      },
      {
        role: "hyperion_lumen",
        queries: [
          "select current_version from lumen.schema_version where service_name = 'lumen'",
          "select count(*) from lumen.encounters",
          "select count(*) from lumen.inbox_events",
          "select count(*) from lumen.audio_cleanup_owner_leases"
        ]
      }
    ];

    for (const check of checks) {
      await withRole(check.role, async (client) => {
        for (const query of check.queries) {
          await client.query(query);
        }
      });
    }
  });

  it("allows owner writes after the historical cross-owner trigger is removed", async () => {
    await withAdmin(async (admin) => {
      const trigger = await admin.query<{ count: number }>(
        `select count(*)::int as count
           from pg_catalog.pg_trigger
          where tgrelid = 'platform.tenants'::regclass
            and tgname = 'trg_initialize_agenda_settings'
            and not tgisinternal`
      );
      expect(trigger.rows[0]?.count).toBe(0);
    });

    await withRole("hyperion_access", async (access) => {
      await access.query("begin");
      try {
        await access.query(
          `insert into platform.tenants (slug, display_name)
           values ($1, 'Role permission owner write test')`,
          [`role-permission-${randomUUID()}`]
        );
      } finally {
        await access.query("rollback");
      }
    });

    await withRole("hyperion_lumen", async (lumen) => {
      const tenantId = randomUUID();
      const encounterId = randomUUID();
      const patientId = randomUUID();
      const professionalId = randomUUID();
      const siteId = randomUUID();
      const payloadHash = "a".repeat(64);

      await lumen.query("begin");
      try {
        await lumen.query(
          `insert into lumen.tenant_snapshots (
             tenant_id, status, is_demo, is_active, source_version,
             source_updated_at, payload_hash
           ) values ($1, 'active', true, true, 1, now(), $2)`,
          [tenantId, payloadHash]
        );
        await lumen.query(
          `insert into lumen.encounter_reference_snapshots (
             tenant_id, encounter_id, patient_id, site_id, professional_id,
             patient_display_name, professional_name, site_name,
             patient_is_demo, professional_is_demo, source_version,
             source_updated_at, payload_hash
           ) values (
             $1, $2, $3, $4, $5, 'Synthetic patient', 'Synthetic professional',
             'Synthetic site', true, true, 1, now(), $6
           )`,
          [tenantId, encounterId, patientId, siteId, professionalId, payloadHash]
        );
        await lumen.query(
          `insert into lumen.encounters (
             id, tenant_id, patient_id, professional_id, site_id, status,
             scheduled_at, is_demo, demo_key, metadata
           ) values (
             $1, $2, $3, $4, $5, 'preconsultation', now(), true, $6,
             '{"synthetic":"true"}'::jsonb
           )`,
          [encounterId, tenantId, patientId, professionalId, siteId, `role-test-${encounterId}`]
        );
      } finally {
        await lumen.query("rollback");
      }
    });

    await withAdmin(async (admin) => {
      const publicExecute = await admin.query<{ canExecute: boolean }>(
        `select has_function_privilege(
                  'public',
                  'lumen.guard_synthetic_encounter()',
                  'EXECUTE'
                ) as "canExecute"`
      );
      expect(publicExecute.rows[0]?.canExecute).toBe(false);

      const compatibilityExecute = await admin.query<{
        pulsoInboxResolverPresent: boolean;
        pulsoOutboxResolverPresent: boolean;
        sofiaInboxResolverPresent: boolean;
        pulsoInboxResolver: boolean | null;
        pulsoOutboxResolver: boolean | null;
        sofiaInboxResolver: boolean | null;
      }>(
        `select
           to_regprocedure('pulso_iris.resolve_legacy_channel_inbox_position()') is not null as "pulsoInboxResolverPresent",
           to_regprocedure('pulso_iris.prepare_legacy_message_source_position()') is not null as "pulsoOutboxResolverPresent",
           to_regprocedure('agent_runtime.resolve_legacy_pulso_inbox_position()') is not null as "sofiaInboxResolverPresent",
           case
             when to_regprocedure('pulso_iris.resolve_legacy_channel_inbox_position()') is null then false
             else has_function_privilege(
               'hyperion_pulso',
               'pulso_iris.resolve_legacy_channel_inbox_position()',
               'EXECUTE'
             )
           end as "pulsoInboxResolver",
           case
             when to_regprocedure('pulso_iris.prepare_legacy_message_source_position()') is null then false
             else has_function_privilege(
               'hyperion_pulso',
               'pulso_iris.prepare_legacy_message_source_position()',
               'EXECUTE'
             )
           end as "pulsoOutboxResolver",
           case
             when to_regprocedure('agent_runtime.resolve_legacy_pulso_inbox_position()') is null then false
             else has_function_privilege(
               'hyperion_sofia',
               'agent_runtime.resolve_legacy_pulso_inbox_position()',
               'EXECUTE'
             )
           end as "sofiaInboxResolver"`
      );
      expect(compatibilityExecute.rows[0]).toEqual({
        pulsoInboxResolverPresent: false,
        pulsoOutboxResolverPresent: false,
        sofiaInboxResolverPresent: false,
        pulsoInboxResolver: false,
        pulsoOutboxResolver: false,
        sofiaInboxResolver: false
      });
    });
  });

  it("denies cross-owner access outside the documented legacy allow-list", async () => {
    await withRole("hyperion_lumen", async (lumen) => {
      await expectPermissionDenied(lumen, "select count(*) from platform.tenants");
      await expectPermissionDenied(lumen, "select count(*) from pulso_iris.messages");
      await expectPermissionDenied(lumen, "select count(*) from lumen.n_minus_one_compatibility_windows");
      await expectPermissionDenied(
        lumen,
        `insert into lumen.legacy_audio_scope_attestations (
           attestation_id, cleanup_scope_id, destroyed_at, evidence_sha256
         ) values (
           '00000000-0000-4000-8000-000000000001',
           'lumen-n1-permission-probe-00000001',
           now(),
           '${"a".repeat(64)}'
         )`
      );
    });

    await withRole("hyperion_channel", async (channel) => {
      await expectPermissionDenied(channel, "select count(*) from lumen.encounters");
      await expectPermissionDenied(channel, "select count(*) from platform.audit_events");
      await expectPermissionDenied(channel, "select count(*) from pulso_iris.messages");
      await expectPermissionDenied(
        channel,
        "update pulso_iris.messages set delivery_status = delivery_status where false"
      );
    });

    await withRole("hyperion_sofia", async (sofia) => {
      await expectPermissionDenied(sofia, "select count(*) from pulso_iris.outbox_event_positions");
      await expectPermissionDenied(sofia, "update pulso_iris.conversations set updated_at = updated_at where false");
      await expectPermissionDenied(
        sofia,
        "insert into pulso_iris.messages (tenant_id, conversation_id, sender, body) values (null, null, 'sofia', 'x')"
      );
    });

    await withRole("hyperion_pulso", async (pulso) => {
      await expectPermissionDenied(pulso, "select count(*) from channel_runtime.outbox_event_positions");
      await expectPermissionDenied(pulso, "select count(*) from channel_runtime.thread_bindings");
      await expectPermissionDenied(
        pulso,
        "update channel_runtime.inbound_events set updated_at = updated_at where false"
      );
    });
  });

  itOwnershipGuard("refuses to layer grants over a service role that already owns a schema or function", async () => {
    const migration = await readFile(
      fileURLToPath(new URL("../sql/024-service-database-roles.sql", import.meta.url)),
      "utf8"
    );

    await withAdmin(async (admin) => {
      const schemaName = `role_owner_probe_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`create schema "${schemaName}" authorization hyperion_lumen`);
      try {
        await expect(admin.query(migration)).rejects.toThrow(
          "Hyperion service LOGIN roles must not own database objects"
        );
      } finally {
        await admin.query(`drop schema "${schemaName}"`);
      }

      const functionName = `role_owner_probe_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`create function public."${functionName}"() returns integer language sql as 'select 1'`);
      await admin.query(`alter function public."${functionName}"() owner to hyperion_lumen`);
      try {
        await expect(admin.query(migration)).rejects.toThrow(
          "Hyperion service LOGIN roles must not own database objects"
        );
      } finally {
        await admin.query(`alter function public."${functionName}"() owner to current_user`);
        await admin.query(`drop function public."${functionName}"()`);
      }
    });
  });
});

async function withAdmin<T>(operation: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function withRole<T>(
  role: ServiceDatabaseRole,
  operation: (client: InstanceType<typeof Client>) => Promise<T>
): Promise<T> {
  const password = passwords.get(role);
  if (!password) {
    throw new Error(`missing generated password for ${role}`);
  }

  const url = new URL(TEST_DATABASE_URL ?? "");
  url.username = role;
  url.password = password;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function expectPermissionDenied(client: InstanceType<typeof Client>, query: string): Promise<void> {
  try {
    await client.query(query);
    throw new Error("query unexpectedly succeeded");
  } catch (error) {
    expect((error as { code?: string }).code).toBe("42501");
  }
}
