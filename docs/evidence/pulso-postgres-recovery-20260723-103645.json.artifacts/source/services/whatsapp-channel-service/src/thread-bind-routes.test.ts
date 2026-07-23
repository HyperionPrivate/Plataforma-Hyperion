import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerThreadBindRoutes } from "./thread-bind-routes.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const THREAD_ID = "30000000-0000-4000-8000-000000000001";
const PATIENT_ID = "40000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "50000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "60000000-0000-4000-8000-000000000001";
const TOKEN = "pulso-to-channel-test-token";

describe("Channel thread bind owner routes", () => {
  let app: ServiceHandle["app"] | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("authorizes pulso-iris-service for bind and rejects other callers", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("channel_runtime.tenant_snapshots")) {
        return { rows: [{ status: "active", sourceVersion: "1" }], rowCount: 1 };
      }
      if (sql.includes("for update")) return { rows: [{ id: THREAD_ID }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const service = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: async (serviceApp, context) => {
        registerThreadBindRoutes(
          serviceApp,
          {
            ...context,
            db: {
              query,
              transaction: async (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query })
            }
          } as never,
          TOKEN
        );
      }
    });
    app = service.app;

    const missing = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/threads/${THREAD_ID}/bind`,
      payload: {
        patientId: PATIENT_ID,
        conversationId: CONVERSATION_ID,
        externalMessageId: "ext-1",
        messageId: MESSAGE_ID
      }
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/threads/${THREAD_ID}/bind`,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "agent-service" },
      payload: {
        patientId: PATIENT_ID,
        conversationId: CONVERSATION_ID,
        externalMessageId: "ext-1",
        messageId: MESSAGE_ID
      }
    });
    const ok = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/threads/${THREAD_ID}/bind`,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "pulso-iris-service" },
      payload: {
        patientId: PATIENT_ID,
        conversationId: CONVERSATION_ID,
        externalMessageId: "ext-1",
        messageId: MESSAGE_ID
      }
    });

    expect(missing.statusCode).toBe(401);
    expect([401, 403]).toContain(forbidden.statusCode);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ bound: true });
  });

  it("rejects bind when the Access projection is paused", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("channel_runtime.tenant_snapshots")) {
        return { rows: [{ status: "paused", sourceVersion: "2" }], rowCount: 1 };
      }
      return { rows: [{ id: THREAD_ID }], rowCount: 1 };
    });
    const service = await createService({
      serviceName: "whatsapp-channel-service",
      registerRoutes: async (serviceApp, context) => {
        registerThreadBindRoutes(
          serviceApp,
          {
            ...context,
            db: {
              query,
              transaction: async (fn: (tx: { query: typeof query }) => Promise<unknown>) => fn({ query })
            }
          } as never,
          TOKEN
        );
      }
    });
    app = service.app;

    const response = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/whatsapp/threads/${THREAD_ID}/bind`,
      headers: { authorization: `Bearer ${TOKEN}`, "x-hyperion-caller": "pulso-iris-service" },
      payload: {
        patientId: PATIENT_ID,
        conversationId: CONVERSATION_ID,
        externalMessageId: "ext-1",
        messageId: MESSAGE_ID
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data).toEqual({
      error: "Tenant is not active for channel operations",
      status: "paused"
    });
  });
});
