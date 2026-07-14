import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPulsoEventPositionRoute } from "./event-position-routes.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const STREAM_ID = "40000000-0000-4000-8000-000000000001";
const SOURCE_STREAM_ID = "50000000-0000-4000-8000-000000000001";
const TOKEN = "sofia-to-pulso-test-token";

describe("PULSO event position owner route", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())).then(() => undefined));

  it("returns only the requested owner ledger position to SOFIA", async () => {
    const query = vi.fn(async () => ({
      rows: [{ streamId: STREAM_ID, streamSequence: 4, sourceStreamId: SOURCE_STREAM_ID, sourceStreamSequence: "9" }]
    }));
    const app = Fastify();
    apps.push(app);
    registerPulsoEventPositionRoute(app, context(query), TOKEN);

    const wrongCaller = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-message/${EVENT_ID}/stream-position`,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "whatsapp-channel-service" }
    });
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-message/${EVENT_ID}/stream-position`,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "agent-service" }
    });

    expect(wrongCaller.statusCode).toBe(401);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      tenantId: TENANT_ID,
      eventId: EVENT_ID,
      streamId: STREAM_ID,
      streamSequence: 4,
      sourceStreamId: SOURCE_STREAM_ID,
      sourceStreamSequence: 9
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

function context(query: ReturnType<typeof vi.fn>) {
  return {
    db: { query },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  } as never;
}
