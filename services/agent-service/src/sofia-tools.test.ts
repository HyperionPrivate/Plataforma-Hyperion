import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import { isExplicitConfirmation, SOFIA_TOOL_DEFINITIONS, SofiaToolClient } from "./sofia-tools.js";

const context = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  patientId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000003",
  currentMessageId: "00000000-0000-4000-8000-000000000004",
  currentMessageBody: "Quiero cancelar",
  jobId: "00000000-0000-4000-8000-000000000005",
  sequence: 1
};

describe("SOFIA tool time contract", () => {
  it("separates local presentation fields from the exact UTC mutation value", () => {
    const searchAvailability = SOFIA_TOOL_DEFINITIONS.find(
      (definition) => definition.function.name === "search_availability"
    );
    const createHold = SOFIA_TOOL_DEFINITIONS.find(
      (definition) => definition.function.name === "create_appointment_hold"
    );
    const reschedule = SOFIA_TOOL_DEFINITIONS.find(
      (definition) => definition.function.name === "reschedule_appointment"
    );

    expect(searchAvailability?.function.description).toContain("localDate");
    expect(searchAvailability?.function.description).toContain("localTime");
    expect(searchAvailability?.function.description).toContain("timeZone");
    expect(searchAvailability?.function.description).toContain("scheduledAt/startsAt");

    for (const mutation of [createHold, reschedule]) {
      const parameters = mutation?.function.parameters as {
        properties?: { scheduledAt?: { description?: string } };
      };
      const description = parameters.properties?.scheduledAt?.description;
      expect(description).toContain("scheduledAt/startsAt");
      expect(description).toContain("localDate/localTime/timeZone");
      expect(description).toContain("sin reinterpretarlo ni convertirlo");
    }
  });
});

