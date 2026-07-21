import Fastify from "fastify";
import { createHmac } from "node:crypto";
import {
  createInternalAuthorizationHeaders,
  createProductSystemAssertionHeaders
} from "@hyperion/nova-service-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./app.js";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_TOKEN = "gateway-to-voice-test-token-0001";
const NOVA_BFF_TOKEN = "nova-bff-to-voice-test-token-001";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const NOVA_ASSERTION_KEY = "nova-operator-assertion-key-0001";
const NOVA_TO_VOICE_TOKEN = "nova-to-voice-test-token-000001";

describe("voice product operator assertion", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.stubEnv("HYPERION_ENVIRONMENT", "local");
    vi.stubEnv("GATEWAY_TO_VOICE_TOKEN", GATEWAY_TOKEN);
    vi.stubEnv("NOVA_BFF_TO_VOICE_TOKEN", NOVA_BFF_TOKEN);
    vi.stubEnv("GATEWAY_OPERATOR_ASSERTION_KEY", ASSERTION_KEY);
    vi.stubEnv("NOVA_OPERATOR_ASSERTION_KEY", NOVA_ASSERTION_KEY);
    vi.stubEnv("NOVA_TO_VOICE_TOKEN", NOVA_TO_VOICE_TOKEN);
    for (const name of [
      "DIALER_BASE_URL",
      "DIALER_ADMIN_USER",
      "DIALER_ADMIN_PASSWORD",
      "DIALER_DEMO_API_KEY",
      "VOICE_DIALER_USERNAME",
      "VOICE_DIALER_PASSWORD",
      "VOICE_TO_DIALER_TOKEN",
      "VOICE_TO_NOVA_TOKEN"
    ]) {
      vi.stubEnv(name, "");
    }
    app = Fastify();
    await registerRoutes(app, context());
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("does not expose a direct call mutation route", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/voice/calls`,
      payload: {
        phone_e164: "+573001234567",
        contact_id: "11111111-1111-4111-8111-111111111111"
      }
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects internal NOVA events without a signed workload context", async () => {
    const payload = {
      id: "44444444-4444-4444-8444-444444444444",
      type: "unsupported.event",
      version: 1,
      occurredAt: new Date().toISOString(),
      tenantId: TENANT_ID,
      payload: {}
    };
    const workload = createInternalAuthorizationHeaders("nova-core-service", NOVA_TO_VOICE_TOKEN);
    const unsigned = await app.inject({
      method: "POST",
      url: "/v1/voice/internal/events",
      headers: workload,
      payload
    });
    const valid = await app.inject({
      method: "POST",
      url: "/v1/voice/internal/events",
      headers: {
        ...workload,
        ...createProductSystemAssertionHeaders({
          serviceId: "nova-core-service",
          tenantId: TENANT_ID,
          productId: "NOVA",
          secret: NOVA_ASSERTION_KEY
        })
      },
      payload
    });

    expect(unsigned.statusCode).toBe(403);
    expect(valid.statusCode).toBe(400);
    expect(valid.json().data.error).toBe("Unsupported event type");
  });

  it("validates Dialer HMAC against the exact raw JSON received through the NOVA ingress", async () => {
    const secret = "dialer-provider-webhook-secret-0001";
    const rawBody = '{  "event_id": "dialer-event-1", "status": "completed"  }\n';
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    const canonicalSignature = createHmac("sha256", secret)
      .update(JSON.stringify(JSON.parse(rawBody)))
      .digest("hex");
    vi.stubEnv("DIALER_WEBHOOK_HMAC_SECRET", secret);

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/voice/webhooks/dialer",
      headers: { "content-type": "application/json", "x-dialer-signature": signature },
      payload: rawBody
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/voice/webhooks/dialer",
      headers: { "content-type": "application/json", "x-dialer-signature": canonicalSignature },
      payload: rawBody
    });

    expect(signature).not.toBe(canonicalSignature);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.signature_valid).toBe(true);
    expect(rejected.statusCode).toBe(401);
  });

  it.each(["staging", "production"])(
    "fails closed for an ElevenLabs callback without a dedicated secret in %s",
    async (deployment) => {
      vi.stubEnv("HYPERION_ENVIRONMENT", deployment);
      vi.stubEnv("ELEVENLABS_WEBHOOK_SECRET", "");
      vi.stubEnv("ELEVENLABS_WEBHOOK_HMAC_SECRET", "");

      const response = await app.inject({
        method: "POST",
        url: "/v1/voice/webhooks/elevenlabs",
        headers: { "content-type": "application/json" },
        payload: '{"type":"post_call_transcription","data":{}}'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().data.error).toBe("ElevenLabs webhook secret required");
    }
  );
});

function context() {
  return {
    config: {},
    db: { query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  } as never;
}
