import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("016 SOFIA search constraints protocol", () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
    await client.query("begin");
  });

  afterAll(async () => {
    await client.query("rollback");
    await client.end();
  });

  it("activates only v5 with local constraints and homogeneous catalog selection", async () => {
    const result = await client.query<{
      runtimeKey: string;
      systemPrompt: string;
      searchConstraintSource: string;
      searchConstraintTimeZone: string;
      catalogSelectionPolicy: string;
      searchResultPolicy: string;
      status: string;
      activeCount: number;
      archivedPredecessors: number;
    }>(
      `select f.definition ->> 'runtimeKey' as "runtimeKey",
              f.definition ->> 'systemPrompt' as "systemPrompt",
              f.definition ->> 'searchConstraintSource' as "searchConstraintSource",
              f.definition ->> 'searchConstraintTimeZone' as "searchConstraintTimeZone",
              f.definition ->> 'catalogSelectionPolicy' as "catalogSelectionPolicy",
              f.definition ->> 'searchResultPolicy' as "searchResultPolicy",
              f.status,
              (select count(*)::int
               from platform.prompt_flows active
               where active.tenant_id = f.tenant_id
                 and active.agent_id = f.agent_id
                 and active.status = 'active') as "activeCount",
              (select count(*)::int
               from platform.prompt_flows predecessor
               where predecessor.tenant_id = f.tenant_id
                 and predecessor.agent_id = f.agent_id
                 and predecessor.status = 'archived'
                 and predecessor.definition ->> 'runtimeKey' in (
                   'sofia_whatsapp_internal_v1',
                   'sofia_whatsapp_internal_v2',
                   'sofia_whatsapp_internal_v3',
                   'sofia_whatsapp_internal_v4'
                 )) as "archivedPredecessors"
       from platform.prompt_flows f
       join platform.agents a
         on a.tenant_id = f.tenant_id and a.id = f.agent_id
       join platform.tenants t on t.id = f.tenant_id
       where t.slug = 'cedco'
         and a.code = 'SOFIA'
         and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v5'`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        runtimeKey: "sofia_whatsapp_internal_v5",
        searchConstraintSource: "current_patient_message",
        searchConstraintTimeZone: "America/Bogota",
        catalogSelectionPolicy: "homogeneous_structured_context_only",
        searchResultPolicy: "must_match_normalized_local_constraints",
        status: "active",
        activeCount: 1,
        archivedPredecessors: 4
      })
    );
    expect(result.rows[0]!.systemPrompt).toContain("localDate y localTime en America/Bogota");
    expect(result.rows[0]!.systemPrompt).toContain("sede, profesional, convenio y tipo de cita");
    expect(result.rows[0]!.systemPrompt).toContain("un unico valor homogeneo");
    expect(result.rows[0]!.systemPrompt).toContain("nunca presentes slots de otra fecha");
  });

  it("promotes only homogeneous same-tenant slot references before clearing the snapshot", async () => {
    const tenant = await client.query<{ id: string }>("select id from platform.tenants where slug = 'cedco'");
    const tenantId = tenant.rows[0]!.id;
    const catalog = await client.query<{
      siteId: string;
      payerId: string;
      otherPayerId: string;
      appointmentTypeId: string;
    }>(
      `select
         (select id from pulso_iris.sites where tenant_id = $1 and status = 'active' order by name limit 1) as "siteId",
         (select id from pulso_iris.payers where tenant_id = $1 and status = 'active' order by name limit 1) as "payerId",
         (select id from pulso_iris.payers where tenant_id = $1 and status = 'active' order by name offset 1 limit 1) as "otherPayerId",
         (select id from pulso_iris.appointment_types where tenant_id = $1 and status = 'active' order by name limit 1) as "appointmentTypeId"`,
      [tenantId]
    );
    const selection = catalog.rows[0]!;
    const professionalId = randomUUID();
    const foreignTenantId = randomUUID();
    const foreignProfessionalId = randomUUID();
    const promotedConversationId = randomUUID();
    const tenantGuardConversationId = randomUUID();

    await client.query(
      `insert into platform.tenants (id, slug, display_name)
       values ($1, $2, 'Tenant controlado de migracion')`,
      [foreignTenantId, `migration-016-${foreignTenantId}`]
    );
    await client.query(
      `insert into pulso_iris.professionals (id, tenant_id, name, professional_type)
       values ($1, $2, 'Profesional controlado 016', 'optometrist'),
              ($3, $4, 'Profesional externo controlado 016', 'optometrist')`,
      [professionalId, tenantId, foreignProfessionalId, foreignTenantId]
    );

    const validSlots = ["09:00", "09:20"].map((localTime) => ({
      siteId: selection.siteId,
      professionalId,
      payerId: selection.payerId,
      appointmentTypeId: selection.appointmentTypeId,
      localDate: "2026-07-13",
      localTime
    }));
    const foreignSlots = ["10:00", "10:20"].map((localTime) => ({
      siteId: selection.siteId,
      professionalId: foreignProfessionalId,
      payerId: selection.payerId,
      appointmentTypeId: selection.appointmentTypeId,
      localDate: "2026-07-13",
      localTime
    }));

    await client.query(
      `insert into pulso_iris.conversations (id, tenant_id, channel, metadata)
       values ($1, $2, 'whatsapp', $3::jsonb),
              ($4, $2, 'whatsapp', $5::jsonb)`,
      [
        promotedConversationId,
        tenantId,
        JSON.stringify({ sofiaState: { lastAvailability: { slots: validSlots }, pendingAction: { marker: "keep" } } }),
        tenantGuardConversationId,
        JSON.stringify({
          sofiaState: {
            lastAvailability: { slots: foreignSlots },
            agendaSelection: { payerId: selection.otherPayerId, marker: "preserved" }
          }
        })
      ]
    );

    try {
      const migrationPath = fileURLToPath(new URL("../sql/016-sofia-search-constraints.sql", import.meta.url));
      await client.query(await readFile(migrationPath, "utf8"));
      const result = await client.query<{ id: string; state: Record<string, unknown> }>(
        `select id, metadata -> 'sofiaState' as state
         from pulso_iris.conversations
         where tenant_id = $1 and id in ($2, $3)`,
        [tenantId, promotedConversationId, tenantGuardConversationId]
      );
      const states = new Map(result.rows.map((row) => [row.id, row.state]));
      const promoted = states.get(promotedConversationId)!;
      const guarded = states.get(tenantGuardConversationId)!;

      expect(promoted.agendaSelection).toEqual({
        siteId: selection.siteId,
        professionalId,
        payerId: selection.payerId,
        appointmentTypeId: selection.appointmentTypeId
      });
      expect(promoted.pendingAction).toEqual({ marker: "keep" });
      expect(Object.keys(promoted).filter((key) => key.startsWith("lastAvailability"))).toEqual([]);

      expect(guarded.agendaSelection).toEqual({
        siteId: selection.siteId,
        payerId: selection.otherPayerId,
        appointmentTypeId: selection.appointmentTypeId,
        marker: "preserved"
      });
      expect(guarded.agendaSelection).not.toHaveProperty("professionalId");
      expect(Object.keys(guarded).filter((key) => key.startsWith("lastAvailability"))).toEqual([]);
    } finally {
      await client.query(`delete from pulso_iris.conversations where tenant_id = $1 and id in ($2, $3)`, [
        tenantId,
        promotedConversationId,
        tenantGuardConversationId
      ]);
      await client.query(`delete from pulso_iris.professionals where tenant_id = $1 and id = $2`, [
        tenantId,
        professionalId
      ]);
      await client.query(`delete from platform.tenants where id = $1`, [foreignTenantId]);
    }
  });

  it("removes only availability snapshots and preserves agenda and confirmation state", async () => {
    const tenant = await client.query<{ id: string }>("select id from platform.tenants where slug = 'cedco'");
    const tenantId = tenant.rows[0]!.id;
    const conversationId = randomUUID();
    const agendaSelection = {
      siteId: randomUUID(),
      professionalId: randomUUID(),
      payerId: randomUUID(),
      appointmentTypeId: randomUUID()
    };
    const pendingAction = {
      tool: "create_appointment_hold",
      arguments: { scheduledAt: "2026-07-13T14:00:00.000Z" },
      stagedAt: "2026-07-10T02:00:00.000Z",
      jobId: randomUUID()
    };
    const confirmationGrant = {
      actionId: randomUUID(),
      tool: "book_appointment",
      holdId: randomUUID(),
      expiresAt: "2026-07-10T02:15:00.000Z"
    };

    await client.query(
      `insert into pulso_iris.conversations (id, tenant_id, channel, metadata)
       values ($1, $2, 'whatsapp', $3::jsonb)`,
      [
        conversationId,
        tenantId,
        JSON.stringify({
          sofiaState: {
            lastAvailability: { slots: [{ localDate: "2026-07-10", localTime: "09:00" }] },
            lastAvailabilityAt: "2026-07-10T02:00:00.000Z",
            lastAvailabilitySchemaVersion: 2,
            lastAvailabilityJobId: randomUUID(),
            lastAvailabilityConstraints: { localDate: "2026-07-10" },
            agendaSelection,
            pendingAction,
            confirmationGrant,
            patientContext: { payer: "particular" }
          },
          unrelatedMetadata: "preserved"
        })
      ]
    );

    try {
      const migrationPath = fileURLToPath(new URL("../sql/016-sofia-search-constraints.sql", import.meta.url));
      await client.query(await readFile(migrationPath, "utf8"));
      const result = await client.query<{ metadata: Record<string, unknown> }>(
        `select metadata from pulso_iris.conversations where tenant_id = $1 and id = $2`,
        [tenantId, conversationId]
      );
      const metadata = result.rows[0]!.metadata as {
        sofiaState: Record<string, unknown>;
        unrelatedMetadata: string;
      };

      expect(Object.keys(metadata.sofiaState).filter((key) => key.startsWith("lastAvailability"))).toEqual([]);
      expect(metadata.sofiaState).toMatchObject({ agendaSelection, pendingAction, confirmationGrant });
      expect(metadata.sofiaState.patientContext).toEqual({ payer: "particular" });
      expect(metadata.unrelatedMetadata).toBe("preserved");
    } finally {
      await client.query(`delete from pulso_iris.conversations where tenant_id = $1 and id = $2`, [
        tenantId,
        conversationId
      ]);
    }
  });
});
