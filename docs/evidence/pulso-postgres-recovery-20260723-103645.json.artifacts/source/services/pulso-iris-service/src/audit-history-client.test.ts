import { describe, expect, it, vi } from "vitest";
import { AuditHistoryUnavailableError, createAuditHistoryClient } from "./audit-history-client.js";

const tenantId = "22222222-2222-4222-8222-222222222222";
const entityId = "33333333-3333-4333-8333-333333333333";

describe("PULSO Audit history client", () => {
  it("fails closed before network access when its edge credential is absent", async () => {
    const fetch = vi.fn();
    const read = createAuditHistoryClient({ auditServiceUrl: "http://audit.test", credential: undefined, fetch });
    await expect(read(tenantId, "appointment", entityId)).rejects.toMatchObject({ statusCode: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the exact source-scoped route and parses the Audit-owned read contract", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              eventType: "appointment.verified",
              actorId: null,
              metadata: {},
              createdAt: "2026-07-18T08:00:00.000Z"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const read = createAuditHistoryClient({
      auditServiceUrl: "http://audit.test/",
      credential: "pulso-audit-query-token",
      fetch
    });

    await expect(read(tenantId, "appointment", entityId)).resolves.toHaveLength(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `http://audit.test/internal/v1/tenants/${tenantId}/audit/entities/appointment/${entityId}/events`
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        authorization: "Bearer pulso-audit-query-token",
        "x-hyperion-caller": "pulso-iris-service"
      }
    });
  });

  it("normalizes upstream and contract failures without exposing their body", async () => {
    const read = createAuditHistoryClient({
      auditServiceUrl: "http://audit.test",
      credential: "pulso-audit-query-token",
      fetch: vi.fn().mockResolvedValue(new Response("secret upstream detail", { status: 500 }))
    });
    await expect(read(tenantId, "appointment", entityId)).rejects.toEqual(
      expect.objectContaining<Partial<AuditHistoryUnavailableError>>({
        message: "Audit history is unavailable",
        statusCode: 502
      })
    );
  });
});
