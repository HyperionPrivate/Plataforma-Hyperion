import Fastify from "fastify";
import { createHmac } from "node:crypto";
import {
  createInternalAuthorizationHeaders,
  createProductSystemAssertionHeaders
} from "@hyperion/nova-service-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./app.js";
import { registerVoiceRoutes } from "./routes.js";

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

describe("legacy call reconciliation", () => {
  it("marks a missing provider record abandoned without asking the current Dialer to mutate it", async () => {
    const app = Fastify();
    const dialer = { reconcileCall: vi.fn() };
    const transactionQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const transaction = vi.fn(async (callback: (client: { query: typeof transactionQuery }) => unknown) =>
      callback({ query: transactionQuery })
    );
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          contactId: "11111111-1111-4111-8111-111111111111",
          campaignId: null,
          enrollmentId: null,
          dialerCallRef: "33333333-3333-4333-8333-333333333333",
          correlationId: "44444444-4444-4444-8444-444444444444"
        }
      ]
    });

    await registerVoiceRoutes(
      app,
      {
        config: {},
        db: { query, transaction, close: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
      } as never,
      { dialer: dialer as never }
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/voice/calls/55555555-5555-4555-8555-555555555555/reconcile`,
      payload: {
        result_code: "legacy_provider_state_unavailable_after_cutover",
        disposition: "not_redialed",
        resolution: "abandoned",
        provider_record_absent: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("failed");
    expect(dialer.reconcileCall).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects claiming an absent provider record for a successful resolution", async () => {
    const app = Fastify();
    const query = vi.fn();
    await registerVoiceRoutes(
      app,
      {
        config: {},
        db: { query, transaction: vi.fn(), close: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
      } as never,
      { dialer: { reconcileCall: vi.fn() } as never }
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/voice/calls/55555555-5555-4555-8555-555555555555/reconcile`,
      payload: {
        result_code: "unsafe-success",
        resolution: "confirmed_initiated",
        provider_record_absent: true
      }
    });

    expect(response.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
});

function context() {
  return {
    config: {},
    db: { query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  } as never;
}
