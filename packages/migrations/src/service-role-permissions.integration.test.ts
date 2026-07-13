import { createHash, randomUUID } from "node:crypto";
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
        throw new Error("024-service-database-roles.sql must be applied after role bootstrap");
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
          where member_role.rolname = any($1::text[])`,
        [SERVICE_DATABASE_ROLES.map((definition) => definition.role)]
      );
      expect(memberships.rows[0]?.count).toBe(0);
    });
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
        role: "hyperion_audit",
        queries: [
          "select count(*) from platform.audit_events",
          "select count(*) from audit_runtime.inbox_events",
          "select count(*) from platform.schema_migrations"
        ]
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
          "select count(*) from channel_runtime.thread_bindings",
          "select count(*) from platform.schema_migrations"
        ]
      },
      {
        role: "hyperion_channel",
        queries: [
          "select count(*) from channel_runtime.connections",
          "select count(*) from pulso_iris.messages",
          "select count(*) from channel_runtime.claim_next_inbound_event('role-permission-test')",
          "select count(*) from platform.schema_migrations"
        ]
      },
      {
        role: "hyperion_lumen",
        queries: [
          "select current_version from lumen.schema_version where service_name = 'lumen'",
          "select count(*) from lumen.encounters",
          "select count(*) from lumen.inbox_events"
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

  it("allows owned writes and trigger execution after PUBLIC function access is revoked", async () => {
    await withRole("hyperion_access", async (access) => {
      await access.query("begin");
      try {
        await access.query(
          `insert into platform.tenants (slug, display_name)
           values ($1, 'Role permission trigger test')`,
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
    });
  });

  it("denies cross-owner access outside the documented legacy allow-list", async () => {
    await withRole("hyperion_lumen", async (lumen) => {
      await expectPermissionDenied(lumen, "select count(*) from platform.tenants");
      await expectPermissionDenied(lumen, "select count(*) from pulso_iris.messages");
    });

    await withRole("hyperion_channel", async (channel) => {
      await expectPermissionDenied(channel, "select count(*) from lumen.encounters");
      await expectPermissionDenied(channel, "select count(*) from platform.audit_events");
    });

    await withRole("hyperion_audit", async (audit) => {
      await expectPermissionDenied(audit, "select count(*) from pulso_iris.messages");
      await expectPermissionDenied(audit, "select count(*) from lumen.encounters");
    });
  });

  it("keeps the Audit ledger and inbox append-only for the runtime role", async () => {
    await withRole("hyperion_audit", async (audit) => {
      await audit.query("begin");
      try {
        await audit.query(
          `insert into platform.audit_events (event_type, entity_type, metadata)
           values ('role.append.probe', 'permission_test', '{"synthetic":true}'::jsonb)`
        );
        await audit.query(
          `insert into audit_runtime.inbox_events (
             event_id, tenant_id, source_service, event_type, event_version,
             payload_hash, contract_hash, occurred_at
           ) values ($1, null, 'sofia-automation', 'sofia.audit.event.record.v1', 1, $2, $3, now())`,
          [
            randomUUID(),
            "a".repeat(64),
            createHash("sha256")
              .update(["sofia-automation", "sofia.audit.event.record.v1", "1", "<none>", "a".repeat(64)].join("\u001f"))
              .digest("hex")
          ]
        );
      } finally {
        await audit.query("rollback");
      }

      await expectPermissionDenied(audit, "update platform.audit_events set metadata = metadata where false");
      await expectPermissionDenied(audit, "delete from platform.audit_events where false");
      await expectPermissionDenied(
        audit,
        "update audit_runtime.inbox_events set payload_hash = payload_hash where false"
      );
      await expectPermissionDenied(audit, "delete from audit_runtime.inbox_events where false");
    });
  });

  it("preserves historical Audit tenant identifiers when Access deletes a tenant", async () => {
    let tenantId = "";
    let auditEventId = "";
    try {
      await withRole("hyperion_access", async (access) => {
        const tenant = await access.query<{ id: string }>(
          `insert into platform.tenants (slug, display_name)
           values ($1, 'Audit external identifier probe') returning id`,
          [`audit-external-id-${randomUUID()}`]
        );
        tenantId = tenant.rows[0]?.id ?? "";
      });

      await withRole("hyperion_audit", async (audit) => {
        const event = await audit.query<{ id: string }>(
          `insert into platform.audit_events (tenant_id, event_type, entity_type, metadata)
           values ($1, 'tenant.lifecycle.probe', 'tenant', '{"synthetic":true}'::jsonb)
           returning id`,
          [tenantId]
        );
        auditEventId = event.rows[0]?.id ?? "";
      });

      await withRole("hyperion_access", async (access) => {
        await access.query("delete from platform.tenants where id = $1", [tenantId]);
      });

      await withRole("hyperion_audit", async (audit) => {
        const evidence = await audit.query<{ tenantId: string }>(
          `select tenant_id as "tenantId" from platform.audit_events where id = $1`,
          [auditEventId]
        );
        expect(evidence.rows).toEqual([{ tenantId }]);
      });
    } finally {
      await withAdmin(async (admin) => {
        if (auditEventId) await admin.query("delete from platform.audit_events where id = $1", [auditEventId]);
        if (tenantId) await admin.query("delete from platform.tenants where id = $1", [tenantId]);
      });
    }
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
