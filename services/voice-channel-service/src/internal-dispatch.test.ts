import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerVoiceRoutes } from "./routes.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CALL_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";

describe("voice.call.requested ingestion", () => {
  it.each(["voice.call.requested", "voice.call.requested.v2"] as const)(
    "claims %s before the provider call and does not redial a duplicate",
    async (eventType) => {
      let inboxClaimed = false;
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("insert into voice.inbox_events")) {
          if (inboxClaimed) return { rows: [], rowCount: 0 };
          inboxClaimed = true;
          return { rows: [{ event_id: EVENT_ID }], rowCount: 1 };
        }
        if (sql.includes("from voice.inbox_events")) {
          return { rows: [{ identityMatches: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });
      const db = {
        query,
        transaction: (work: (tx: { query: typeof query }) => unknown) => work({ query }),
        close: vi.fn()
      };
      const dialer = {
        placeCall: vi.fn().mockResolvedValue({ callRef: "provider-call-1", status: "initiated" })
      };
      const app = Fastify();
      await registerVoiceRoutes(
        app,
        { config: {}, db, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as never,
        { dialer: dialer as never }
      );

      const payload = {
        id: EVENT_ID,
        type: eventType,
        version: 1,
        occurredAt: new Date().toISOString(),
        tenantId: TENANT_ID,
        correlationId: "55555555-5555-4555-8555-555555555555",
        payload: {
          call_id: CALL_ID,
          contact_id: CONTACT_ID,
          phone_e164: "+573001234567",
          product_flow: "renovacion",
          ...(eventType === "voice.call.requested.v2" ? { dynamic_vars: { nombre: "Asociado" } } : {})
        }
      };

      const first = await app.inject({ method: "POST", url: "/v1/voice/internal/events", payload });
      const duplicate = await app.inject({ method: "POST", url: "/v1/voice/internal/events", payload });

      expect(first.statusCode).toBe(200);
      expect(duplicate.statusCode).toBe(202);
      expect(duplicate.json().data.status).toBe("duplicate");
      expect(dialer.placeCall).toHaveBeenCalledTimes(1);
      expect(
        query.mock.calls.findIndex(([sql]) => String(sql).includes("insert into voice.inbox_events"))
      ).toBeLessThan(query.mock.calls.findIndex(([sql]) => String(sql).includes("insert into voice.calls")));
      await app.close();
    }
  );
});
