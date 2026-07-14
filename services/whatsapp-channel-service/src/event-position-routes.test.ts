import type { DatabaseClient } from "@hyperion/database";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findChannelEventPosition, registerChannelEventPositionRoute } from "./event-position-routes.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const STREAM_ID = "40000000-0000-4000-8000-000000000001";
const TOKEN = "pulso-to-channel-test-token";
let app: ServiceHandle["app"] | undefined;

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.unstubAllEnvs();
  }
});

describe("Channel event position owner route", () => {
  it("binds the endpoint to PULSO before requiring the database", async () => {
    vi.stubEnv("DATABASE_URL", "");
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance, context) => registerChannelEventPositionRoute(instance, context, TOKEN)
    }));
    const url = `/internal/v1/tenants/${TENANT_ID}/channel-inbound/${EVENT_ID}/stream-position`;

    const unauthorized = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "agent-service" }
    });
    const authorized = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "pulso-iris-service" }
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(503);
    expect(authorized.json().data).toEqual({ error: "DATABASE_URL is required" });
  });

  it("queries only the owner ledger with both tenant and event identity", async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({
      rows: params[0] === TENANT_ID && params[1] === EVENT_ID ? [{ streamId: STREAM_ID, streamSequence: "3" }] : []
    }));
    const db = { query } as unknown as DatabaseClient;

    await expect(findChannelEventPosition(db, TENANT_ID, EVENT_ID)).resolves.toEqual({
      streamId: STREAM_ID,
      streamSequence: 3
    });
    await expect(
      findChannelEventPosition(db, "20000000-0000-4000-8000-000000000099", EVENT_ID)
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
