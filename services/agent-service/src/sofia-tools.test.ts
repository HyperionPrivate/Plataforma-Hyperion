import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import { isExplicitConfirmation, SofiaToolClient } from "./sofia-tools.js";

const context = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  patientId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000003",
  currentMessageId: "00000000-0000-4000-8000-000000000004",
  currentMessageBody: "Quiero cancelar",
  jobId: "00000000-0000-4000-8000-000000000005",
  sequence: 1
};

describe("SOFIA tool confirmation barrier", () => {
  it("accepts only an explicit bounded confirmation", () => {
    expect(isExplicitConfirmation("CONFIRMO cancelar")).toBe(true);
    expect(isExplicitConfirmation("Sí, confirmo la cita")).toBe(true);
    expect(isExplicitConfirmation("de acuerdo")).toBe(false);
    expect(isExplicitConfirmation("quiero cancelar")).toBe(false);
  });

  it("stages a mutation without calling PULSO IRIS until confirmation", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0, command: "UPDATE", oid: 0, fields: [] }));
    const fetchImpl = vi.fn();
    const client = new SofiaToolClient({
      pulsoIrisUrl: "http://pulso.test",
      internalServiceToken: "internal-test-token",
      db: { query, transaction: vi.fn(), close: vi.fn() } as unknown as DatabaseClient,
      fetchImpl: fetchImpl as typeof fetch
    });
    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId: "00000000-0000-4000-8000-000000000006", reason: "Solicitud del paciente" }),
      context
    );
    expect(result).toMatchObject({ ok: false, code: "explicit_confirmation_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("overrides identity and idempotency fields on a confirmed mutation", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("select coalesce(metadata->'sofiaState'")
        ? [
            {
              state: {
                pendingAction: {
                  tool: "cancel_appointment",
                  arguments: {
                    appointmentId: "00000000-0000-4000-8000-000000000006",
                    reason: "Solicitud del paciente"
                  },
                  stagedAt: new Date().toISOString(),
                  jobId: "00000000-0000-4000-8000-000000000009"
                }
              }
            }
          ]
        : [],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: []
    }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        patientId: context.patientId,
        conversationId: context.conversationId,
        confirmationMessageId: context.currentMessageId
      });
      expect(String(body.idempotencyKey)).toContain(context.jobId);
      return new Response(JSON.stringify({ data: { appointment: { status: "cancelled" } } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = new SofiaToolClient({
      pulsoIrisUrl: "http://pulso.test",
      internalServiceToken: "internal-test-token",
      db: { query, transaction: vi.fn(), close: vi.fn() } as unknown as DatabaseClient,
      fetchImpl: fetchImpl as typeof fetch
    });
    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId: "00000000-0000-4000-8000-000000000006", reason: "Solicitud del paciente" }),
      { ...context, currentMessageBody: "CONFIRMO cancelar" }
    );
    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a confirmation for a different or expired action", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          state: {
            pendingAction: {
              tool: "reschedule_appointment",
              arguments: {},
              stagedAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
              jobId: "00000000-0000-4000-8000-000000000009"
            }
          }
        }
      ],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: []
    }));
    const fetchImpl = vi.fn();
    const client = new SofiaToolClient({
      pulsoIrisUrl: "http://pulso.test",
      internalServiceToken: "internal-test-token",
      db: { query, transaction: vi.fn(), close: vi.fn() } as unknown as DatabaseClient,
      fetchImpl: fetchImpl as typeof fetch
    });
    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId: "00000000-0000-4000-8000-000000000006", reason: "Solicitud del paciente" }),
      { ...context, currentMessageBody: "CONFIRMO" }
    );
    expect(result).toMatchObject({ ok: false, code: "confirmation_action_mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows booking only for the hold granted by the confirmed reservation job", async () => {
    const holdId = "00000000-0000-4000-8000-000000000007";
    const query = vi.fn(async () => ({
      rows: [
        {
          state: {
            confirmationGrant: {
              jobId: context.jobId,
              tool: "book_appointment",
              holdId,
              expiresAt: new Date(Date.now() + 60_000).toISOString()
            }
          }
        }
      ],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: []
    }));
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { appointment: { status: "verified" } } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const client = new SofiaToolClient({
      pulsoIrisUrl: "http://pulso.test",
      internalServiceToken: "internal-test-token",
      db: { query, transaction: vi.fn(), close: vi.fn() } as unknown as DatabaseClient,
      fetchImpl: fetchImpl as typeof fetch
    });

    const allowed = await client.execute("book_appointment", JSON.stringify({ holdId }), {
      ...context,
      currentMessageBody: "CONFIRMO reservar"
    });
    expect(allowed).toMatchObject({ ok: true });

    const denied = await client.execute(
      "book_appointment",
      JSON.stringify({ holdId: "00000000-0000-4000-8000-000000000008" }),
      { ...context, currentMessageBody: "CONFIRMO reservar" }
    );
    expect(denied).toMatchObject({ ok: false, code: "confirmation_action_mismatch" });
  });
});
