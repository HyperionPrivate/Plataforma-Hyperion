import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { readDurableOutboxConfiguration, registerChannelRoutes } from "./app.js";
import type { WhatsAppChannelService } from "./channel-service.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN = "test-internal-service-token";
let app: ServiceHandle["app"] | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("whatsapp-channel internal API", () => {
  it("requires internal authentication for status and QR", async () => {
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance) =>
        registerChannelRoutes(instance, { channel: fakeChannel(), internalServiceToken: TOKEN })
    }));

    const missing = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/status`
    });
    const wrong = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/qr`,
      headers: { authorization: "Bearer wrong" }
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it("returns a PNG data URL without exposing the raw QR or any secret", async () => {
    const rawQr = "sensitive-qr-material-never-log-or-persist";
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance) =>
        registerChannelRoutes(instance, {
          channel: fakeChannel(rawQr),
          internalServiceToken: TOKEN
        })
    }));

    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/qr`,
      headers: { authorization: `Bearer ${TOKEN}` }
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
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
  });

  it("returns only a masked account identifier in status", async () => {
    ({ app } = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: (instance) =>
        registerChannelRoutes(instance, { channel: fakeChannel(), internalServiceToken: TOKEN })
    }));
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/status`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });

    expect(response.json().data).toMatchObject({
      tenantId: TENANT_ID,
      providerMode: "whatsapp_web_test",
      state: "qr_pending",
      phoneMasked: "********4567",
      sessionRestorable: false
    });
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
        NODE_ENV: "production",
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
