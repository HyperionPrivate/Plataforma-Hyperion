import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { registerChannelRoutes } from "./app.js";
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
