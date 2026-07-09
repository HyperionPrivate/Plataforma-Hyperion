import { randomUUID } from "node:crypto";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmitAuditEventInput } from "./audit-client.js";
import { registerSofiaToolRoutes } from "./sofia-tools-routes.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;
const INTERNAL_TOKEN = "controlled-internal-test-token";

describeIntegration("SOFIA internal agenda tools", () => {
  let app: ServiceHandle["app"];
  let client: pg.Client;
  let tenantId = "";
  let otherTenantId = "";
  let bindingId = "";
  let siteId = "";
  let professionalId = "";
  let payerId = "";
  let appointmentTypeId = "";
  let scheduledAt = "";
  let patientId = "";
  let conversationId = "";
  let messageId = "";
  const events: EmitAuditEventInput[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const fixtures = await createFixtures(client);
    ({ tenantId, otherTenantId, bindingId, siteId, professionalId, payerId, appointmentTypeId, scheduledAt } =
      fixtures);
    const service = await createService({
      serviceName: "pulso-iris-service",
      databaseRequired: true,
      registerRoutes: async (serviceApp, context) => {
        await registerSofiaToolRoutes(serviceApp, context, (event) => events.push(event));
      }
    });
    app = service.app;
  });

  afterAll(async () => {
    await app?.close();
    if (client) {
      if (tenantId)
        await client.query("delete from platform.tenants where id = any($1::uuid[])", [[tenantId, otherTenantId]]);
      await client.end();
    }
    delete process.env.DATABASE_URL;
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("creates one patient, conversation and message for a redelivered inbound event", async () => {
    const first = await callTool("identify_patient_by_phone", {
      phoneHash: "a".repeat(64),
      phoneMasked: "********4567",
      threadBindingId: bindingId,
      externalMessageId: "controlled-inbound-1",
      body: "Hola"
    });
    expect(first.statusCode).toBe(200);
    ({ patientId, conversationId, messageId } = first.json().data);

    const replay = await callTool("identify_patient_by_phone", {
      phoneHash: "a".repeat(64),
      phoneMasked: "********4567",
      threadBindingId: bindingId,
      externalMessageId: "controlled-inbound-1",
      body: "Hola"
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toMatchObject({ patientId, conversationId, messageId, idempotent: true });
    const counts = await client.query(
      `select (select count(*)::int from pulso_iris.administrative_patients where tenant_id = $1) patients,
              (select count(*)::int from pulso_iris.conversations where tenant_id = $1) conversations,
              (select count(*)::int from pulso_iris.messages where tenant_id = $1) messages`,
      [tenantId]
    );
    expect(counts.rows[0]).toMatchObject({ patients: 1, conversations: 1, messages: 1 });

    await client.query(
      `update pulso_iris.conversations set status = 'handoff_required' where tenant_id = $1 and id = $2`,
      [tenantId, conversationId]
    );
    const afterHandoff = await callTool("identify_patient_by_phone", {
      phoneHash: "a".repeat(64),
      phoneMasked: "********4567",
      threadBindingId: bindingId,
      externalMessageId: "controlled-inbound-after-handoff",
      body: "Quiero continuar"
    });
    expect(afterHandoff.json().data.conversationId).toBe(conversationId);
    await client.query(`update pulso_iris.conversations set status = 'active' where tenant_id = $1 and id = $2`, [
      tenantId,
      conversationId
    ]);
  });

  it("rejects cross-tenant thread binding and write without explicit confirmation", async () => {
    const crossTenant = await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${otherTenantId}/pulso-iris/sofia/tools/identify_patient_by_phone`,
      headers: internalHeaders(),
      payload: {
        phoneHash: "b".repeat(64),
        phoneMasked: "********0002",
        threadBindingId: bindingId,
        externalMessageId: "controlled-cross-tenant",
        body: "Hola"
      }
    });
    expect(crossTenant.statusCode).toBe(422);

    const blocked = await callTool("create_appointment_hold", {
      patientId,
      conversationId,
      siteId,
      professionalId,
      payerId,
      appointmentTypeId,
      scheduledAt,
      confirmationMessageId: messageId,
      idempotencyKey: "sofia-hold-blocked"
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().data.code).toBe("explicit_confirmation_required");
  });

  it("books once, reschedules atomically and cancels only with explicit confirmations", async () => {
    const confirmation = await client.query<{ id: string }>(
      `insert into pulso_iris.messages (tenant_id, conversation_id, sender, body, provider, external_message_id)
       values ($1, $2, 'patient', 'CONFIRMO reservar', 'whatsapp_web_test', 'controlled-confirm-book') returning id`,
      [tenantId, conversationId]
    );
    const hold = await callTool("create_appointment_hold", {
      patientId,
      conversationId,
      siteId,
      professionalId,
      payerId,
      appointmentTypeId,
      scheduledAt,
      confirmationMessageId: confirmation.rows[0]!.id,
      idempotencyKey: "sofia-hold-confirmed"
    });
    expect(hold.statusCode).toBe(200);
    const holdId = hold.json().data.hold.id as string;

    const booked = await callTool("book_appointment", {
      patientId,
      conversationId,
      holdId,
      confirmationMessageId: confirmation.rows[0]!.id,
      idempotencyKey: "sofia-book-confirmed"
    });
    expect(booked.statusCode).toBe(200);
    expect(booked.json().data.appointment).toMatchObject({
      status: "verified",
      origin: "sofia_wa",
      verificationMode: "internal",
      professionalIsPilot: true
    });
    const originalAppointmentId = booked.json().data.appointment.id as string;

    const replay = await callTool("book_appointment", {
      patientId,
      conversationId,
      holdId,
      confirmationMessageId: confirmation.rows[0]!.id,
      idempotencyKey: "sofia-book-confirmed"
    });
    expect(replay.json().data).toMatchObject({ idempotent: true });

    const rescheduleConfirmation = await client.query<{ id: string }>(
      `insert into pulso_iris.messages (tenant_id, conversation_id, sender, body, provider, external_message_id)
       values ($1, $2, 'patient', 'CONFIRMO reagendar', 'whatsapp_web_test', 'controlled-confirm-reschedule') returning id`,
      [tenantId, conversationId]
    );
    const replacementAt = new Date(new Date(scheduledAt).getTime() + 20 * 60_000).toISOString();
    const rescheduled = await callTool("reschedule_appointment", {
      patientId,
      conversationId,
      appointmentId: originalAppointmentId,
      siteId,
      professionalId,
      payerId,
      appointmentTypeId,
      scheduledAt: replacementAt,
      reason: "Cambio controlado solicitado por el paciente",
      confirmationMessageId: rescheduleConfirmation.rows[0]!.id,
      idempotencyKey: "sofia-reschedule-confirmed"
    });
    expect(rescheduled.statusCode).toBe(200);
    expect(rescheduled.json().data.previousAppointment.status).toBe("rescheduled");
    expect(rescheduled.json().data.appointment).toMatchObject({ status: "verified", verificationMode: "internal" });
    const appointmentId = rescheduled.json().data.appointment.id as string;

    const rescheduleReplay = await callTool("reschedule_appointment", {
      patientId,
      conversationId,
      appointmentId: originalAppointmentId,
      siteId,
      professionalId,
      payerId,
      appointmentTypeId,
      scheduledAt: replacementAt,
      reason: "Cambio controlado solicitado por el paciente",
      confirmationMessageId: rescheduleConfirmation.rows[0]!.id,
      idempotencyKey: "sofia-reschedule-confirmed"
    });
    expect(rescheduleReplay.json().data).toMatchObject({ idempotent: true });

    const cancelConfirmation = await client.query<{ id: string }>(
      `insert into pulso_iris.messages (tenant_id, conversation_id, sender, body, provider, external_message_id)
       values ($1, $2, 'patient', 'CONFIRMO cancelar', 'whatsapp_web_test', 'controlled-confirm-cancel') returning id`,
      [tenantId, conversationId]
    );
    const cancelled = await callTool("cancel_appointment", {
      patientId,
      conversationId,
      appointmentId,
      reason: "Solicitud controlada del paciente",
      confirmationMessageId: cancelConfirmation.rows[0]!.id,
      idempotencyKey: "sofia-cancel-confirmed"
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.appointment.status).toBe("cancelled");

    const activeHoldsBefore = await client.query<{ count: number }>(
      `select count(*)::int as count from pulso_iris.appointment_holds where tenant_id = $1 and status = 'active'`,
      [tenantId]
    );
    const invalidReschedule = await callTool("reschedule_appointment", {
      patientId,
      conversationId,
      appointmentId,
      siteId,
      professionalId,
      payerId,
      appointmentTypeId,
      scheduledAt: new Date(new Date(replacementAt).getTime() + 20 * 60_000).toISOString(),
      reason: "Intento inválido controlado",
      confirmationMessageId: rescheduleConfirmation.rows[0]!.id,
      idempotencyKey: "sofia-reschedule-cancelled"
    });
    expect(invalidReschedule.statusCode).toBe(409);
    const activeHoldsAfter = await client.query<{ count: number }>(
      `select count(*)::int as count from pulso_iris.appointment_holds where tenant_id = $1 and status = 'active'`,
      [tenantId]
    );
    expect(activeHoldsAfter.rows[0]?.count).toBe(activeHoldsBefore.rows[0]?.count);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "channel.message.received",
        "appointment.hold.created",
        "appointment.registered",
        "appointment.verified",
        "appointment.rescheduled",
        "appointment.cancelled",
        "agent.tool.executed"
      ])
    );
  });

  async function callTool(toolName: string, payload: Record<string, unknown>) {
    return await app.inject({
      method: "POST",
      url: `/internal/v1/tenants/${tenantId}/pulso-iris/sofia/tools/${toolName}`,
      headers: internalHeaders(),
      payload
    });
  }
});

function internalHeaders() {
  return { authorization: `Bearer ${INTERNAL_TOKEN}` };
}

async function createFixtures(client: pg.Client) {
  const tenantId = (
    await client.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name) values ($1, 'SOFIA tools tenant') returning id`,
      [`sofia-tools-${randomUUID()}`]
    )
  ).rows[0]!.id;
  const otherTenantId = (
    await client.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name) values ($1, 'Other SOFIA tenant') returning id`,
      [`sofia-tools-other-${randomUUID()}`]
    )
  ).rows[0]!.id;
  await client.query(
    `update pulso_iris.agenda_settings
     set mode = 'internal', external_reference_required = false, booking_horizon_days = 60, status = 'active'
     where tenant_id = $1`,
    [tenantId]
  );
  const siteId = (
    await client.query<{ id: string }>(
      `insert into pulso_iris.sites (tenant_id, name, city) values ($1, 'Sede controlada', 'Prueba') returning id`,
      [tenantId]
    )
  ).rows[0]!.id;
  const professionalId = (
    await client.query<{ id: string }>(
      `insert into pulso_iris.professionals
         (tenant_id, name, professional_type, subspecialty, is_pilot)
       values ($1, 'Agenda piloto controlada', 'optometrist', 'Prueba', true) returning id`,
      [tenantId]
    )
  ).rows[0]!.id;
  const payerId = (
    await client.query<{ id: string }>(
      `insert into pulso_iris.payers (tenant_id, name, payer_group) values ($1, 'Particular controlado', 'particular') returning id`,
      [tenantId]
    )
  ).rows[0]!.id;
  const appointmentTypeId = (
    await client.query<{ id: string }>(
      `insert into pulso_iris.appointment_types
         (tenant_id, name, category, duration_min, bookable_by_ia)
       values ($1, 'Consulta controlada', 'consulta', 20, true) returning id`,
      [tenantId]
    )
  ).rows[0]!.id;
  await client.query(
    `insert into pulso_iris.professional_sites (tenant_id, professional_id, site_id)
     values ($1, $2, $3)`,
    [tenantId, professionalId, siteId]
  );
  await client.query(
    `insert into pulso_iris.professional_appointment_types (tenant_id, professional_id, appointment_type_id)
     values ($1, $2, $3)`,
    [tenantId, professionalId, appointmentTypeId]
  );

  const slot = nextWeekdayAtNine();
  const date = slot.toISOString().slice(0, 10);
  await client.query(
    `insert into pulso_iris.availability_rules
       (tenant_id, site_id, professional_id, appointment_type_id, weekday,
        starts_at, ends_at, slot_duration_min, capacity, timezone, effective_from, effective_to)
     values ($1, $2, $3, $4, $5, '09:00', '12:00', 20, 1, 'America/Bogota', $6, ($6::date + 30))`,
    [tenantId, siteId, professionalId, appointmentTypeId, slot.getUTCDay(), date]
  );
  const connectionId = (
    await client.query<{ id: string }>(
      `insert into channel_runtime.connections (tenant_id, state) values ($1, 'ready') returning id`,
      [tenantId]
    )
  ).rows[0]!.id;
  const bindingId = (
    await client.query<{ id: string }>(
      `insert into channel_runtime.thread_bindings
         (tenant_id, connection_id, provider, external_thread_id, phone_e164_hash, phone_masked)
       values ($1, $2, 'whatsapp_web_test', 'controlled@s.whatsapp.net', $3, '********4567') returning id`,
      [tenantId, connectionId, "a".repeat(64)]
    )
  ).rows[0]!.id;
  return {
    tenantId,
    otherTenantId,
    bindingId,
    siteId,
    professionalId,
    payerId,
    appointmentTypeId,
    scheduledAt: slot.toISOString()
  };
}

function nextWeekdayAtNine(): Date {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + 7);
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6) value.setUTCDate(value.getUTCDate() + 1);
  value.setUTCHours(14, 0, 0, 0);
  return value;
}
