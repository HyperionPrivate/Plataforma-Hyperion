import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("013 SOFIA explicit confirmation protocol", () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("activates only the v2 prompt with staging before confirmation", async () => {
    const result = await client.query<{
      runtimeKey: string;
      systemPrompt: string;
      activeCount: number;
    }>(
      `select f.definition ->> 'runtimeKey' as "runtimeKey",
              f.definition ->> 'systemPrompt' as "systemPrompt",
              count(*) over ()::int as "activeCount"
       from platform.prompt_flows f
       join platform.agents a
         on a.tenant_id = f.tenant_id and a.id = f.agent_id
       join platform.tenants t on t.id = f.tenant_id
       where t.slug = 'cedco' and a.code = 'SOFIA' and f.status = 'active'`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        runtimeKey: "sofia_whatsapp_internal_v2",
        activeCount: 1
      })
    );
    expect(result.rows[0]!.systemPrompt).toContain("antes de pedir CONFIRMO");
    expect(result.rows[0]!.systemPrompt).toContain("argumentos persistidos");
    expect(result.rows[0]!.systemPrompt).toContain("prepara cancel_appointment o reschedule_appointment");
    expect(result.rows[0]!.systemPrompt).toContain("confirmation_action_staged");
  });
});
