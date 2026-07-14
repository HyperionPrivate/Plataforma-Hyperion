import { createService } from "@hyperion/service-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./app.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN = "sofia-to-prompt-flow-test-token";

describe("prompt-flow workload identity", () => {
  afterEach(() => {
    delete process.env.SOFIA_TO_PROMPT_FLOW_TOKEN;
    delete process.env.DATABASE_URL;
  });

  it("fails closed when its edge credential is not configured", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/prompt-flows/SOFIA/active`
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("rejects another workload even when it reuses SOFIA's token", async () => {
    process.env.SOFIA_TO_PROMPT_FLOW_TOKEN = TOKEN;
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/prompt-flows/SOFIA/active`,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "integration-service" }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("accepts only the agent-service edge", async () => {
    process.env.SOFIA_TO_PROMPT_FLOW_TOKEN = TOKEN;
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          name: "SOFIA",
          version: 1,
          definition: { systemPrompt: "A sufficiently long controlled system prompt." }
        }
      ]
    });
    const app = await buildApp(query);
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/prompt-flows/SOFIA/active`,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "agent-service" }
    });

    expect(response.statusCode).toBe(200);
    expect(query).toHaveBeenCalledOnce();
    await app.close();
  });
});

async function buildApp(query = vi.fn()) {
  process.env.DATABASE_URL = "postgresql://unused/prompt-flow-tests";
  const database = { query, transaction: vi.fn(), close: vi.fn() } as never;
  const handle = await createService({
    serviceName: "prompt-flow-service",
    databaseRequired: true,
    createDatabase: () => database,
    registerRoutes
  });
  return handle.app;
}
