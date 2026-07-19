import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createIntegrationOwnerState } from "./sofia-integration-owner-state.test.support.js";
import { SofiaToolClient } from "./sofia-tools.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_PULSO_FIXTURE_DATABASE_URL = process.env.TEST_PULSO_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_PULSO_FIXTURE_DATABASE_URL ? describe : describe.skip;

describeIntegration("SOFIA PostgreSQL confirmation state", () => {
  let db: DatabaseClient;
  let fixtureDb: DatabaseClient;
  let tenantId = "";
  let patientId = "";
  let conversationId = "";

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL!);
    fixtureDb = createDatabase(TEST_PULSO_FIXTURE_DATABASE_URL!);
    tenantId = (
      await fixtureDb.query<{ id: string }>(
        `insert into platform.tenants (slug, display_name)
         values ($1, 'SOFIA confirmation integration') returning id`,
        [`sofia-confirmation-${randomUUID()}`]
      )
    ).rows[0]!.id;
    patientId = (
      await fixtureDb.query<{ id: string }>(
        `insert into pulso_iris.administrative_patients (tenant_id, preferred_channel)
         values ($1, 'whatsapp') returning id`,
        [tenantId]
      )
    ).rows[0]!.id;
    conversationId = (
      await fixtureDb.query<{ id: string }>(
        `insert into pulso_iris.conversations (tenant_id, patient_id, channel)
         values ($1, $2, 'whatsapp') returning id`,
        [tenantId, patientId]
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await fixtureDb.query("delete from platform.tenants where id = $1", [tenantId]);
    await db.close();
    await fixtureDb.close();
  });

  it("clears an expired action with CAS without rebuilding it from CONFIRMO arguments", async () => {
    const fetchImpl = vi.fn();
    const client = createClient(db, fixtureDb, fetchImpl);
    const firstJobId = randomUUID();
    const first = await client.execute("cancel_appointment", cancelArguments("Solicitud inicial"), {
      ...context(tenantId, patientId, conversationId, firstJobId),
      currentMessageBody: "Quiero cancelar"
    });
    expect(first).toMatchObject({ ok: false, code: "explicit_confirmation_required" });

    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(
         metadata,
         '{sofiaState,pendingAction,stagedAt}',
         to_jsonb($3::text)
       )
       where tenant_id = $1 and id = $2`,
      [tenantId, conversationId, new Date(Date.now() - 16 * 60 * 1_000).toISOString()]
    );

    const nextJobId = randomUUID();
    const result = await client.execute("cancel_appointment", cancelArguments("Solicitud vigente"), {
      ...context(tenantId, patientId, conversationId, nextJobId),
      currentMessageBody: "CONFIRMO cancelar"
    });
    expect(result).toMatchObject({ ok: false, code: "confirmation_action_missing" });

    const state = await readState(fixtureDb, tenantId, conversationId);
    expect(state.pendingAction).toBeNull();
    expect(state.confirmationGrant).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("claims one durable action and replays its receipt by confirmation message", async () => {
    const actionId = randomUUID();
    const appointmentId = randomUUID();
    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(metadata, '{sofiaState}', $3::jsonb)
       where tenant_id = $1 and id = $2`,
      [
        tenantId,
        conversationId,
        JSON.stringify({
          pendingAction: {
            tool: "cancel_appointment",
            arguments: { appointmentId, reason: "Solicitud controlada" },
            stagedAt: new Date().toISOString(),
            jobId: actionId
          },
          confirmationReceipts: {}
        })
      ]
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              appointment: {
                id: appointmentId,
                status: "cancelled",
                verificationMode: "internal",
                origin: "sofia_wa",
                scheduledAt: "2026-07-13T14:00:00.000Z",
                localDate: "2026-07-13",
                localTime: "09:00",
                timeZone: "America/Bogota"
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const client = createClient(db, fixtureDb, fetchImpl);
    const confirmationContext = {
      ...context(tenantId, patientId, conversationId, randomUUID()),
      currentMessageBody: "CONFIRMO cancelar"
    };

    const first = await client.confirmPendingAction(confirmationContext);
    const replay = await client.confirmPendingAction(confirmationContext);

    expect(first).toMatchObject({ ok: true, status: "completed", action: "cancel", replayed: false });
    expect(replay).toMatchObject({ ok: true, status: "completed", action: "cancel", replayed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const state = await readState(fixtureDb, tenantId, conversationId);
    expect(state).toMatchObject({
      pendingAction: null,
      confirmationExecution: null,
      confirmationGrant: null,
      confirmationReceipts: {
        [confirmationContext.currentMessageId]: { actionId, action: "cancel", outcome: "completed" }
      }
    });
  });

  it("finalizes a compatible pending action by CAS without a domain call", async () => {
    const actionId = randomUUID();
    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(metadata, '{sofiaState}', $3::jsonb)
       where tenant_id = $1 and id = $2`,
      [
        tenantId,
        conversationId,
        JSON.stringify({
          pendingAction: {
            tool: "cancel_appointment",
            arguments: { appointmentId: randomUUID(), reason: "Solicitud controlada" },
            stagedAt: new Date().toISOString(),
            jobId: actionId
          },
          confirmationReceipts: {}
        })
      ]
    );
    const fetchImpl = vi.fn();
    const client = createClient(db, fixtureDb, fetchImpl);
    const confirmationContext = {
      ...context(tenantId, patientId, conversationId, randomUUID()),
      currentMessageBody: "CONFIRMO cancelar"
    };

    const finalized = await client.finalizePendingConfirmation(
      confirmationContext,
      "confirmation_retry_exhausted",
      "No fue posible completar la cancelación."
    );

    expect(finalized).toMatchObject({
      ok: false,
      status: "terminal_failure",
      action: "cancel",
      actionId,
      code: "confirmation_retry_exhausted"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = await readState(fixtureDb, tenantId, conversationId);
    expect(state).toMatchObject({
      pendingAction: null,
      confirmationExecution: null,
      confirmationGrant: null,
      confirmationReceipts: {
        [confirmationContext.currentMessageId]: { actionId, outcome: "terminal_failure" }
      }
    });
  });

  it("expires an orphan execution with CAS and leaves a durable terminal receipt", async () => {
    const actionId = randomUUID();
    const confirmationMessageId = randomUUID();
    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(metadata, '{sofiaState}', $3::jsonb)
       where tenant_id = $1 and id = $2`,
      [
        tenantId,
        conversationId,
        JSON.stringify({
          confirmationExecution: {
            actionId,
            tool: "cancel_appointment",
            arguments: { appointmentId: randomUUID(), reason: "Solicitud controlada" },
            confirmationMessageId,
            claimedAt: new Date(Date.now() - 6 * 60 * 1_000).toISOString()
          },
          confirmationReceipts: {}
        })
      ]
    );
    const fetchImpl = vi.fn();
    const client = createClient(db, fixtureDb, fetchImpl);
    const originalContext = {
      ...context(tenantId, patientId, conversationId, randomUUID()),
      currentMessageId: confirmationMessageId,
      currentMessageBody: "CONFIRMO cancelar"
    };

    const expired = await client.confirmPendingAction(originalContext);
    const unrelated = await client.confirmPendingAction({
      ...originalContext,
      currentMessageId: randomUUID(),
      jobId: randomUUID()
    });

    expect(expired).toMatchObject({
      ok: false,
      status: "terminal_failure",
      code: "confirmation_execution_expired",
      actionId
    });
    expect(unrelated).toMatchObject({ ok: false, status: "no_action" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = await readState(fixtureDb, tenantId, conversationId);
    expect(state).toMatchObject({
      confirmationExecution: null,
      confirmationReceipts: {
        [confirmationMessageId]: { actionId, outcome: "terminal_failure" }
      }
    });
  });

  it("removes an expired grant before preparing another action", async () => {
    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(
         metadata,
         '{sofiaState}',
         $3::jsonb
       )
       where tenant_id = $1 and id = $2`,
      [
        tenantId,
        conversationId,
        JSON.stringify({
          pendingAction: null,
          confirmationGrant: {
            actionId: randomUUID(),
            tool: "book_appointment",
            holdId: randomUUID(),
            expiresAt: new Date(Date.now() - 60_000).toISOString()
          }
        })
      ]
    );
    const fetchImpl = vi.fn();
    const client = createClient(db, fixtureDb, fetchImpl);
    const jobId = randomUUID();

    const result = await client.execute("cancel_appointment", cancelArguments("Solicitud posterior"), {
      ...context(tenantId, patientId, conversationId, jobId),
      currentMessageBody: "Quiero cancelar"
    });

    expect(result).toMatchObject({ ok: false, code: "explicit_confirmation_required" });
    const state = await readState(fixtureDb, tenantId, conversationId);
    expect(state.pendingAction).toMatchObject({ tool: "cancel_appointment", jobId });
    expect(state.confirmationGrant).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the original action and TTL for an operationally identical request", async () => {
    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(metadata, '{sofiaState}', '{}'::jsonb)
       where tenant_id = $1 and id = $2`,
      [tenantId, conversationId]
    );
    const fetchImpl = vi.fn();
    const client = createClient(db, fixtureDb, fetchImpl);
    const appointmentId = randomUUID();
    const originalJobId = randomUUID();

    const first = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId, reason: "Solicitud inicial" }),
      {
        ...context(tenantId, patientId, conversationId, originalJobId),
        currentMessageBody: "Quiero cancelar mi cita"
      }
    );
    expect(first).toMatchObject({ code: "explicit_confirmation_required" });
    const original = await readState(fixtureDb, tenantId, conversationId);

    const repeated = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId, reason: "La misma solicitud reformulada" }),
      {
        ...context(tenantId, patientId, conversationId, randomUUID()),
        currentMessageBody: "Quiero cancelar mi cita"
      }
    );
    expect(repeated).toMatchObject({
      code: "explicit_confirmation_required",
      pendingActionReused: true
    });
    const persisted = await readState(fixtureDb, tenantId, conversationId);
    expect(persisted.pendingAction).toEqual(original.pendingAction);
    expect(persisted.pendingAction).toMatchObject({ jobId: originalJobId });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not clear a newer action when an older mutation completes late", async () => {
    const oldActionId = randomUUID();
    const newActionId = randomUUID();
    const appointmentId = randomUUID();
    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(metadata, '{sofiaState}', $3::jsonb)
       where tenant_id = $1 and id = $2`,
      [
        tenantId,
        conversationId,
        JSON.stringify({
          pendingAction: {
            tool: "cancel_appointment",
            arguments: { appointmentId, reason: "Solicitud anterior" },
            stagedAt: new Date().toISOString(),
            jobId: oldActionId
          },
          confirmationGrant: null
        })
      ]
    );
    const newerAction = {
      tool: "reschedule_appointment",
      arguments: {},
      stagedAt: new Date().toISOString(),
      jobId: newActionId
    };
    const fetchImpl = vi.fn(async () => {
      await fixtureDb.query(
        `update pulso_iris.conversations
         set metadata = jsonb_set(metadata, '{sofiaState}', $3::jsonb)
         where tenant_id = $1 and id = $2`,
        [tenantId, conversationId, JSON.stringify({ pendingAction: newerAction, confirmationGrant: null })]
      );
      return new Response(JSON.stringify({ data: { appointment: { status: "cancelled" } } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createClient(db, fixtureDb, fetchImpl);

    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId, reason: "Deriva que debe ignorarse" }),
      {
        ...context(tenantId, patientId, conversationId, randomUUID()),
        currentMessageBody: "CONFIRMO cancelar"
      }
    );

    expect(result).toMatchObject({ ok: true });
    const state = await readState(fixtureDb, tenantId, conversationId);
    expect(state.pendingAction).toMatchObject({ tool: "reschedule_appointment", jobId: newActionId });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("versions fresh availability and invalidates it after a successful mutation", async () => {
    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(metadata, '{sofiaState}', '{}'::jsonb)
       where tenant_id = $1 and id = $2`,
      [tenantId, conversationId]
    );
    const slot = {
      siteId: randomUUID(),
      professionalId: randomUUID(),
      payerId: randomUUID(),
      appointmentTypeId: randomUUID(),
      startsAt: "2026-07-13T14:00:00.000Z",
      scheduledAt: "2026-07-13T14:00:00.000Z",
      localDate: "2026-07-13",
      localTime: "09:00",
      timeZone: "America/Bogota"
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const data = String(url).endsWith("/search_availability")
        ? { slots: [slot] }
        : { appointment: { status: "cancelled" } };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createClient(db, fixtureDb, fetchImpl);
    const searchJobId = randomUUID();

    const searchArguments = {
      siteId: slot.siteId,
      professionalId: slot.professionalId,
      payerId: slot.payerId,
      appointmentTypeId: slot.appointmentTypeId,
      localDate: slot.localDate,
      localTime: slot.localTime,
      days: 1
    };
    const search = await client.execute("search_availability", JSON.stringify(searchArguments), {
      ...context(tenantId, patientId, conversationId, searchJobId),
      currentMessageBody: "Consulta disponibilidad"
    });
    expect(search).toMatchObject({ ok: true });
    const freshState = await readState(fixtureDb, tenantId, conversationId);
    expect(freshState).toMatchObject({
      lastAvailability: { slots: [expect.objectContaining({ localTime: "09:00" })] },
      lastAvailabilitySchemaVersion: 3,
      lastAvailabilityJobId: searchJobId,
      lastAvailabilityQuery: searchArguments,
      agendaSelection: {
        siteId: slot.siteId,
        professionalId: slot.professionalId,
        payerId: slot.payerId,
        appointmentTypeId: slot.appointmentTypeId
      }
    });
    expect(freshState.lastAvailabilityAt).toEqual(expect.any(String));

    const actionId = randomUUID();
    const appointmentId = randomUUID();
    await fixtureDb.query(
      `update pulso_iris.conversations
       set metadata = jsonb_set(
         metadata,
         '{sofiaState,pendingAction}',
         $3::jsonb
       )
       where tenant_id = $1 and id = $2`,
      [
        tenantId,
        conversationId,
        JSON.stringify({
          tool: "cancel_appointment",
          arguments: { appointmentId, reason: "Solicitud controlada" },
          stagedAt: new Date().toISOString(),
          jobId: actionId
        })
      ]
    );
    const cancelled = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId, reason: "Deriva ignorada" }),
      {
        ...context(tenantId, patientId, conversationId, randomUUID()),
        currentMessageBody: "CONFIRMO cancelar"
      }
    );
    expect(cancelled).toMatchObject({ ok: true });
    const clearedState = await readState(fixtureDb, tenantId, conversationId);
    expect(clearedState).not.toHaveProperty("lastAvailability");
    expect(clearedState).not.toHaveProperty("lastAvailabilityAt");
    expect(clearedState).not.toHaveProperty("lastAvailabilitySchemaVersion");
    expect(clearedState).not.toHaveProperty("lastAvailabilityJobId");
    expect(clearedState).not.toHaveProperty("lastAvailabilityQuery");
    expect(clearedState.agendaSelection).toMatchObject({ payerId: slot.payerId });
  });
});

