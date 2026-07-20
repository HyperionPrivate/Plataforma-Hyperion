import type { DatabaseClient } from "@hyperion/database";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDurableOutboxConfiguration, registerChannelRoutes } from "./app.js";
import type { WhatsAppChannelService } from "./channel-service.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const INTEGRATION_TOKEN = "test-integration-to-channel-token";
const SOFIA_TOKEN = "test-sofia-to-channel-token";
let app: ServiceHandle["app"] | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("whatsapp-channel internal API", () => {
  it("requires internal authentication for status and QR", async () => {
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance, context) =>
        registerChannelRoutes(
          instance,
          {
            channel: fakeChannel(),
            integrationCredential: INTEGRATION_TOKEN,
            sofiaCredential: SOFIA_TOKEN
          },
          withActiveSnapshot(context)
        )
    }));

    const missing = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/status`
    });
    const wrong = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/qr`,
      headers: { authorization: "Bearer wrong", "x-hyperion-caller": "integration-service" }
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it("returns a PNG data URL without exposing the raw QR or any secret", async () => {
    const rawQr = "sensitive-qr-material-never-log-or-persist";
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance, context) =>
        registerChannelRoutes(
          instance,
          {
            channel: fakeChannel(rawQr),
            integrationCredential: INTEGRATION_TOKEN,
            sofiaCredential: SOFIA_TOKEN
          },
          withActiveSnapshot(context)
        )
    }));

    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/qr`,
      headers: integrationHeaders()
    });
    const payload = response.json().data;

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
    expect(payload).toMatchObject({
      tenantId: TENANT_ID,
      providerMode: "whatsapp_web_test",
      state: "qr_pending",
      qrExpiresAt: "2026-07-09T20:00:00.000Z"
    });
    expect(payload.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(payload)).not.toContain(rawQr);
    expect(JSON.stringify(payload)).not.toContain(INTEGRATION_TOKEN);
  });

  it("returns only a masked account identifier in status", async () => {
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance, context) =>
        registerChannelRoutes(
          instance,
          {
            channel: fakeChannel(),
            integrationCredential: INTEGRATION_TOKEN,
            sofiaCredential: SOFIA_TOKEN
          },
          withActiveSnapshot(context)
        )
    }));
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/status`,
      headers: integrationHeaders()
    });

    expect(response.json().data).toMatchObject({
      tenantId: TENANT_ID,
      providerMode: "whatsapp_web_test",
      state: "qr_pending",
      phoneMasked: "********4567",
      sessionRestorable: false
    });
  });

  it("binds management and message routes to different caller identities", async () => {
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance, context) =>
        registerChannelRoutes(
          instance,
          {
            channel: fakeChannel(),
            integrationCredential: INTEGRATION_TOKEN,
            sofiaCredential: SOFIA_TOKEN
          },
          withActiveSnapshot(context)
        )
    }));

    const integrationCannotSend = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/messages`,
      headers: integrationHeaders(),
      payload: {
        threadBindingId: "00000000-0000-4000-8000-000000000002",
        messageId: "00000000-0000-4000-8000-000000000003",
        text: "hola",
        idempotencyKey: "identity-bound-message"
      }
    });
    const sofiaCannotManage = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/status`,
      headers: sofiaHeaders()
    });
    const spoofedCaller = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/status`,
      headers: {
        authorization: `Bearer ${INTEGRATION_TOKEN}`,
        "x-hyperion-caller": "agent-service"
      }
    });

    expect(integrationCannotSend.statusCode).toBe(403);
    expect(sofiaCannotManage.statusCode).toBe(403);
    expect(spoofedCaller.statusCode).toBe(403);
  });

  it("rejects tenant-scoped reads when the Access projection is missing", async () => {
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance, context) =>
        registerChannelRoutes(
          instance,
          {
            channel: fakeChannel(),
            integrationCredential: INTEGRATION_TOKEN,
            sofiaCredential: SOFIA_TOKEN
          },
          withSnapshot(context, null)
        )
    }));

    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/status`,
      headers: integrationHeaders()
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().data).toEqual({ error: "Tenant snapshot not found; bootstrap required" });
  });

  it("rejects connect when the Access projection is paused", async () => {
    const connect = vi.fn(async () => ({
      providerMode: "whatsapp_web_test" as const,
      state: "connecting" as const,
      phoneMasked: null,
      qrExpiresAt: null,
      sessionRestorable: false
    }));
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance, context) =>
        registerChannelRoutes(
          instance,
          {
            channel: { ...fakeChannel(), connect } as unknown as WhatsAppChannelService,
            integrationCredential: INTEGRATION_TOKEN,
            sofiaCredential: SOFIA_TOKEN
          },
          withSnapshot(context, "paused")
        )
    }));

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/connect`,
      headers: integrationHeaders()
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data).toEqual({
      error: "Tenant is not active for channel operations",
      status: "paused"
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects outbound enqueue when the Access projection is archived", async () => {
    const enqueueOutbound = vi.fn();
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance, context) =>
        registerChannelRoutes(
          instance,
          {
            channel: { ...fakeChannel(), enqueueOutbound } as unknown as WhatsAppChannelService,
            integrationCredential: INTEGRATION_TOKEN,
            sofiaCredential: SOFIA_TOKEN
          },
          withSnapshot(context, "archived")
        )
    }));

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/messages`,
      headers: sofiaHeaders(),
      payload: {
        threadBindingId: "00000000-0000-4000-8000-000000000002",
        messageId: "00000000-0000-4000-8000-000000000003",
        text: "hola",
        idempotencyKey: "archived-tenant-message"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data).toEqual({
      error: "Tenant is not active for channel operations",
      status: "archived"
    });
    expect(enqueueOutbound).not.toHaveBeenCalled();
  });
});

