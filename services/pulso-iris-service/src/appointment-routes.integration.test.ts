import { randomUUID } from "node:crypto";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAppointmentRoutes } from "./appointment-routes.js";
import { expireAppointmentHolds } from "./appointment-hold-expiration.js";
import type { EmitAuditEventInput } from "./audit-client.js";
import { registerAvailabilityRoutes } from "./availability-routes.js";
import { registerConfigRoutes } from "./config-routes.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

let app: ServiceHandle["app"];
let client: pg.Client;
let tenantId: string;
let patientId: string;
let alternatePatientId: string;
let conversationId: string;
let siteId: string;
let professionalId: string;
let payerId: string;
let appointmentTypeId: string;
let availabilityRuleId: string;
let slotDate: string;
const events: EmitAuditEventInput[] = [];

const advisorOneHeaders = { "x-operator-id": "advisor-one", "x-operator-role": "advisor" };
const advisorTwoHeaders = { "x-operator-id": "advisor-two", "x-operator-role": "advisor" };
const coordinatorHeaders = { "x-operator-id": "coordinator-one", "x-operator-role": "coordinator" };

describeIntegration("pulso-iris appointment lifecycle", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    tenantId = await createFixtures();

    const service = await createService({
      serviceName: "pulso-iris-service",
      databaseRequired: true,
      registerRoutes: async (serviceApp, context) => {
        const emitAudit = async (event: EmitAuditEventInput) => {
          events.push(event);
        };
        await registerConfigRoutes(serviceApp, context, emitAudit);
        await registerAppointmentRoutes(serviceApp, context, emitAudit);
        await registerAvailabilityRoutes(serviceApp, context);
      }
    });
    app = service.app;
  });

  afterAll(async () => {
    await app?.close();
    if (client) {
      if (tenantId) await client.query("delete from platform.tenants where id = $1", [tenantId]);
      await client.end();
    }
    delete process.env.DATABASE_URL;
  });

  it("creates idempotent holds and rejects reuse for another slot", async () => {
    const first = await createHold(0, "hold-idempotent-001", advisorOneHeaders);
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ status: "active", slotCapacityToken: 1 });

    const repeated = await createHold(0, "hold-idempotent-001", advisorOneHeaders);
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().data.id).toBe(first.json().data.id);

    const conflict = await createHold(1, "hold-idempotent-001", advisorOneHeaders);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().data.code).toBe("idempotency_conflict");

    const anotherPatient = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointment-holds`,
      headers: advisorOneHeaders,
      payload: {
        patientId: alternatePatientId,
        conversationId,
        siteId,
        professionalId,
        payerId,
        appointmentTypeId,
        scheduledAt: slotAt(0),
        idempotencyKey: "hold-idempotent-001"
      }
    });
    expect(anotherPatient.statusCode).toBe(409);
    expect(anotherPatient.json().data.code).toBe("idempotency_conflict");
  });

  it("serializes concurrent holds and returns alternatives to the loser", async () => {
    const [left, right] = await Promise.all([
      createHold(2, "hold-concurrent-left", advisorOneHeaders),
      createHold(2, "hold-concurrent-right", advisorTwoHeaders)
    ]);
    const responses = [left, right].sort((a, b) => a.statusCode - b.statusCode);

    expect(responses.map((response) => response.statusCode)).toEqual([201, 409]);
    expect(responses[1]!.json().data.alternatives.length).toBeGreaterThan(0);
    expect(responses[1]!.json().data.alternatives[0]).toMatchObject({
      localDate: slotDate,
      localTime: "09:00",
      timeZone: "America/Bogota"
    });
    const active = await client.query<{ count: number }>(
      `select count(*)::int as count from pulso_iris.appointment_holds
       where tenant_id = $1 and scheduled_at = $2 and status = 'active'`,
      [tenantId, slotAt(2)]
    );
    expect(active.rows[0]?.count).toBe(1);
  });

  it("expires holds, emits audit and releases their capacity", async () => {
    const created = await createHold(3, "hold-expiring-001", advisorOneHeaders);
    expect(created.statusCode).toBe(201);
    const holdId = created.json().data.id as string;

    await client.query(
      `update pulso_iris.appointment_holds
       set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
       where tenant_id = $1 and id = $2`,
      [tenantId, holdId]
    );
    const expired = await expireAppointmentHolds(client as never, async (event) => {
      events.push(event);
    });
    expect(expired).toBe(1);
    expect(events.some((event) => event.eventType === "appointment.hold.expired" && event.entityId === holdId)).toBe(
      true
    );

    const replacement = await createHold(3, "hold-after-expiry", advisorTwoHeaders);
    expect(replacement.statusCode).toBe(201);
  });

  it("persists expiration detected while submitting a hold", async () => {
    const created = await createHold(13, "hold-expired-on-submit", advisorOneHeaders);
    expect(created.statusCode).toBe(201);
    const holdId = created.json().data.id as string;
    await client.query(
      `update pulso_iris.appointment_holds
       set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
       where tenant_id = $1 and id = $2`,
      [tenantId, holdId]
    );

    const submitted = await submitHold(holdId, "appointment-expired-on-submit", advisorOneHeaders);
    expect(submitted.statusCode).toBe(410);
    expect(submitted.json().data.code).toBe("hold_expired");
    const persisted = await client.query<{ status: string }>(
      "select status from pulso_iris.appointment_holds where tenant_id = $1 and id = $2",
      [tenantId, holdId]
    );
    expect(persisted.rows[0]?.status).toBe("expired");
  });

  it("requires a coordinator and external evidence for hybrid verification", async () => {
    const hold = await createHold(4, "hold-hybrid-verify", advisorOneHeaders);
    const appointment = await submitHold(hold.json().data.id, "appointment-hybrid-verify", advisorOneHeaders);
    expect(appointment.statusCode).toBe(201);
    expect(appointment.json().data.status).toBe("pending_external_confirmation");
    expect(appointment.json().data.verificationMode).toBeUndefined();
    const appointmentId = appointment.json().data.id as string;

    const advisorAttempt = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${appointmentId}/manual-verify`,
      headers: advisorOneHeaders,
      payload: { externalReference: "EXT-ADVISOR", externalSystem: "Sistema controlado" }
    });
    expect(advisorAttempt.statusCode).toBe(403);

    const missingReference = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${appointmentId}/manual-verify`,
      headers: coordinatorHeaders,
      payload: { externalReference: "", externalSystem: "Sistema controlado" }
    });
    expect(missingReference.statusCode).toBe(400);

    const verified = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${appointmentId}/manual-verify`,
      headers: coordinatorHeaders,
      payload: {
        externalReference: "EXT-HYBRID-001",
        externalSystem: "Sistema controlado",
        note: "Registro manual verificado"
      }
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().data).toMatchObject({
      status: "verified",
      verificationMode: "manual_external",
      externalReference: "EXT-HYBRID-001",
      externalSystem: "Sistema controlado",
      verifiedBy: "coordinator-one"
    });
    expect(verified.json().data.verifiedAt).toBeTruthy();

    const confirmed = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${appointmentId}`,
      headers: coordinatorHeaders,
      payload: { status: "confirmed" }
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.status).toBe("confirmed");

    const history = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${appointmentId}/history`
    });
    expect(history.json().data.map((entry: { toStatus: string }) => entry.toStatus)).toEqual([
      "pending_external_confirmation",
      "verified",
      "confirmed"
    ]);
  });

  it("rejects and cancels pending appointments with valid transitions", async () => {
    const rejected = await createHybridAppointment(5, "appointment-rejected", advisorOneHeaders);
    const rejectedId = rejected.json().data.id as string;
    const rejection = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${rejectedId}/reject`,
      headers: coordinatorHeaders,
      payload: { reason: "No fue posible registrar externamente" }
    });
    expect(rejection.statusCode).toBe(200);
    expect(rejection.json().data).toMatchObject({
      status: "external_rejected",
      externalRejectionReason: "No fue posible registrar externamente",
      externalRejectedBy: "coordinator-one"
    });

    const invalidCancellation = await cancelAppointment(rejectedId, "No debe transicionar");
    expect(invalidCancellation.statusCode).toBe(409);

    const pending = await createHybridAppointment(6, "appointment-cancelled", advisorOneHeaders);
    const pendingId = pending.json().data.id as string;
    const cancelled = await cancelAppointment(pendingId, "Solicitud cancelada por el usuario");
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data).toMatchObject({
      status: "cancelled",
      cancellationReason: "Solicitud cancelada por el usuario",
      cancelledBy: "coordinator-one"
    });

    const released = await createHold(6, "hold-after-cancellation", advisorTwoHeaders);
    expect(released.statusCode).toBe(201);
  });

  it("reschedules by reserving the replacement before releasing the original", async () => {
    const original = await createHybridAppointment(7, "appointment-reschedule-source", advisorOneHeaders);
    const originalId = original.json().data.id as string;

    const unavailable = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${originalId}/reschedule`,
      headers: coordinatorHeaders,
      payload: {
        siteId,
        professionalId,
        appointmentTypeId,
        payerId,
        scheduledAt: slotAt(0),
        reason: "Intento sobre cupo no disponible",
        idempotencyKey: "appointment-reschedule-unavailable"
      }
    });
    expect(unavailable.statusCode).toBe(409);
    const unchanged = await client.query<{ status: string }>(
      "select status from pulso_iris.appointments where tenant_id = $1 and id = $2",
      [tenantId, originalId]
    );
    expect(unchanged.rows[0]?.status).toBe("pending_external_confirmation");

    const reschedulePayload = {
      siteId,
      professionalId,
      appointmentTypeId,
      payerId,
      scheduledAt: slotAt(8),
      reason: "Cambio solicitado por el usuario",
      idempotencyKey: "appointment-reschedule-target"
    };
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${originalId}/reschedule`,
      headers: coordinatorHeaders,
      payload: reschedulePayload
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      status: "pending_external_confirmation",
      previousAppointmentId: originalId,
      rescheduleCount: 1
    });
    const replacementId = response.json().data.id as string;

    const persisted = await client.query<{ status: string }>(
      "select status from pulso_iris.appointments where tenant_id = $1 and id = $2",
      [tenantId, originalId]
    );
    expect(persisted.rows[0]?.status).toBe("rescheduled");

    const idempotentRetry = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${originalId}/reschedule`,
      headers: coordinatorHeaders,
      payload: reschedulePayload
    });
    expect(idempotentRetry.statusCode).toBe(200);
    expect(idempotentRetry.json().data.id).toBe(replacementId);

    const verifiedReplacement = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${replacementId}/manual-verify`,
      headers: coordinatorHeaders,
      payload: { externalReference: "EXT-RESCHEDULE-001", externalSystem: "Sistema controlado" }
    });
    expect(verifiedReplacement.statusCode).toBe(200);
    expect(verifiedReplacement.json().data.verificationMode).toBe("manual_external");

    const repeated = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${originalId}/reschedule`,
      headers: coordinatorHeaders,
      payload: {
        siteId,
        professionalId,
        appointmentTypeId,
        scheduledAt: slotAt(9),
        reason: "Transicion invalida",
        idempotencyKey: "appointment-reschedule-invalid"
      }
    });
    expect(repeated.statusCode).toBe(409);
  });

  it("filters the operational queue for advisors", async () => {
    const owned = await createHybridAppointment(9, "queue-advisor-one", advisorOneHeaders);
    const other = await createHybridAppointment(10, "queue-advisor-two", advisorTwoHeaders);
    const ownedId = owned.json().data.id as string;
    const otherId = other.json().data.id as string;

    const advisorQueue = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/queue`,
      headers: advisorOneHeaders
    });
    expect(advisorQueue.statusCode).toBe(200);
    const advisorIds = advisorQueue.json().data.appointments.map((appointment: { id: string }) => appointment.id);
    expect(advisorIds).toContain(ownedId);
    expect(advisorIds).not.toContain(otherId);

    const coordinatorQueue = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/queue`,
      headers: coordinatorHeaders
    });
    const coordinatorIds = coordinatorQueue
      .json()
      .data.appointments.map((appointment: { id: string }) => appointment.id);
    expect(coordinatorIds).toEqual(expect.arrayContaining([ownedId, otherId]));
  });

  it("deduplicates concurrent requests with the same hold idempotency key", async () => {
    const [left, right] = await Promise.all([
      createHold(12, "hold-concurrent-same-key", advisorOneHeaders),
      createHold(12, "hold-concurrent-same-key", advisorOneHeaders)
    ]);
    const responses = [left, right].sort((a, b) => a.statusCode - b.statusCode);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 201]);
    expect(responses[0]!.json().data.id).toBe(responses[1]!.json().data.id);

    const count = await client.query<{ count: number }>(
      `select count(*)::int as count from pulso_iris.appointment_holds
       where tenant_id = $1 and idempotency_key = 'hold-concurrent-same-key'`,
      [tenantId]
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("uses the PostgreSQL transaction as internal verification evidence", async () => {
    const settings = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantId}/pulso-iris/config/agenda-settings`,
      headers: coordinatorHeaders,
      payload: { mode: "internal", externalReferenceRequired: false }
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().data.mode).toBe("internal");

    const created = await createInternalAppointment(11, "appointment-internal-001");
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      status: "verified",
      verificationMode: "internal"
    });
    expect(created.json().data.externalReference).toBeUndefined();
    expect(created.json().data.verifiedAt).toBeTruthy();
    const appointmentId = created.json().data.id as string;

    const repeated = await createInternalAppointment(11, "appointment-internal-001");
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().data.id).toBe(appointmentId);

    const evidence = await client.query<{
      status: string;
      verificationMode: string;
      verifiedAt: Date;
      externalReference: string | null;
    }>(
      `select status, verification_mode as "verificationMode", verified_at as "verifiedAt",
              external_reference as "externalReference"
       from pulso_iris.appointments where tenant_id = $1 and id = $2`,
      [tenantId, appointmentId]
    );
    expect(evidence.rows[0]).toMatchObject({
      status: "verified",
      verificationMode: "internal",
      externalReference: null
    });
    expect(evidence.rows[0]?.verifiedAt).toBeInstanceOf(Date);

    const manualVerification = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${appointmentId}/manual-verify`,
      headers: coordinatorHeaders,
      payload: { externalReference: "EXT-NOT-ALLOWED", externalSystem: "Sistema controlado" }
    });
    expect(manualVerification.statusCode).toBe(409);
    expect(events.some((event) => event.eventType === "appointment.verified" && event.entityId === appointmentId)).toBe(
      true
    );
  });

  it("allocates every capacity token once under concurrent load", async () => {
    await client.query("update pulso_iris.availability_rules set capacity = 2 where id = $1", [availabilityRuleId]);
    const responses = await Promise.all([
      createHold(14, "hold-capacity-two-a", advisorOneHeaders),
      createHold(14, "hold-capacity-two-b", advisorTwoHeaders),
      createHold(14, "hold-capacity-two-c", coordinatorHeaders)
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 201, 409]);

    const tokens = await client.query<{ token: number }>(
      `select slot_capacity_token as token
       from pulso_iris.appointment_holds
       where tenant_id = $1 and scheduled_at = $2 and status = 'active'
       order by slot_capacity_token`,
      [tenantId, slotAt(14)]
    );
    expect(tokens.rows.map((row) => row.token)).toEqual([1, 2]);
  });
});