describe("SOFIA tool confirmation barrier", () => {
  it("accepts only an explicit bounded confirmation", () => {
    expect(isExplicitConfirmation("CONFIRMO cancelar")).toBe(true);
    expect(isExplicitConfirmation("Sí, confirmo la cita")).toBe(true);
    expect(isExplicitConfirmation("CONFIRMO reagendar")).toBe(true);
    expect(isExplicitConfirmation("de acuerdo")).toBe(false);
    expect(isExplicitConfirmation("quiero cancelar")).toBe(false);
  });

  it("stages a mutation without calling PULSO IRIS until confirmation", async () => {
    let state: Record<string, unknown> = {};
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
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
    expect(state).toMatchObject({ pendingAction: { tool: "cancel_appointment" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reuses an identical cancellation without renewing its action or TTL", async () => {
    let state: Record<string, unknown> = {};
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);
    const appointmentId = "00000000-0000-4000-8000-000000000006";

    await client.execute("cancel_appointment", JSON.stringify({ appointmentId, reason: "Solicitud inicial" }), context);
    const original = structuredClone(state.pendingAction);
    const repeated = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId, reason: "La misma solicitud expresada de otra forma" }),
      {
        ...context,
        currentMessageId: "00000000-0000-4000-8000-000000000010",
        jobId: "00000000-0000-4000-8000-000000000011"
      }
    );

    expect(repeated).toMatchObject({
      ok: false,
      code: "explicit_confirmation_required",
      pendingActionReused: true
    });
    expect(state.pendingAction).toEqual(original);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes the UTC slot when reusing a reschedule and replaces only a different target", async () => {
    let state: Record<string, unknown> = {};
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);
    const base = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      siteId: "00000000-0000-4000-8000-000000000020",
      professionalId: "00000000-0000-4000-8000-000000000021",
      payerId: "00000000-0000-4000-8000-000000000025",
      appointmentTypeId: "00000000-0000-4000-8000-000000000022",
      scheduledAt: "2026-07-13T14:20:00.000Z",
      reason: "Solicitud inicial"
    };

    await client.execute("reschedule_appointment", JSON.stringify(base), context);
    const original = structuredClone(state.pendingAction);
    const repeated = await client.execute(
      "reschedule_appointment",
      JSON.stringify({
        ...base,
        scheduledAt: "2026-07-13T14:20:00Z",
        reason: "Motivo reformulado"
      }),
      {
        ...context,
        currentMessageId: "00000000-0000-4000-8000-000000000010",
        jobId: "00000000-0000-4000-8000-000000000011"
      }
    );
    expect(repeated).toMatchObject({ code: "explicit_confirmation_required", pendingActionReused: true });
    expect(state.pendingAction).toEqual(original);

    const changed = await client.execute(
      "reschedule_appointment",
      JSON.stringify({ ...base, scheduledAt: "2026-07-13T14:40:00.000Z" }),
      {
        ...context,
        currentMessageId: "00000000-0000-4000-8000-000000000012",
        jobId: "00000000-0000-4000-8000-000000000013"
      }
    );
    expect(changed).toMatchObject({ code: "explicit_confirmation_required" });
    expect(changed).not.toHaveProperty("pendingActionReused");
    expect(state.pendingAction).toMatchObject({
      jobId: "00000000-0000-4000-8000-000000000013",
      arguments: { scheduledAt: "2026-07-13T14:40:00.000Z" }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("converges on an identical action after losing the staging CAS race", async () => {
    const winnerJobId = "00000000-0000-4000-8000-000000000011";
    const argumentsValue = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud controlada"
    };
    let state: Record<string, unknown> = {};
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select coalesce(metadata->'sofiaState'")) {
        return queryResult([{ state, pendingExpired: false, grantExpired: false, executionExpired: false }]);
      }
      if (sql.includes("update pulso_iris.conversations")) {
        state = {
          pendingAction: {
            tool: "cancel_appointment",
            arguments: argumentsValue,
            stagedAt: new Date().toISOString(),
            jobId: winnerJobId
          }
        };
        return queryResult([]);
      }
      return queryResult([]);
    });
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const result = await client.execute("cancel_appointment", JSON.stringify(argumentsValue), context);

    expect(result).toMatchObject({
      code: "explicit_confirmation_required",
      pendingActionReused: true
    });
    expect(state).toMatchObject({ pendingAction: { jobId: winnerJobId } });
    expect(fetchImpl).not.toHaveBeenCalled();
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
      expect(body.idempotencyKey).toBe("00000000-0000-4000-8000-000000000009:cancel_appointment");
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

  it("rejects a confirmation for a different action", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          state: {
            pendingAction: {
              tool: "reschedule_appointment",
              arguments: {},
              stagedAt: new Date().toISOString(),
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
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not let an action-specific confirmation authorize another mutation", async () => {
    const query = vi.fn(async () =>
      queryResult([
        {
          state: {
            pendingAction: {
              tool: "create_appointment_hold",
              arguments: {
                siteId: "00000000-0000-4000-8000-000000000020",
                professionalId: "00000000-0000-4000-8000-000000000021",
                payerId: "00000000-0000-4000-8000-000000000025",
                appointmentTypeId: "00000000-0000-4000-8000-000000000022",
                scheduledAt: "2026-07-10T14:00:00.000Z"
              },
              stagedAt: new Date().toISOString(),
              jobId: "00000000-0000-4000-8000-000000000009"
            }
          }
        }
      ])
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const result = await client.execute(
      "create_appointment_hold",
      JSON.stringify({
        siteId: "00000000-0000-4000-8000-000000000020",
        professionalId: "00000000-0000-4000-8000-000000000021",
        payerId: "00000000-0000-4000-8000-000000000025",
        appointmentTypeId: "00000000-0000-4000-8000-000000000022",
        scheduledAt: "2026-07-10T14:00:00.000Z"
      }),
      { ...context, currentMessageBody: "CONFIRMO cancelar" }
    );

    expect(result).toMatchObject({ ok: false, code: "confirmation_action_mismatch" });
    expect(query).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("atomically discards an expired pending action before staging a new one", async () => {
    let state: Record<string, unknown> = {
      pendingAction: {
        tool: "reschedule_appointment",
        arguments: {},
        stagedAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
        jobId: "00000000-0000-4000-8000-000000000009"
      }
    };
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId: "00000000-0000-4000-8000-000000000006", reason: "Solicitud controlada" }),
      { ...context, currentMessageBody: "Quiero cancelar" }
    );

    expect(result).toMatchObject({ ok: false, code: "explicit_confirmation_required" });
    expect(state).toMatchObject({
      pendingAction: {
        tool: "cancel_appointment",
        arguments: { reason: "Solicitud controlada" }
      }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("atomically discards an expired booking grant before staging another action", async () => {
    let state: Record<string, unknown> = {
      confirmationGrant: {
        actionId: "00000000-0000-4000-8000-000000000009",
        tool: "book_appointment",
        holdId: "00000000-0000-4000-8000-000000000007",
        expiresAt: new Date(Date.now() - 1_000).toISOString()
      }
    };
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId: "00000000-0000-4000-8000-000000000006", reason: "Solicitud controlada" }),
      { ...context, currentMessageBody: "Quiero cancelar" }
    );

    expect(result).toMatchObject({ ok: false, code: "explicit_confirmation_required" });
    expect(state).toMatchObject({ pendingAction: { tool: "cancel_appointment" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves a fresh action when expiration cleanup loses a CAS race", async () => {
    const expired = {
      pendingAction: {
        tool: "cancel_appointment",
        arguments: {
          appointmentId: "00000000-0000-4000-8000-000000000006",
          reason: "Solicitud vencida"
        },
        stagedAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
        jobId: "00000000-0000-4000-8000-000000000009"
      }
    };
    const fresh = {
      pendingAction: {
        tool: "reschedule_appointment",
        arguments: {},
        stagedAt: new Date().toISOString(),
        jobId: "00000000-0000-4000-8000-000000000010"
      }
    };
    let reads = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select coalesce(metadata->'sofiaState'")) {
        reads += 1;
        return queryResult([
          reads === 1
            ? { state: expired, pendingExpired: true, grantExpired: false }
            : { state: fresh, pendingExpired: false, grantExpired: false }
        ]);
      }
      return queryResult([]);
    });
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId: "00000000-0000-4000-8000-000000000006", reason: "Solicitud nueva" }),
      { ...context, currentMessageBody: "CONFIRMO" }
    );

    expect(result).toMatchObject({ ok: false, code: "confirmation_action_mismatch" });
    expect(reads).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears an expired matching action without rebuilding it from CONFIRMO arguments", async () => {
    let state: Record<string, unknown> = {
      pendingAction: {
        tool: "cancel_appointment",
        arguments: {
          appointmentId: "00000000-0000-4000-8000-000000000006",
          reason: "Solicitud anterior"
        },
        stagedAt: new Date(Date.now() - 16 * 60 * 1_000).toISOString(),
        jobId: "00000000-0000-4000-8000-000000000009"
      }
    };
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({
        appointmentId: "00000000-0000-4000-8000-000000000006",
        reason: "Solicitud vigente"
      }),
      { ...context, currentMessageBody: "CONFIRMO cancelar" }
    );

    expect(result).toMatchObject({ ok: false, code: "confirmation_action_missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.pendingAction).toBeNull();
  });

  it("executes persisted staged arguments despite JSONB order and raw model drift", async () => {
    const stagedAt = new Date().toISOString();
    const query = vi.fn(async (sql: string) =>
      queryResult(
        sql.includes("select coalesce(metadata->'sofiaState'")
          ? [
              {
                state: {
                  pendingAction: {
                    tool: "create_appointment_hold",
                    arguments: {
                      scheduledAt: "2026-07-10T14:00:00.000Z",
                      appointmentTypeId: "00000000-0000-4000-8000-000000000022",
                      professionalId: "00000000-0000-4000-8000-000000000021",
                      payerId: "00000000-0000-4000-8000-000000000025",
                      siteId: "00000000-0000-4000-8000-000000000020"
                    },
                    stagedAt,
                    jobId: "00000000-0000-4000-8000-000000000009"
                  }
                }
              }
            ]
          : []
      )
    );
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        professionalId: "00000000-0000-4000-8000-000000000021",
        scheduledAt: "2026-07-10T14:00:00.000Z"
      });
      return jsonResponse({ hold: { id: "00000000-0000-4000-8000-000000000007" } });
    });
    const client = createClient(query, fetchImpl);

    const result = await client.execute(
      "create_appointment_hold",
      JSON.stringify({
        siteId: "00000000-0000-4000-8000-000000000020",
        professionalId: "00000000-0000-4000-8000-000000000099",
        payerId: "00000000-0000-4000-8000-000000000025",
        appointmentTypeId: "00000000-0000-4000-8000-000000000022",
        scheduledAt: "2026-07-10T15:00:00.000Z"
      }),
      { ...context, currentMessageBody: "CONFIRMO reservar" }
    );

    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows booking only for the hold granted by the confirmed reservation job", async () => {
    const holdId = "00000000-0000-4000-8000-000000000007";
    let state: Record<string, unknown> = {
      confirmationGrant: {
        actionId: context.jobId,
        tool: "book_appointment",
        holdId,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }
    };
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ holdId, idempotencyKey: `${context.jobId}:book_appointment` });
      return jsonResponse({ appointment: { status: "verified" } });
    });
    const client = createClient(query, fetchImpl);

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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("executes only once when the patient sends CONFIRMO repeatedly in sequence", async () => {
    const actionId = "00000000-0000-4000-8000-000000000009";
    let state: Record<string, unknown> = {
      pendingAction: {
        tool: "cancel_appointment",
        arguments: {
          appointmentId: "00000000-0000-4000-8000-000000000006",
          reason: "Solicitud del paciente"
        },
        stagedAt: new Date().toISOString(),
        jobId: actionId
      }
    };
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const idempotencyKeys: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      idempotencyKeys.push(String(body.idempotencyKey));
      return jsonResponse({ appointment: { status: "cancelled" }, idempotent: false });
    });
    const client = createClient(query, fetchImpl);
    const args = JSON.stringify({
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud del paciente"
    });

    const first = await client.execute("cancel_appointment", args, {
      ...context,
      currentMessageBody: "CONFIRMO cancelar"
    });
    const repeated = await client.execute("cancel_appointment", args, {
      ...context,
      currentMessageId: "00000000-0000-4000-8000-000000000010",
      currentMessageBody: "CONFIRMO",
      jobId: "00000000-0000-4000-8000-000000000011"
    });

    expect(first).toMatchObject({ ok: true });
    expect(repeated).toMatchObject({ ok: false, code: "confirmation_action_missing" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(idempotencyKeys).toEqual([`${actionId}:cancel_appointment`]);
  });

  it("never stages a new action from a bare CONFIRMO", async () => {
    const slot = {
      siteId: "00000000-0000-4000-8000-000000000020",
      professionalId: "00000000-0000-4000-8000-000000000021",
      payerId: "00000000-0000-4000-8000-000000000025",
      appointmentTypeId: "00000000-0000-4000-8000-000000000022",
      scheduledAt: "2026-07-10T14:00:00.000Z"
    };
    let state: Record<string, unknown> = { lastAvailability: { slots: [slot] } };
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);
    const firstConfirmation = { ...context, currentMessageBody: "CONFIRMO reservar" };

    const staged = await client.execute("create_appointment_hold", JSON.stringify(slot), firstConfirmation);
    const sameJobReplay = await client.execute("create_appointment_hold", JSON.stringify(slot), firstConfirmation);
    const nextMessage = await client.execute("create_appointment_hold", JSON.stringify(slot), {
      ...firstConfirmation,
      currentMessageId: "00000000-0000-4000-8000-000000000010",
      jobId: "00000000-0000-4000-8000-000000000011"
    });

    expect(staged).toMatchObject({ ok: false, code: "confirmation_action_missing" });
    expect(sameJobReplay).toMatchObject({ ok: false, code: "confirmation_action_missing" });
    expect(nextMessage).toMatchObject({ ok: false, code: "confirmation_action_missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state).toMatchObject({ lastAvailability: { slots: [slot] } });
  });

  it("uses one stable domain idempotency key for concurrent CONFIRMO messages", async () => {
    const actionId = "00000000-0000-4000-8000-000000000009";
    const pendingState = {
      pendingAction: {
        tool: "cancel_appointment",
        arguments: {
          appointmentId: "00000000-0000-4000-8000-000000000006",
          reason: "Solicitud del paciente"
        },
        stagedAt: new Date().toISOString(),
        jobId: actionId
      }
    };
    const query = vi.fn(async (sql: string) =>
      queryResult(sql.includes("select coalesce(metadata->'sofiaState'") ? [{ state: pendingState }] : [])
    );
    const keys = new Set<string>();
    let domainEffects = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const key = String(body.idempotencyKey);
      if (!keys.has(key)) domainEffects += 1;
      keys.add(key);
      await Promise.resolve();
      return jsonResponse({ appointment: { status: "cancelled" }, idempotent: domainEffects !== 1 });
    });
    const client = createClient(query, fetchImpl);
    const args = JSON.stringify({
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud del paciente"
    });

    const results = await Promise.all([
      client.execute("cancel_appointment", args, {
        ...context,
        currentMessageBody: "CONFIRMO cancelar"
      }),
      client.execute("cancel_appointment", args, {
        ...context,
        currentMessageId: "00000000-0000-4000-8000-000000000010",
        currentMessageBody: "CONFIRMO cancelar",
        jobId: "00000000-0000-4000-8000-000000000011"
      })
    ]);

    expect(results).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...keys]).toEqual([`${actionId}:cancel_appointment`]);
    expect(domainEffects).toBe(1);
  });

  it("keeps the action id across hold creation and final booking", async () => {
    const actionId = "00000000-0000-4000-8000-000000000009";
    const holdId = "00000000-0000-4000-8000-000000000007";
    const slot = {
      siteId: "00000000-0000-4000-8000-000000000020",
      professionalId: "00000000-0000-4000-8000-000000000021",
      payerId: "00000000-0000-4000-8000-000000000025",
      appointmentTypeId: "00000000-0000-4000-8000-000000000022",
      scheduledAt: "2026-07-10T14:00:00.000Z"
    };
    let state: Record<string, unknown> = {
      pendingAction: {
        tool: "create_appointment_hold",
        arguments: slot,
        stagedAt: new Date().toISOString(),
        jobId: actionId
      }
    };
    const query = statefulConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const idempotencyKeys: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      idempotencyKeys.push(String(body.idempotencyKey));
      return String(url).endsWith("/create_appointment_hold")
        ? jsonResponse({ hold: { id: holdId } })
        : jsonResponse({ appointment: { status: "verified" }, idempotent: false });
    });
    const client = createClient(query, fetchImpl);
    const confirmationContext = { ...context, currentMessageBody: "CONFIRMO reservar" };

    expect(await client.execute("create_appointment_hold", JSON.stringify(slot), confirmationContext)).toMatchObject({
      ok: true
    });
    expect(await client.execute("book_appointment", JSON.stringify({ holdId }), confirmationContext)).toMatchObject({
      ok: true
    });
    expect(idempotencyKeys).toEqual([`${actionId}:create_appointment_hold`, `${actionId}:book_appointment`]);
  });
});

