import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "./llm-provider.js";
import { isUrgencySignal, SofiaRuntime } from "./sofia-runtime.js";

describe("SOFIA deterministic urgency guard", () => {
  it("stops scheduling for controlled urgency phrases", () => {
    expect(isUrgencySignal("Perdí la visión de forma repentina")).toBe(true);
    expect(isUrgencySignal("Tuve un golpe fuerte en el ojo")).toBe(true);
    expect(isUrgencySignal("Tengo picazón y el ojo rojo")).toBe(true);
  });

  it("does not classify ordinary scheduling requests as urgency", () => {
    expect(isUrgencySignal("Quiero una consulta de optometría en Sotomayor")).toBe(false);
  });

  it("does not downgrade a completed conversation when an inbound event is redelivered", async () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000001",
      tenantId: "00000000-0000-4000-8000-000000000002",
      threadBindingId: "00000000-0000-4000-8000-000000000003",
      externalMessageId: "provider-message-1",
      phoneHash: "a".repeat(64),
      phoneMasked: "+57******1234",
      body: "Hola",
      occurredAt: new Date().toISOString(),
      attemptCount: 1
    };
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
      }),
      transaction: vi.fn(),
      close: vi.fn()
    } as unknown as DatabaseClient;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/internal/v1/whatsapp/inbound/claim")) {
        return jsonResponse({ events: [event] });
      }
      if (target.includes("identify_patient_by_phone")) {
        return jsonResponse({
          patientId: "00000000-0000-4000-8000-000000000004",
          conversationId: "00000000-0000-4000-8000-000000000005",
          messageId: "00000000-0000-4000-8000-000000000006"
        });
      }
      return jsonResponse({ completed: true });
    });
    const llm = {
      name: "test",
      model: "test",
      isConfigured: () => true,
      complete: vi.fn()
    } as unknown as LlmProvider;
    const runtime = new SofiaRuntime({
      db,
      logger: { warn: vi.fn() },
      llm,
      internalServiceToken: "test-token",
      channelUrl: "http://channel.test",
      promptFlowUrl: "http://prompt.test",
      pulsoIrisUrl: "http://pulso.test",
      auditUrl: "http://audit.test",
      fetchImpl: fetchImpl as typeof fetch
    });

    await runtime.ingestOnce();

    expect(queries.some((sql) => sql.includes("'sofiaStatus', 'queued'"))).toBe(false);
  });
});

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}
