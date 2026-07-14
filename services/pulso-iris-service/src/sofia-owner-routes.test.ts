import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSofiaOwnerRoutes } from "./sofia-owner-routes.js";
import { registerChannelDeliveryRoutes } from "./channel-delivery-routes.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";
const SOFIA_TOKEN = "sofia-to-pulso-test-token";
const CHANNEL_TOKEN = "channel-to-pulso-test-token";

describe("PULSO sofia owner routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())).then(() => undefined));

  it("authorizes agent-service for outbound persist and rejects other callers", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: MESSAGE_ID, body: "hola" }], rowCount: 1 }));
    const app = Fastify();
    apps.push(app);
    registerSofiaOwnerRoutes(app, context(query), SOFIA_TOKEN);

    const missing = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/sofia-outbound`,
      payload: {
        conversationId: CONVERSATION_ID,
        body: "hola",
        externalMessageId: "sofia-job:1",
        metadata: {}
      }
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/sofia-outbound`,
      headers: { authorization: `Bearer ${SOFIA_TOKEN}`, "x-hyperion-caller": "whatsapp-channel-service" },
      payload: {
        conversationId: CONVERSATION_ID,
        body: "hola",
        externalMessageId: "sofia-job:1",
        metadata: {}
      }
    });
    const ok = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/sofia-outbound`,
      headers: { authorization: `Bearer ${SOFIA_TOKEN}`, "x-hyperion-caller": "agent-service" },
      payload: {
        conversationId: CONVERSATION_ID,
        body: "hola",
        externalMessageId: "sofia-job:1",
        metadata: {}
      }
    });

    expect(missing.statusCode).toBe(401);
    expect([401, 403]).toContain(forbidden.statusCode);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ id: MESSAGE_ID, body: "hola" });
  });
});

describe("PULSO channel delivery owner routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())).then(() => undefined));

  it("authorizes whatsapp-channel-service for delivery updates", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const app = Fastify();
    apps.push(app);
    registerChannelDeliveryRoutes(app, context(query), CHANNEL_TOKEN);

    const missing = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery`,
      payload: { outcome: "failed" }
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery`,
      headers: { authorization: `Bearer ${CHANNEL_TOKEN}`, "x-hyperion-caller": "agent-service" },
      payload: { outcome: "failed" }
    });
    const ok = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery`,
      headers: { authorization: `Bearer ${CHANNEL_TOKEN}`, "x-hyperion-caller": "whatsapp-channel-service" },
      payload: { outcome: "failed" }
    });

    expect(missing.statusCode).toBe(401);
    expect([401, 403]).toContain(forbidden.statusCode);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ updated: true });
  });
});

function context(query: ReturnType<typeof vi.fn>) {
  return {
    db: { query },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  } as never;
}