describe("SOFIA deterministic durable confirmation", () => {
  const actionId = "00000000-0000-4000-8000-000000000009";
  const confirmationContext = {
    ...context,
    currentMessageId: "00000000-0000-4000-8000-000000000010",
    currentMessageBody: "CONFIRMO reservar",
    jobId: "00000000-0000-4000-8000-000000000011"
  };
  const slot = {
    siteId: "00000000-0000-4000-8000-000000000020",
    professionalId: "00000000-0000-4000-8000-000000000021",
    payerId: "00000000-0000-4000-8000-000000000025",
    appointmentTypeId: "00000000-0000-4000-8000-000000000022",
    scheduledAt: "2026-07-13T14:00:00.000Z"
  };

  it("claims the persisted action, creates the hold, books it and replays its durable receipt", async () => {
    let state: Record<string, unknown> = pendingState("create_appointment_hold", slot, actionId);
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const holdId = "00000000-0000-4000-8000-000000000007";
    const calls: Array<{ tool: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const tool = String(url).split("/").at(-1) ?? "";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ tool, body });
      return tool === "create_appointment_hold"
        ? jsonResponse({ hold: { id: holdId, expiresAt: "2026-07-13T13:59:00.000Z" } })
        : jsonResponse({ appointment: confirmedAppointment("verified"), idempotent: false });
    });
    const client = createClient(query, fetchImpl);

    const first = await client.confirmPendingAction(confirmationContext);
    const replay = await client.confirmPendingAction(confirmationContext);

    expect(first).toMatchObject({ handled: true, ok: true, status: "completed", action: "book", replayed: false });
    expect(replay).toMatchObject({ handled: true, ok: true, status: "completed", action: "book", replayed: true });
    expect(calls.map(({ tool }) => tool)).toEqual(["create_appointment_hold", "book_appointment"]);
    expect(calls[0]?.body).toMatchObject({
      ...slot,
      patientId: context.patientId,
      conversationId: context.conversationId,
      confirmationMessageId: confirmationContext.currentMessageId,
      idempotencyKey: `${actionId}:create_appointment_hold`
    });
    expect(calls[1]?.body).toMatchObject({
      holdId,
      idempotencyKey: `${actionId}:book_appointment`
    });
    expect(state).toMatchObject({
      pendingAction: null,
      confirmationExecution: null,
      confirmationGrant: null,
      confirmationReceipts: {
        [confirmationContext.currentMessageId]: {
          actionId,
          action: "book",
          outcome: "completed"
        }
      }
    });
  });

  it("keeps a claimed cancellation on a transient failure and resumes with the same idempotency key", async () => {
    const cancellation = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud del paciente"
    };
    let state: Record<string, unknown> = pendingState("cancel_appointment", cancellation, actionId);
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    let attempt = 0;
    const keys: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      keys.push(String(body.idempotencyKey));
      attempt += 1;
      return attempt === 1
        ? new Response(JSON.stringify({ data: { code: "agenda_unavailable" } }), {
            status: 503,
            headers: { "content-type": "application/json" }
          })
        : jsonResponse({
            appointment: confirmedAppointment("cancelled", cancellation.appointmentId),
            idempotent: true
          });
    });
    const client = createClient(query, fetchImpl);
    const cancelContext = { ...confirmationContext, currentMessageBody: "CONFIRMO cancelar" };

    const first = await client.confirmPendingAction(cancelContext);
    expect(first).toMatchObject({ ok: false, status: "retryable_failure", action: "cancel" });
    expect(state).toMatchObject({
      pendingAction: null,
      confirmationExecution: { actionId, confirmationMessageId: confirmationContext.currentMessageId }
    });

    const resumed = await client.confirmPendingAction(cancelContext);
    expect(resumed).toMatchObject({ ok: true, status: "completed", action: "cancel" });
    expect(keys).toEqual([`${actionId}:cancel_appointment`, `${actionId}:cancel_appointment`]);
  });

  it("rejects cancellation evidence for a different appointment or without local details", async () => {
    const cancellation = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud del paciente"
    };
    const invalidEvidence = [
      confirmedAppointment("cancelled"),
      { ...confirmedAppointment("cancelled", cancellation.appointmentId), localTime: undefined }
    ];
    for (const appointment of invalidEvidence) {
      let state: Record<string, unknown> = pendingState("cancel_appointment", cancellation, actionId);
      const query = durableConfirmationQuery(
        () => state,
        (next) => {
          state = next;
        }
      );
      const fetchImpl = vi.fn(async () => jsonResponse({ appointment, idempotent: false }));
      const client = createClient(query, fetchImpl);

      const result = await client.confirmPendingAction({
        ...confirmationContext,
        currentMessageBody: "CONFIRMO cancelar"
      });

      expect(result).toMatchObject({
        ok: false,
        status: "retryable_failure",
        code: "invalid_mutation_response",
        action: "cancel"
      });
      expect(state).toMatchObject({
        confirmationExecution: { actionId, tool: "cancel_appointment", arguments: cancellation },
        confirmationReceipts: {}
      });
    }
  });

  it("revokes a terminal action and replays the failure without another domain call", async () => {
    const cancellation = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud del paciente"
    };
    let state: Record<string, unknown> = pendingState("cancel_appointment", cancellation, actionId);
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { code: "invalid_transition" } }), {
          status: 409,
          headers: { "content-type": "application/json" }
        })
    );
    const client = createClient(query, fetchImpl);
    const cancelContext = { ...confirmationContext, currentMessageBody: "CONFIRMO cancelar" };

    const first = await client.confirmPendingAction(cancelContext);
    const replay = await client.confirmPendingAction(cancelContext);

    expect(first).toMatchObject({ ok: false, status: "terminal_failure", code: "invalid_transition" });
    expect(replay).toMatchObject({ ok: false, status: "terminal_failure", code: "invalid_transition" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      pendingAction: null,
      confirmationExecution: null,
      confirmationGrant: null
    });
  });

  it("does not let a second confirmation message race an action already claimed", async () => {
    const cancellation = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud del paciente"
    };
    let state: Record<string, unknown> = pendingState("cancel_appointment", cancellation, actionId);
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    let releaseCall!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse({
        appointment: confirmedAppointment("cancelled", cancellation.appointmentId),
        idempotent: false
      });
    });
    const client = createClient(query, fetchImpl);
    const firstContext = { ...confirmationContext, currentMessageBody: "CONFIRMO cancelar" };
    const first = client.confirmPendingAction(firstContext);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const second = await client.confirmPendingAction({
      ...firstContext,
      currentMessageId: "00000000-0000-4000-8000-000000000012",
      jobId: "00000000-0000-4000-8000-000000000013"
    });
    expect(second).toMatchObject({
      ok: false,
      status: "state_changed",
      code: "confirmation_already_processing"
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    releaseCall();
    await expect(first).resolves.toMatchObject({ ok: true, status: "completed", action: "cancel" });
  });

  it("does not acknowledge a booking unless the evidence is verified, internal and from SOFIA WhatsApp", async () => {
    let state: Record<string, unknown> = pendingState("create_appointment_hold", slot, actionId);
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const holdId = "00000000-0000-4000-8000-000000000007";
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/create_appointment_hold")
        ? jsonResponse({ hold: { id: holdId, expiresAt: "2026-07-13T13:59:00.000Z" } })
        : jsonResponse({
            appointment: {
              ...confirmedAppointment("verified"),
              verificationMode: "simulated",
              metadata: { simulated: true }
            }
          })
    );
    const client = createClient(query, fetchImpl);

    const result = await client.confirmPendingAction(confirmationContext);

    expect(result).toMatchObject({
      ok: false,
      status: "retryable_failure",
      code: "invalid_mutation_response",
      action: "book"
    });
    expect(state).toMatchObject({
      pendingAction: null,
      confirmationExecution: null,
      confirmationGrant: { actionId, holdId },
      confirmationReceipts: {}
    });
  });

  it("rejects booking evidence with a different target or invalid local details", async () => {
    const invalidEvidence = [
      { siteId: "00000000-0000-4000-8000-000000000099" },
      { scheduledAt: "2026-07-13T14:20:00.000Z" },
      { id: "not-a-uuid" },
      { localDate: "13-07-2026" },
      { localTime: "9 AM" },
      { timeZone: " " }
    ];
    for (const evidencePatch of invalidEvidence) {
      let state: Record<string, unknown> = pendingState("create_appointment_hold", slot, actionId);
      const query = durableConfirmationQuery(
        () => state,
        (next) => {
          state = next;
        }
      );
      const holdId = "00000000-0000-4000-8000-000000000007";
      const fetchImpl = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/create_appointment_hold")
          ? jsonResponse({ hold: { id: holdId, expiresAt: "2026-07-13T13:59:00.000Z" } })
          : jsonResponse({ appointment: { ...confirmedAppointment("verified"), ...evidencePatch } })
      );
      const client = createClient(query, fetchImpl);

      const result = await client.confirmPendingAction(confirmationContext);

      expect(result).toMatchObject({
        ok: false,
        status: "retryable_failure",
        code: "invalid_mutation_response",
        action: "book"
      });
      expect(state).toMatchObject({ confirmationGrant: { actionId, holdId, arguments: slot } });
    }
  });

  it("validates a legacy grant without slot arguments using strict appointment evidence", async () => {
    const holdId = "00000000-0000-4000-8000-000000000007";
    let state: Record<string, unknown> = {
      confirmationGrant: {
        actionId,
        tool: "book_appointment",
        holdId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString()
      },
      confirmationReceipts: {}
    };
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ appointment: confirmedAppointment("verified"), idempotent: true });
    });
    const client = createClient(query, fetchImpl);

    const result = await client.confirmPendingAction(confirmationContext);

    expect(result).toMatchObject({ ok: true, status: "completed", action: "book", actionId });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sentBody).toMatchObject({
      holdId,
      idempotencyKey: `${actionId}:book_appointment`
    });
    expect(state).toMatchObject({
      confirmationGrant: null,
      confirmationReceipts: {
        [confirmationContext.currentMessageId]: { actionId, action: "book", outcome: "completed" }
      }
    });
  });

  it("accepts a reschedule only when the old cita is rescheduled and its replacement has internal evidence", async () => {
    const rescheduleArguments = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      ...slot,
      reason: "Solicitud del paciente"
    };
    const evidenceCases = [
      { previousId: rescheduleArguments.appointmentId, previousStatus: "verified", replacementId: undefined },
      {
        previousId: "00000000-0000-4000-8000-000000000099",
        previousStatus: "rescheduled",
        replacementId: undefined
      },
      {
        previousId: rescheduleArguments.appointmentId,
        previousStatus: "rescheduled",
        replacementId: rescheduleArguments.appointmentId
      },
      {
        previousId: rescheduleArguments.appointmentId,
        previousStatus: "rescheduled",
        replacementId: "00000000-0000-4000-8000-000000000030"
      }
    ] as const;
    for (const evidence of evidenceCases) {
      let state: Record<string, unknown> = pendingState("reschedule_appointment", rescheduleArguments, actionId);
      const query = durableConfirmationQuery(
        () => state,
        (next) => {
          state = next;
        }
      );
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          previousAppointment: {
            id: evidence.previousId,
            status: evidence.previousStatus
          },
          appointment: confirmedAppointment("verified", evidence.replacementId),
          idempotent: false
        })
      );
      const client = createClient(query, fetchImpl);
      const result = await client.confirmPendingAction({
        ...confirmationContext,
        currentMessageBody: "CONFIRMO reagendar"
      });

      if (evidence.replacementId === "00000000-0000-4000-8000-000000000030") {
        expect(result).toMatchObject({ ok: true, status: "completed", action: "reschedule" });
      } else {
        expect(result).toMatchObject({
          ok: false,
          status: "retryable_failure",
          code: "invalid_mutation_response",
          action: "reschedule"
        });
        expect(state).toMatchObject({ confirmationExecution: { actionId, tool: "reschedule_appointment" } });
      }
    }
  });

  it("expires an orphan execution into a terminal receipt without authorizing another CONFIRMO", async () => {
    const originalMessageId = confirmationContext.currentMessageId;
    let state: Record<string, unknown> = {
      confirmationExecution: {
        actionId,
        tool: "cancel_appointment",
        arguments: {
          appointmentId: "00000000-0000-4000-8000-000000000006",
          reason: "Solicitud del paciente"
        },
        confirmationMessageId: originalMessageId,
        claimedAt: new Date(Date.now() - 6 * 60 * 1_000).toISOString()
      },
      confirmationReceipts: {}
    };
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const originalReplay = await client.confirmPendingAction({
      ...confirmationContext,
      currentMessageBody: "CONFIRMO cancelar"
    });
    const unrelatedConfirmation = await client.confirmPendingAction({
      ...confirmationContext,
      currentMessageId: "00000000-0000-4000-8000-000000000012",
      jobId: "00000000-0000-4000-8000-000000000013",
      currentMessageBody: "CONFIRMO cancelar"
    });

    expect(originalReplay).toMatchObject({
      ok: false,
      status: "terminal_failure",
      code: "confirmation_execution_expired",
      actionId
    });
    expect(unrelatedConfirmation).toMatchObject({ ok: false, status: "no_action" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      confirmationExecution: null,
      confirmationReceipts: {
        [originalMessageId]: { outcome: "terminal_failure", code: "confirmation_execution_expired" }
      }
    });
  });

  it("finalizes a compatible pending action from a later confirmation job without calling the domain", async () => {
    const cancellation = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud del paciente"
    };
    let state: Record<string, unknown> = pendingState("cancel_appointment", cancellation, actionId);
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const sameJob = await client.finalizePendingConfirmation(
      {
        ...confirmationContext,
        currentMessageBody: "CONFIRMO cancelar",
        jobId: actionId
      },
      "confirmation_retry_exhausted",
      "No fue posible completar la cancelación."
    );
    expect(sameJob).toMatchObject({ ok: false, status: "no_action", code: "confirmation_same_message" });
    expect(state).toMatchObject({ pendingAction: { jobId: actionId, tool: "cancel_appointment" } });

    const mismatch = await client.finalizePendingConfirmation(
      { ...confirmationContext, currentMessageBody: "CONFIRMO reagendar" },
      "confirmation_retry_exhausted",
      "No fue posible completar la cancelación."
    );
    expect(mismatch).toMatchObject({ ok: false, status: "action_mismatch", actionId });
    expect(state).toMatchObject({ pendingAction: { jobId: actionId, tool: "cancel_appointment" } });

    const finalized = await client.finalizePendingConfirmation(
      { ...confirmationContext, currentMessageBody: "CONFIRMO cancelar" },
      "confirmation_retry_exhausted",
      "No fue posible completar la cancelación."
    );
    const replay = await client.finalizePendingConfirmation(
      { ...confirmationContext, currentMessageBody: "CONFIRMO cancelar" },
      "different_code",
      "No debe reemplazar el receipt."
    );

    expect(finalized).toMatchObject({
      ok: false,
      status: "terminal_failure",
      code: "confirmation_retry_exhausted",
      action: "cancel",
      actionId
    });
    expect(replay).toMatchObject({
      ok: false,
      status: "terminal_failure",
      code: "confirmation_retry_exhausted",
      actionId
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      pendingAction: null,
      confirmationExecution: null,
      confirmationGrant: null,
      confirmationReceipts: {
        [confirmationContext.currentMessageId]: {
          actionId,
          action: "cancel",
          outcome: "terminal_failure"
        }
      }
    });
  });

  it("finalizes only the execution bound to the same confirmation message without calling the domain", async () => {
    const originalMessageId = confirmationContext.currentMessageId;
    let state: Record<string, unknown> = {
      confirmationExecution: {
        actionId,
        tool: "cancel_appointment",
        arguments: {
          appointmentId: "00000000-0000-4000-8000-000000000006",
          reason: "Solicitud del paciente"
        },
        confirmationMessageId: originalMessageId,
        claimedAt: new Date().toISOString()
      },
      confirmationReceipts: {}
    };
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const otherMessage = await client.finalizePendingConfirmation(
      {
        ...confirmationContext,
        currentMessageId: "00000000-0000-4000-8000-000000000012"
      },
      "confirmation_retries_exhausted",
      "No fue posible confirmar la operación."
    );
    expect(otherMessage).toMatchObject({
      ok: false,
      status: "state_changed",
      code: "confirmation_already_processing"
    });
    expect(state).toMatchObject({ confirmationExecution: { actionId, confirmationMessageId: originalMessageId } });

    const finalized = await client.finalizePendingConfirmation(
      confirmationContext,
      "confirmation_retries_exhausted",
      "No fue posible confirmar la operación."
    );
    const replay = await client.finalizePendingConfirmation(
      confirmationContext,
      "different_code",
      "Este texto no debe reemplazar el recibo."
    );

    expect(finalized).toMatchObject({
      ok: false,
      status: "terminal_failure",
      code: "confirmation_retries_exhausted",
      action: "cancel",
      actionId
    });
    expect(replay).toMatchObject({
      ok: false,
      status: "terminal_failure",
      code: "confirmation_retries_exhausted",
      actionId
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      confirmationExecution: null,
      confirmationReceipts: {
        [originalMessageId]: { code: "confirmation_retries_exhausted", outcome: "terminal_failure" }
      }
    });
  });

  it("can finalize a legacy grant without a confirmationMessageId", async () => {
    const holdId = "00000000-0000-4000-8000-000000000007";
    let state: Record<string, unknown> = {
      confirmationGrant: {
        actionId,
        tool: "book_appointment",
        holdId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString()
      },
      confirmationReceipts: {}
    };
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const finalized = await client.finalizePendingConfirmation(
      confirmationContext,
      "confirmation_retries_exhausted",
      "No fue posible completar la reserva."
    );

    expect(finalized).toMatchObject({
      ok: false,
      status: "terminal_failure",
      code: "confirmation_retries_exhausted",
      action: "book",
      actionId
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      confirmationGrant: null,
      confirmationReceipts: {
        [confirmationContext.currentMessageId]: { actionId, action: "book", outcome: "terminal_failure" }
      }
    });
  });

  it("requires the confirmation intent to match the durable action", async () => {
    const cancellation = {
      appointmentId: "00000000-0000-4000-8000-000000000006",
      reason: "Solicitud del paciente"
    };
    let state: Record<string, unknown> = pendingState("cancel_appointment", cancellation, actionId);
    const query = durableConfirmationQuery(
      () => state,
      (next) => {
        state = next;
      }
    );
    const fetchImpl = vi.fn();
    const client = createClient(query, fetchImpl);

    const result = await client.confirmPendingAction({
      ...confirmationContext,
      currentMessageBody: "CONFIRMO reagendar"
    });

    expect(result).toMatchObject({ ok: false, status: "action_mismatch", action: "cancel", actionId });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state).toMatchObject({ pendingAction: { jobId: actionId, tool: "cancel_appointment" } });
  });
});