async function createFixtures(): Promise<string> {
  const slug = `appointment-lifecycle-${randomUUID()}`;
  const tenant = await client.query<{ id: string }>(
    `insert into platform.tenants (slug, display_name, status)
     values ($1, $1, 'active') returning id`,
    [slug]
  );
  const createdTenantId = tenant.rows[0]!.id;
  const patient = await client.query<{ id: string }>(
    `insert into pulso_iris.administrative_patients (tenant_id, full_name)
     values ($1, 'Paciente sintetico') returning id`,
    [createdTenantId]
  );
  const alternatePatient = await client.query<{ id: string }>(
    `insert into pulso_iris.administrative_patients (tenant_id, full_name)
     values ($1, 'Paciente sintetico alterno') returning id`,
    [createdTenantId]
  );
  const site = await client.query<{ id: string }>(
    "insert into pulso_iris.sites (tenant_id, name) values ($1, 'Sede sintetica') returning id",
    [createdTenantId]
  );
  const professional = await client.query<{ id: string }>(
    `insert into pulso_iris.professionals (tenant_id, name, professional_type)
     values ($1, 'Profesional sintetico', 'optometrist') returning id`,
    [createdTenantId]
  );
  const payer = await client.query<{ id: string }>(
    `insert into pulso_iris.payers (tenant_id, name, payer_group)
     values ($1, 'Convenio sintetico', 'particular') returning id`,
    [createdTenantId]
  );
  const appointmentType = await client.query<{ id: string }>(
    `insert into pulso_iris.appointment_types
       (tenant_id, name, category, duration_min, bookable_by_ia)
     values ($1, 'Consulta sintetica', 'consulta', 20, true) returning id`,
    [createdTenantId]
  );
  const conversation = await client.query<{ id: string }>(
    `insert into pulso_iris.conversations (tenant_id, patient_id, site_id, channel)
     values ($1, $2, $3, 'whatsapp') returning id`,
    [createdTenantId, patient.rows[0]!.id, site.rows[0]!.id]
  );

  patientId = patient.rows[0]!.id;
  alternatePatientId = alternatePatient.rows[0]!.id;
  siteId = site.rows[0]!.id;
  professionalId = professional.rows[0]!.id;
  payerId = payer.rows[0]!.id;
  appointmentTypeId = appointmentType.rows[0]!.id;
  conversationId = conversation.rows[0]!.id;
  slotDate = nextWeekdayDate(1);

  await client.query(
    `update pulso_iris.agenda_settings
     set mode = 'hybrid_manual', timezone = 'America/Bogota', booking_horizon_days = 90,
         hold_duration_minutes = 10, max_alternatives = 3, max_reschedules = 3,
         external_confirmation_sla_minutes = 240, external_reference_required = true,
         capacity_policy = 'strict', status = 'active'
     where tenant_id = $1`,
    [createdTenantId]
  );
  await client.query(
    `insert into pulso_iris.professional_sites (tenant_id, professional_id, site_id)
     values ($1, $2, $3)`,
    [createdTenantId, professionalId, siteId]
  );
  await client.query(
    `insert into pulso_iris.professional_appointment_types
       (tenant_id, professional_id, appointment_type_id)
     values ($1, $2, $3)`,
    [createdTenantId, professionalId, appointmentTypeId]
  );
  const availabilityRule = await client.query<{ id: string }>(
    `insert into pulso_iris.availability_rules
       (tenant_id, site_id, professional_id, appointment_type_id, weekday,
        starts_at, ends_at, slot_duration_min, capacity, timezone)
     values ($1, $2, $3, $4, 1, '08:00', '18:00', 20, 1, 'America/Bogota')
     returning id`,
    [createdTenantId, siteId, professionalId, appointmentTypeId]
  );
  availabilityRuleId = availabilityRule.rows[0]!.id;

  return createdTenantId;
}