describe("whatsapp-channel durable outbox configuration", () => {
  const natsTestSecret = "nats-test-secret-with-24-characters";
  it("keeps HTTP as the default and honors both disable switches", () => {
    expect(readDurableOutboxConfiguration({})).toEqual({ transport: "http", enabled: true });
    expect(readDurableOutboxConfiguration({ DURABLE_HTTP_OUTBOX_ENABLED: "false" })).toEqual({
      transport: "http",
      enabled: false
    });
    expect(readDurableOutboxConfiguration({ DURABLE_OUTBOX_ENABLED: "false" })).toEqual({
      transport: "http",
      enabled: false
    });
  });

  it("requires explicit credential-separated JetStream configuration", () => {
    expect(
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_AUTH_TOKEN: natsTestSecret
      })
    ).toEqual({
      transport: "jetstream",
      enabled: true,
      natsUrl: "nats://nats:4222",
      authentication: { authToken: natsTestSecret }
    });
    expect(() =>
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://user:password@nats:4222",
        NATS_AUTH_TOKEN: natsTestSecret
      })
    ).toThrow("must not contain credentials");
    expect(() =>
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222"
      })
    ).toThrow("NATS authentication is required");
  });

  it("requires a per-service username identity in production", () => {
    expect(() =>
      readDurableOutboxConfiguration({
        NODE_ENV: "test",
        HYPERION_ENVIRONMENT: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_AUTH_TOKEN: natsTestSecret
      })
    ).toThrow("token authentication is not allowed");
  });

  it("rejects unknown transports", () => {
    expect(() => readDurableOutboxConfiguration({ DURABLE_EVENT_TRANSPORT: "unknown" })).toThrow(
      "DURABLE_EVENT_TRANSPORT must be either http or jetstream"
    );
  });

  it.each([
    "https://nats:4222",
    "nats://nats:4222/",
    "nats://nats:4222/path",
    "nats://nats:4222?token=unsafe",
    "nats://nats:4222#fragment"
  ])("rejects a non-NATS or component-bearing broker URL %s", (natsUrl) => {
    expect(() =>
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: natsUrl,
        NATS_AUTH_TOKEN: natsTestSecret
      })
    ).toThrow("NATS_URL");
  });
});

function fakeChannel(rawQr = "qr"): WhatsAppChannelService {
  return {
    status: async () => ({
      providerMode: "whatsapp_web_test",
      state: "qr_pending",
      phoneMasked: "********4567",
      qrExpiresAt: "2026-07-09T20:00:00.000Z",
      sessionRestorable: false
    }),
    qr: () => ({ qr: rawQr, expiresAt: "2026-07-09T20:00:00.000Z" })
  } as unknown as WhatsAppChannelService;
}

function withActiveSnapshot<T extends { db?: DatabaseClient }>(context: T): T {
  return withSnapshot(context, "active");
}

function withSnapshot<T extends { db?: DatabaseClient }>(
  context: T,
  status: "active" | "paused" | "archived" | null
): T {
  const query = vi.fn(async (sql: string) => {
    if (!sql.includes("channel_runtime.tenant_snapshots")) {
      return { rows: [], rowCount: 0 };
    }
    if (status === null) return { rows: [], rowCount: 0 };
    return { rows: [{ status, sourceVersion: "1" }], rowCount: 1 };
  });
  return {
    ...context,
    db: { query } as unknown as DatabaseClient
  };
}

function integrationHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${INTEGRATION_TOKEN}`,
    "x-hyperion-caller": "integration-service"
  };
}

function sofiaHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${SOFIA_TOKEN}`,
    "x-hyperion-caller": "agent-service"
  };
}
