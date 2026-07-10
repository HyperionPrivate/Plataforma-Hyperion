import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SofiaToolClient } from "./sofia-tools.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("SOFIA PostgreSQL confirmation state", () => {
  let db: DatabaseClient;
  let tenantId = "";
  let patientId = "";
  let conversationId = "";

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL!);
    tenantId = (
      await db.query<{ id: string }>(
        `insert into platform.tenants (slug, display_name)
         values ($1, 'SOFIA confirmation integration') returning id`,
        [`sofia-confirmation-${randomUUID()}`]
      )
    ).rows[0]!.id;
    patientId = (
      await db.query<{ id: string }>(
        `insert into pulso_iris.administrative_patients (tenant_id, preferred_channel)
         values ($1, 'whatsapp') returning id`,
        [tenantId]
      )
    ).rows[0]!.id;
    conversationId = (
      await db.query<{ id: string }>(
        `insert into pulso_iris.conversations (tenant_id, patient_id, channel)
         values ($1, $2, 'whatsapp') returning id`,
        [tenantId, patientId]
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await db.query("delete from platform.tenants where id = $1", [tenantId]);
    await db.close();
  });

  it("clears an expired action with CAS and safely restages the confirmed request", async () => {
    const fetchImpl = vi.fn();
    const client = createClient(db, fetchImpl);
    const firstJobId = randomUUID();
    const first = await client.execute("cancel_appointment", cancelArguments("Solicitud inicial"), {
      ...context(tenantId, patientId, conversationId, firstJobId),
      currentMessageBody: "Quiero cancelar"
    });
    expect(first).toMatchObject({ ok: false, code: "explicit_confirmation_required" });

    await db.query(
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
    const restaged = await client.execute("cancel_appointment", cancelArguments("Solicitud vigente"), {
      ...context(tenantId, patientId, conversationId, nextJobId),
      currentMessageBody: "CONFIRMO cancelar"
    });
    expect(restaged).toMatchObject({ ok: false, code: "confirmation_action_staged" });

    const state = await readState(db, tenantId, conversationId);
    expect(state.pendingAction).toMatchObject({
      tool: "cancel_appointment",
      jobId: nextJobId,
      arguments: { reason: "Solicitud vigente" }
    });
    expect(state.confirmationGrant).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("removes an expired grant before preparing another action", async () => {
    await db.query(
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
    const client = createClient(db, fetchImpl);
    const jobId = randomUUID();

    const result = await client.execute("cancel_appointment", cancelArguments("Solicitud posterior"), {
      ...context(tenantId, patientId, conversationId, jobId),
      currentMessageBody: "Quiero cancelar"
    });

    expect(result).toMatchObject({ ok: false, code: "explicit_confirmation_required" });
    const state = await readState(db, tenantId, conversationId);
    expect(state.pendingAction).toMatchObject({ tool: "cancel_appointment", jobId });
    expect(state.confirmationGrant).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not clear a newer action when an older mutation completes late", async () => {
    const oldActionId = randomUUID();
    const newActionId = randomUUID();
    const appointmentId = randomUUID();
    await db.query(
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
      await db.query(
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
    const client = createClient(db, fetchImpl);

    const result = await client.execute(
      "cancel_appointment",
      JSON.stringify({ appointmentId, reason: "Deriva que debe ignorarse" }),
      {
        ...context(tenantId, patientId, conversationId, randomUUID()),
        currentMessageBody: "CONFIRMO cancelar"
      }
    );

    expect(result).toMatchObject({ ok: true });
    const state = await readState(db, tenantId, conversationId);
    expect(state.pendingAction).toMatchObject({ tool: "reschedule_appointment", jobId: newActionId });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function createClient(db: DatabaseClient, fetchImpl: ReturnType<typeof vi.fn>): SofiaToolClient {
  return new SofiaToolClient({
    pulsoIrisUrl: "http://pulso.test",
    internalServiceToken: "controlled-internal-token",
    db,
    fetchImpl: fetchImpl as typeof fetch
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
    confirmationGrant?: Record<string, unknown> | null;
  };
}
