import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("015 SOFIA fresh availability protocol", () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
    await client.query("begin");
  });

  afterAll(async () => {
    await client.query("rollback");
    await client.end();
  });

  it("preserves the superseded v4 prompt with its same-job availability rule", async () => {
    const result = await client.query<{
      runtimeKey: string;
      systemPrompt: string;
      availabilityFreshness: string;
      assistantHistoryAuthority: string;
      status: string;
      activeCount: number;
    }>(
      `select f.definition ->> 'runtimeKey' as "runtimeKey",
              f.definition ->> 'systemPrompt' as "systemPrompt",
              f.definition ->> 'availabilityFreshness' as "availabilityFreshness",
              f.definition ->> 'assistantHistoryAuthority' as "assistantHistoryAuthority",
              f.status,
              (select count(*)::int
               from platform.prompt_flows active
               where active.tenant_id = f.tenant_id
                 and active.agent_id = f.agent_id
                 and active.status = 'active') as "activeCount"
       from platform.prompt_flows f
       join platform.agents a
         on a.tenant_id = f.tenant_id and a.id = f.agent_id
       join platform.tenants t on t.id = f.tenant_id
       where t.slug = 'cedco'
         and a.code = 'SOFIA'
         and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v4'`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        runtimeKey: "sofia_whatsapp_internal_v4",
        availabilityFreshness: "same_job_tool_result",
        assistantHistoryAuthority: "untrusted_for_availability",
        status: "archived",
        activeCount: 1
      })
    );
    expect(result.rows[0]!.systemPrompt).toContain("search_availability en ese mismo job");
    expect(result.rows[0]!.systemPrompt).toContain("contexto conversacional no confiable");
    expect(result.rows[0]!.systemPrompt).toContain("nunca las reutilices");
  });

  it("removes only legacy availability keys and preserves confirmation state", async () => {
    const tenant = await client.query<{ id: string }>("select id from platform.tenants where slug = 'cedco'");
    const tenantId = tenant.rows[0]!.id;
    const conversationId = randomUUID();
    const pendingAction = {
      tool: "create_appointment_hold",
      arguments: { scheduledAt: "2026-07-13T14:00:00.000Z" },
      stagedAt: "2026-07-10T01:00:00.000Z",
      jobId: randomUUID()
    };
    const confirmationGrant = {
      actionId: randomUUID(),
      tool: "book_appointment",
      holdId: randomUUID(),
      expiresAt: "2026-07-10T01:15:00.000Z"
    };

    await client.query(
      `insert into pulso_iris.conversations (id, tenant_id, channel, metadata)
       values ($1, $2, 'whatsapp', $3::jsonb)`,
      [
        conversationId,
        tenantId,
        JSON.stringify({
          sofiaState: {
            lastAvailability: { slots: [{ localTime: "14:00" }] },
            lastAvailabilityAt: "2026-07-09T20:00:00.000Z",
            lastAvailabilitySchema: 1,
            pendingAction,
            confirmationGrant,
            patientContext: { payer: "particular" }
          },
          unrelatedMetadata: "preserved"
        })
      ]
    );

    try {
      const migrationPath = fileURLToPath(new URL("../sql/015-sofia-fresh-availability.sql", import.meta.url));
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
      expect(metadata.sofiaState).toMatchObject({ pendingAction, confirmationGrant });
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