function createClient(
  db: DatabaseClient,
  fixtureDb: DatabaseClient,
  fetchImpl: ReturnType<typeof vi.fn>
): SofiaToolClient {
  return new SofiaToolClient({
    pulsoIrisUrl: "http://pulso.test",
    internalServiceToken: "controlled-internal-token",
    db,
    fetchImpl: fetchImpl as typeof fetch,
    ownerState: createIntegrationOwnerState(fixtureDb)
  });
}

function context(tenantId: string, patientId: string, conversationId: string, jobId: string) {
  return {
    tenantId,
    patientId,
    conversationId,
    currentMessageId: randomUUID(),
    currentMessageBody: "",
    jobId,
    sequence: 1
  };
}

function cancelArguments(reason: string): string {
  return JSON.stringify({ appointmentId: randomUUID(), reason });
}

async function readState(db: DatabaseClient, tenantId: string, conversationId: string) {
  const result = await db.query<{ state: Record<string, unknown> }>(
    `select metadata->'sofiaState' as state
     from pulso_iris.conversations where tenant_id = $1 and id = $2`,
    [tenantId, conversationId]
  );
  return result.rows[0]!.state as {
    pendingAction?: Record<string, unknown> | null;
    confirmationExecution?: Record<string, unknown> | null;
    confirmationGrant?: Record<string, unknown> | null;
    confirmationReceipts?: Record<string, unknown>;
    lastAvailability?: Record<string, unknown>;
    lastAvailabilityAt?: string;
    lastAvailabilitySchemaVersion?: number;
    lastAvailabilityJobId?: string;
    lastAvailabilityQuery?: Record<string, unknown>;
    agendaSelection?: Record<string, unknown>;
  };
}