function createClient(query: ReturnType<typeof vi.fn>, fetchImpl: ReturnType<typeof vi.fn>): SofiaToolClient {
  return new SofiaToolClient({
    pulsoIrisUrl: "http://pulso.test",
    internalServiceToken: "internal-test-token",
    db: { query, transaction: vi.fn(), close: vi.fn() } as unknown as DatabaseClient,
    fetchImpl: fetchImpl as typeof fetch
  });
}

function queryResult(rows: unknown[]) {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function pendingState(
  tool: "create_appointment_hold" | "cancel_appointment" | "reschedule_appointment",
  argumentsValue: Record<string, unknown>,
  jobId: string
): Record<string, unknown> {
  return {
    pendingAction: {
      tool,
      arguments: argumentsValue,
      stagedAt: new Date().toISOString(),
      jobId
    },
    confirmationReceipts: {}
  };
}

function confirmedAppointment(status: string, id = "00000000-0000-4000-8000-000000000030"): Record<string, unknown> {
  return {
    id,
    status,
    verificationMode: "internal",
    origin: "sofia_wa",
    siteId: "00000000-0000-4000-8000-000000000020",
    professionalId: "00000000-0000-4000-8000-000000000021",
    payerId: "00000000-0000-4000-8000-000000000025",
    appointmentTypeId: "00000000-0000-4000-8000-000000000022",
    scheduledAt: "2026-07-13T14:00:00.000Z",
    localDate: "2026-07-13",
    localTime: "09:00",
    timeZone: "America/Bogota",
    siteName: "Sede Principal Sotomayor",
    professionalName: "Agenda piloto PULSO IRIS",
    payerName: "Particular",
    appointmentTypeName: "Consulta optometria"
  };
}

function durableConfirmationQuery(
  readState: () => Record<string, unknown>,
  writeState: (state: Record<string, unknown>) => void
) {
  return vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("select coalesce(metadata->'sofiaState'")) {
      const state = readState() as {
        pendingAction?: { stagedAt?: string };
        confirmationExecution?: { claimedAt?: string };
        confirmationGrant?: { expiresAt?: string };
      };
      const pendingAt = Date.parse(state.pendingAction?.stagedAt ?? "");
      const executionAt = Date.parse(state.confirmationExecution?.claimedAt ?? "");
      const grantAt = Date.parse(state.confirmationGrant?.expiresAt ?? "");
      return queryResult([
        {
          state,
          pendingExpired: Number.isFinite(pendingAt) && pendingAt + 15 * 60 * 1_000 <= Date.now(),
          grantExpired: Number.isFinite(grantAt) && grantAt <= Date.now(),
          executionExpired: Number.isFinite(executionAt) && executionAt + 5 * 60 * 1_000 <= Date.now()
        }
      ]);
    }

    if (!sql.includes("update pulso_iris.conversations")) return queryResult([]);
    if (sql.includes("- 'lastAvailability'") && !sql.includes("'confirmationReceipts'")) {
      const next = { ...readState() };
      delete next.lastAvailability;
      delete next.lastAvailabilityAt;
      delete next.lastAvailabilitySchemaVersion;
      delete next.lastAvailabilityJobId;
      delete next.lastAvailabilityQuery;
      writeState(next);
      return queryResult([{ id: context.conversationId }]);
    }

    if (sql.includes("sofia-confirmation:expire-execution")) {
      const state = readState() as {
        pendingAction?: Record<string, unknown> | null;
        confirmationExecution?: Record<string, unknown> | null;
        confirmationReceipts?: Record<string, unknown>;
      };
      const execution = state.confirmationExecution;
      if (
        execution?.actionId !== params[2] ||
        execution?.confirmationMessageId !== params[3] ||
        execution?.tool !== params[4] ||
        execution?.claimedAt !== params[5]
      ) {
        return queryResult([]);
      }
      const next = {
        ...state,
        confirmationExecution: null,
        confirmationGrant: null,
        confirmationReceipts: {
          ...(state.confirmationReceipts ?? {}),
          [String(params[3])]: JSON.parse(String(params[7])) as Record<string, unknown>
        }
      };
      writeState(next);
      return queryResult([{ state: next }]);
    }

    if (sql.includes("'confirmationReceipts'")) {
      const state = readState() as {
        pendingAction?: Record<string, unknown> | null;
        confirmationExecution?: Record<string, unknown> | null;
        confirmationGrant?: Record<string, unknown> | null;
        confirmationReceipts?: Record<string, unknown>;
      };
      const receipt = JSON.parse(String(params[5])) as Record<string, unknown>;
      const messageId = String(params[3]);
      const execution = state.confirmationExecution;
      const grant = state.confirmationGrant;
      const pending = state.pendingAction;
      const matchesPending =
        sql.includes("pendingAction,jobId") && pending?.jobId === params[2] && pending?.tool === params[4];
      const matchesExecution =
        sql.includes("confirmationExecution,actionId") &&
        execution?.actionId === params[2] &&
        execution?.confirmationMessageId === params[3] &&
        execution?.tool === params[4];
      const matchesGrant =
        sql.includes("confirmationGrant,actionId") &&
        grant?.actionId === params[2] &&
        grant?.holdId === params[4] &&
        (params[6] === null || grant?.confirmationMessageId === params[6]);
      if (!matchesPending && !matchesExecution && !matchesGrant) return queryResult([]);
      writeState({
        ...state,
        pendingAction: null,
        confirmationExecution: null,
        confirmationGrant: null,
        confirmationReceipts: { ...(state.confirmationReceipts ?? {}), [messageId]: receipt }
      });
      return queryResult([{ id: context.conversationId }]);
    }

    if (sql.includes("'confirmationGrant', $6::jsonb")) {
      const state = readState() as { confirmationExecution?: Record<string, unknown> | null };
      const execution = state.confirmationExecution;
      if (
        execution?.actionId !== params[2] ||
        execution?.confirmationMessageId !== params[3] ||
        execution?.tool !== params[4]
      ) {
        return queryResult([]);
      }
      writeState({
        ...state,
        pendingAction: null,
        confirmationExecution: null,
        confirmationGrant: JSON.parse(String(params[5])) as Record<string, unknown>
      });
      return queryResult([{ id: context.conversationId }]);
    }

    if (sql.includes("'confirmationExecution', $5::jsonb")) {
      const state = readState() as {
        pendingAction?: Record<string, unknown> | null;
        confirmationExecution?: Record<string, unknown> | null;
        confirmationGrant?: Record<string, unknown> | null;
      };
      const pending = state.pendingAction;
      if (
        pending?.jobId !== params[2] ||
        pending?.tool !== params[3] ||
        state.confirmationExecution ||
        state.confirmationGrant
      ) {
        return queryResult([]);
      }
      writeState({
        ...state,
        pendingAction: null,
        confirmationGrant: null,
        confirmationExecution: JSON.parse(String(params[4])) as Record<string, unknown>
      });
      return queryResult([{ id: context.conversationId }]);
    }

    return queryResult([]);
  });
}

