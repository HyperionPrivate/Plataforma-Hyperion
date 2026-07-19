import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applySofiaStateMutation, registerSofiaOwnerRoutes } from "./sofia-owner-routes.js";
import { registerChannelDeliveryRoutes } from "./channel-delivery-routes.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";
const SOFIA_TOKEN = "sofia-to-pulso-test-token";
const CHANNEL_TOKEN = "channel-to-pulso-test-token";

describe("PULSO sofia owner routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())).then(() => undefined));

  it("authorizes agent-service for outbound persist and rejects other callers", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: MESSAGE_ID, body: "hola" }], rowCount: 1 }));
    const app = Fastify();
    apps.push(app);
    registerSofiaOwnerRoutes(app, context(query), SOFIA_TOKEN);

    const missing = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/sofia-outbound`,
      payload: {
        conversationId: CONVERSATION_ID,
        body: "hola",
        externalMessageId: "sofia-job:1",
        metadata: {}
      }
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/sofia-outbound`,
      headers: { authorization: `Bearer ${SOFIA_TOKEN}`, "x-hyperion-caller": "whatsapp-channel-service" },
      payload: {
        conversationId: CONVERSATION_ID,
        body: "hola",
        externalMessageId: "sofia-job:1",
        metadata: {}
      }
    });
    const ok = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/sofia-outbound`,
      headers: { authorization: `Bearer ${SOFIA_TOKEN}`, "x-hyperion-caller": "agent-service" },
      payload: {
        conversationId: CONVERSATION_ID,
        body: "hola",
        externalMessageId: "sofia-job:1",
        metadata: {}
      }
    });

    expect(missing.statusCode).toBe(401);
    expect([401, 403]).toContain(forbidden.statusCode);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ id: MESSAGE_ID, body: "hola" });
  });

  it("resolves only the tenant-bound patient inbound through a strict authenticated request", async () => {
    const patientId = "50000000-0000-4000-8000-000000000001";
    const query = vi.fn(async () => ({
      rows: [{ id: MESSAGE_ID, sender: "patient", body: "CONFIRMO", conversationStatus: "active" }],
      rowCount: 1
    }));
    const app = Fastify();
    apps.push(app);
    registerSofiaOwnerRoutes(app, context(query), SOFIA_TOKEN);
    const payload = { conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, patientId };

    const missing = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/sofia/inbound-message`,
      payload
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/sofia/inbound-message`,
      headers: { authorization: `Bearer ${SOFIA_TOKEN}`, "x-hyperion-caller": "whatsapp-channel-service" },
      payload
    });
    const extraBody = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/sofia/inbound-message`,
      headers: sofiaHeaders(),
      payload: { ...payload, unexpected: true }
    });
    const extraQuery = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/sofia/inbound-message?unexpected=true`,
      headers: sofiaHeaders(),
      payload
    });
    const ok = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/sofia/inbound-message`,
      headers: sofiaHeaders(),
      payload
    });

    expect(missing.statusCode).toBe(401);
    expect([401, 403]).toContain(forbidden.statusCode);
    expect(extraBody.statusCode).toBe(400);
    expect(extraQuery.statusCode).toBe(400);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({
      found: true,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      patientId,
      conversationStatus: "active",
      message: { id: MESSAGE_ID, sender: "patient", body: "CONFIRMO" }
    });
    const [inboundSql, inboundParameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(inboundSql).toContain("m.sender = 'patient'");
    expect(inboundParameters).toEqual([TENANT_ID, CONVERSATION_ID, MESSAGE_ID, patientId]);
  });

  it("loads a bounded ordered context and fails closed for missing identity or database", async () => {
    const patientId = "50000000-0000-4000-8000-000000000001";
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            sofiaState: { step: "ready" },
            patientName: null,
            history: [
              { sender: "sofia", body: "Hola" },
              { sender: "patient", body: "Necesito una cita" }
            ]
          }
        ],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = Fastify();
    apps.push(app);
    registerSofiaOwnerRoutes(app, context(query), SOFIA_TOKEN);

    const ok = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/sofia/conversation-context`,
      headers: sofiaHeaders(),
      payload: { conversationId: CONVERSATION_ID, patientId }
    });
    const missingIdentity = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/sofia/conversation-context`,
      headers: sofiaHeaders(),
      payload: { conversationId: CONVERSATION_ID, patientId }
    });

    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      patientId,
      patientName: null,
      sofiaState: { step: "ready" },
      history: [
        { sender: "sofia", body: "Hola" },
        { sender: "patient", body: "Necesito una cita" }
      ]
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("c.patient_id = $3");
    expect(query.mock.calls[0]?.[1]).toEqual([TENANT_ID, CONVERSATION_ID, patientId]);
    expect(String(query.mock.calls[0]?.[0])).toContain("order by m.created_at desc, m.id desc");
    expect(String(query.mock.calls[0]?.[0])).toContain("limit 12");
    expect(missingIdentity.statusCode).toBe(404);

    const noDatabase = Fastify();
    apps.push(noDatabase);
    registerSofiaOwnerRoutes(
      noDatabase,
      { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as never,
      SOFIA_TOKEN
    );
    const unavailable = await noDatabase.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/sofia/conversation-context`,
      headers: sofiaHeaders(),
      payload: { conversationId: CONVERSATION_ID, patientId }
    });
    expect(unavailable.statusCode).toBe(503);
  });

  it("claims a pending action atomically against the exact patient confirmation", async () => {
    const patientId = "50000000-0000-4000-8000-000000000001";
    const actionId = "60000000-0000-4000-8000-000000000001";
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const db = { query } as never;
    const mutation = {
      op: "claim_pending_action" as const,
      pendingJobId: actionId,
      pendingTool: "reschedule_appointment" as const,
      patientId,
      confirmationMessageId: MESSAGE_ID,
      confirmationBody: "CONFIRMO reagendar",
      execution: {
        actionId,
        tool: "reschedule_appointment" as const,
        arguments: { appointmentId: "70000000-0000-4000-8000-000000000001" },
        confirmationMessageId: MESSAGE_ID,
        claimedAt: "2026-07-18T12:00:00.000Z"
      }
    };

    await expect(applySofiaStateMutation(db, TENANT_ID, CONVERSATION_ID, mutation)).resolves.toBe(true);
    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("update pulso_iris.conversations c");
    expect(sql).toContain("c.patient_id = $6");
    expect(sql).toContain("from pulso_iris.messages m");
    expect(sql).toContain("m.sender = 'patient'");
    expect(sql).toContain("m.body = $8");
    expect(parameters).toEqual([
      TENANT_ID,
      CONVERSATION_ID,
      actionId,
      "reschedule_appointment",
      JSON.stringify(mutation.execution),
      patientId,
      MESSAGE_ID,
      "CONFIRMO reagendar"
    ]);

    await expect(
      applySofiaStateMutation(db, TENANT_ID, CONVERSATION_ID, {
        ...mutation,
        execution: { ...mutation.execution, confirmationMessageId: CONVERSATION_ID }
      })
    ).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("PULSO channel delivery owner routes", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())).then(() => undefined));

  it("authorizes whatsapp-channel-service for delivery updates", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const app = Fastify();
    apps.push(app);
    registerChannelDeliveryRoutes(app, context(query), CHANNEL_TOKEN);

    const missing = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery`,
      payload: { outcome: "failed" }
    });
    const forbidden = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery`,
      headers: { authorization: `Bearer ${CHANNEL_TOKEN}`, "x-hyperion-caller": "agent-service" },
      payload: { outcome: "failed" }
    });
    const ok = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/messages/${MESSAGE_ID}/delivery`,
      headers: { authorization: `Bearer ${CHANNEL_TOKEN}`, "x-hyperion-caller": "whatsapp-channel-service" },
      payload: { outcome: "failed" }
    });

    expect(missing.statusCode).toBe(401);
    expect([401, 403]).toContain(forbidden.statusCode);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toEqual({ updated: true });
  });
});

function context(query: ReturnType<typeof vi.fn>) {
  return {
    db: { query },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  } as never;
}

function sofiaHeaders() {
  return { authorization: `Bearer ${SOFIA_TOKEN}`, "x-hyperion-caller": "agent-service" };
}
