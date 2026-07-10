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

  it("restages an expired matching action without executing it", async () => {
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

    expect(result).toMatchObject({ ok: false, code: "confirmation_action_staged" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.pendingAction).toMatchObject({
      tool: "cancel_appointment",
      jobId: context.jobId,
      arguments: { reason: "Solicitud vigente" }
    });
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
    expect(repeated).toMatchObject({ ok: false, code: "confirmation_action_staged" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(idempotencyKeys).toEqual([`${actionId}:cancel_appointment`]);
  });

  it("stages a bare CONFIRMO and never executes twice inside the same job", async () => {
    const slot = {
      siteId: "00000000-0000-4000-8000-000000000020",
      professionalId: "00000000-0000-4000-8000-000000000021",
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
    const idempotencyKeys: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      idempotencyKeys.push(String(body.idempotencyKey));
      return jsonResponse({ hold: { id: "00000000-0000-4000-8000-000000000007" } });
    });
    const client = createClient(query, fetchImpl);
    const firstConfirmation = { ...context, currentMessageBody: "CONFIRMO reservar" };

    const staged = await client.execute("create_appointment_hold", JSON.stringify(slot), firstConfirmation);
    const sameJobReplay = await client.execute("create_appointment_hold", JSON.stringify(slot), firstConfirmation);
    const nextMessage = await client.execute("create_appointment_hold", JSON.stringify(slot), {
      ...firstConfirmation,
      currentMessageId: "00000000-0000-4000-8000-000000000010",
      jobId: "00000000-0000-4000-8000-000000000011"
    });

    expect(staged).toMatchObject({ ok: false, code: "confirmation_action_staged" });
    expect(sameJobReplay).toMatchObject({ ok: false, code: "explicit_confirmation_required" });
    expect(nextMessage).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(idempotencyKeys).toEqual([`${context.jobId}:create_appointment_hold`]);
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