function statefulConfirmationQuery(
  readState: () => Record<string, unknown>,
  writeState: (state: Record<string, unknown>) => void
) {
  return vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("select coalesce(metadata->'sofiaState'")) {
      const state = readState() as {
        pendingAction?: { stagedAt?: string };
        confirmationGrant?: { expiresAt?: string };
      };
      const pendingAt = Date.parse(state.pendingAction?.stagedAt ?? "");
      const grantAt = Date.parse(state.confirmationGrant?.expiresAt ?? "");
      return queryResult([
        {
          state,
          pendingExpired: Number.isFinite(pendingAt) && pendingAt + 15 * 60 * 1_000 <= Date.now(),
          grantExpired: Number.isFinite(grantAt) && grantAt <= Date.now()
        }
      ]);
    }
    if (sql.includes("update pulso_iris.conversations")) {
      if (sql.includes("- 'lastAvailability'")) {
        const state = { ...readState() };
        delete state.lastAvailability;
        delete state.lastAvailabilityAt;
        delete state.lastAvailabilitySchemaVersion;
        delete state.lastAvailabilityJobId;
        writeState(state);
        return queryResult([{ id: context.conversationId }]);
      }
      const patchIndex = sql.includes("$8::jsonb")
        ? 7
        : sql.includes("$5::jsonb")
          ? 4
          : sql.includes("$4::jsonb")
            ? 3
            : sql.includes("$3::jsonb")
              ? 2
              : undefined;
      const patch =
        patchIndex === undefined
          ? { pendingAction: null, confirmationGrant: null }
          : (JSON.parse(String(params?.[patchIndex])) as Record<string, unknown>);
      const state = { ...readState(), ...patch };
      writeState(state);
      return sql.includes("returning coalesce")
        ? queryResult([{ state }])
        : queryResult([{ id: context.conversationId }]);
    }
    return queryResult([]);
  });
}
