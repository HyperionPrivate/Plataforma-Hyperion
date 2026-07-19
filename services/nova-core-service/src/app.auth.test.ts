import Fastify from "fastify";
import {
  createInternalAuthorizationHeaders,
  createProductSystemAssertionHeaders
} from "@hyperion/nova-service-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./app.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const gatewayToken = "gateway-to-nova-test-token-00001";
const novaBffToken = "nova-bff-to-core-test-token-0001";
const voiceToken = "voice-to-nova-test-token-000001";
const assertionKey = "nova-operator-assertion-key-0001";

describe("NOVA core edge identities", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.stubEnv("GATEWAY_TO_NOVA_TOKEN", gatewayToken);
    vi.stubEnv("NOVA_BFF_TO_NOVA_TOKEN", novaBffToken);
    vi.stubEnv("GATEWAY_OPERATOR_ASSERTION_KEY", "gateway-operator-assertion-key-01");
    vi.stubEnv("NOVA_OPERATOR_ASSERTION_KEY", assertionKey);
    vi.stubEnv("VOICE_TO_NOVA_TOKEN", voiceToken);
    app = Fastify();
    await registerRoutes(app, {
      config: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    } as never);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("rejects the wrong token and an untrusted caller before route execution", async () => {
    const wrongToken = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/nova/catalog`,
      headers: createInternalAuthorizationHeaders("nova-bff", gatewayToken)
    });
    const wrongCaller = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/nova/catalog`,
      headers: createInternalAuthorizationHeaders("untrusted-edge", novaBffToken)
    });

    expect(wrongToken.statusCode).toBe(401);
    expect(wrongCaller.statusCode).toBe(403);
  });

  it("rejects provider events unless producer, tenant and NOVA are signed together", async () => {
    const body = { tenantId };
    const workload = createInternalAuthorizationHeaders("voice-channel-service", voiceToken);
    const unsigned = await app.inject({ method: "POST", url: "/internal/events", headers: workload, payload: body });
    const wrongProducer = await app.inject({
      method: "POST",
      url: "/internal/events",
      headers: {
        ...workload,
        ...createProductSystemAssertionHeaders({
          serviceId: "liwa-channel-service",
          tenantId,
          productId: "NOVA",
          secret: assertionKey
        })
      },
      payload: body
    });
    const valid = await app.inject({
      method: "POST",
      url: "/internal/events",
      headers: {
        ...workload,
        ...createProductSystemAssertionHeaders({
          serviceId: "voice-channel-service",
          tenantId,
          productId: "NOVA",
          secret: assertionKey
        })
      },
      payload: body
    });

    expect(unsigned.statusCode).toBe(403);
    expect(wrongProducer.statusCode).toBe(403);
    expect(valid.statusCode).toBe(503);
  });
});