async function createHold(
  slotIndex: number,
  idempotencyKey: string,
  headers: Record<string, string>
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  return app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/pulso-iris/appointment-holds`,
    headers,
    payload: {
      patientId,
      conversationId,
      siteId,
      professionalId,
      payerId,
      appointmentTypeId,
      scheduledAt: slotAt(slotIndex),
      idempotencyKey
    }
  });
}

async function submitHold(
  holdId: string,
  idempotencyKey: string,
  headers: Record<string, string>
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  return app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/pulso-iris/appointments`,
    headers,
    payload: { holdId, idempotencyKey, origin: "advisor" }
  });
}

async function createHybridAppointment(
  slotIndex: number,
  idempotencyKey: string,
  headers: Record<string, string>
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  return app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/pulso-iris/appointments`,
    headers,
    payload: {
      patientId,
      conversationId,
      siteId,
      professionalId,
      payerId,
      appointmentTypeId,
      scheduledAt: slotAt(slotIndex),
      idempotencyKey,
      origin: "advisor"
    }
  });
}

async function cancelAppointment(
  appointmentId: string,
  reason: string
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  return app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/pulso-iris/appointments/${appointmentId}/cancel`,
    headers: coordinatorHeaders,
    payload: { reason }
  });
}

async function createInternalAppointment(
  slotIndex: number,
  idempotencyKey: string
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  return app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantId}/pulso-iris/appointments`,
    headers: coordinatorHeaders,
    payload: {
      patientId,
      conversationId,
      siteId,
      professionalId,
      payerId,
      appointmentTypeId,
      scheduledAt: slotAt(slotIndex),
      idempotencyKey,
      origin: "advisor"
    }
  });
}

function slotAt(index: number): string {
  const totalMinutes = 8 * 60 + index * 20;
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return new Date(`${slotDate}T${hours}:${minutes}:00-05:00`).toISOString();
}

function nextWeekdayDate(targetWeekday: number): string {
  for (let offset = 7; offset <= 14; offset += 1) {
    const candidate = new Date(Date.now() + offset * 86_400_000);
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(candidate);
    if (new Date(`${localDate}T12:00:00Z`).getUTCDay() === targetWeekday) return localDate;
  }
  throw new Error("Could not calculate a future weekday");
}
