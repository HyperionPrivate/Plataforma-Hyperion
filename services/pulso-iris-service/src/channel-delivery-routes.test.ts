import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerChannelDeliveryRoutes } from "./channel-delivery-routes.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";
const CHANNEL_TOKEN = "channel-to-pulso-test-token";
const headers = {
  authorization: `Bearer ${CHANNEL_TOKEN}`,
  "x-hyperion-caller": "whatsapp-channel-service"
};
const payload = {
  conversationId: CONVERSATION_ID,
  body: "Dato clínico privado",
  expectedDeliveryStatus: "queued"
};

describe("PULSO channel delivery guard route", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())).then(() => undefined));

  it("accepts only the authenticated POST JSON contract and returns a minimal result", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          sender: "sofia",
          body: payload.body,
          provider: "whatsapp_web_test",
          deliveryStatus: "queued"
        }
      ],
      rowCount: 1
    }));
    const app = Fastify();
    apps.push(app);
    registerChannelDeliveryRoutes(app, context(query), CHANNEL_TOKEN);

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery-guard`,
      headers,
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ messageId: MESSAGE_ID, matches: true });
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects the legacy query protocol and any query attached to POST", async () => {
    const query = vi.fn();
    const app = Fastify();
    apps.push(app);
    registerChannelDeliveryRoutes(app, context(query), CHANNEL_TOKEN);
    const path = `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery-guard`;

    const legacy = await app.inject({
      method: "GET",
      url: `${path}?conversationId=${CONVERSATION_ID}&body=privado&expectedDeliveryStatus=queued`,
      headers
    });
    const postWithQuery = await app.inject({
      method: "POST",
      url: `${path}?body=privado`,
      headers,
      payload
    });

    expect(legacy.statusCode).toBe(404);
    expect(postWithQuery.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated, malformed and non-strict JSON without touching the database", async () => {
    const query = vi.fn();
    const app = Fastify();
    apps.push(app);
    registerChannelDeliveryRoutes(app, context(query), CHANNEL_TOKEN);
    const path = `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery-guard`;

    const unauthorized = await app.inject({ method: "POST", url: path, payload });
    const extraProperty = await app.inject({
      method: "POST",
      url: path,
      headers,
      payload: { ...payload, unexpected: true }
    });
    const malformed = await app.inject({
      method: "POST",
      url: path,
      headers: { ...headers, "content-type": "application/json" },
      payload: '{"conversationId":'
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(extraProperty.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

function context(query: ReturnType<typeof vi.fn>) {
  return {
    db: { query },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  } as never;
}
