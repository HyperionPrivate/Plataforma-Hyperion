import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmitAuditEventInput } from "./audit-client.js";
import { registerAnalyticsRoutes } from "./analytics-routes.js";
import { registerAppointmentRoutes } from "./appointment-routes.js";
import { registerAvailabilityRoutes } from "./availability-routes.js";
import { registerConfigRoutes } from "./config-routes.js";
import { registerOperationsRoutes } from "./operations-routes.js";

const { Client } = pg;

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

let app: ServiceHandle["app"];
let client: pg.Client;
let tenantA: string;
let tenantB: string;
let patientA: string;
let patientB: string;
let siteA: string;
let siteB: string;
let professionalA: string;
let payerA: string;
let typeA: string;
let conversationA: string;
const emittedEvents: EmitAuditEventInput[] = [];

describeIntegration("pulso-iris tenant isolation", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await resetTenantFixtures();
    tenantA = await createTenant("isolation-a");
    tenantB = await createTenant("isolation-b");
    const catalogA = await createCoreCatalog(tenantA, "A");
    const catalogB = await createCoreCatalog(tenantB, "B");
    patientA = catalogA.patientId;
    siteA = catalogA.siteId;
    professionalA = catalogA.professionalId;
    payerA = catalogA.payerId;
    typeA = catalogA.appointmentTypeId;
    conversationA = catalogA.conversationId;
    patientB = catalogB.patientId;
    siteB = catalogB.siteId;

    const handle = await createService({
      serviceName: "pulso-iris-service",
      databaseRequired: true,
      registerRoutes: async (serviceApp, context) => {
        const emitAudit = async (event: EmitAuditEventInput) => {
          emittedEvents.push(event);
        };
        await registerConfigRoutes(serviceApp, context, emitAudit);
        await registerAppointmentRoutes(serviceApp, context, emitAudit);
        await registerOperationsRoutes(serviceApp, context, emitAudit);
        await registerAvailabilityRoutes(serviceApp, context);
        await registerAnalyticsRoutes(serviceApp, context);
      }
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app?.close();
    await resetTenantFixtures();
    await client?.end();
    delete process.env.DATABASE_URL;
  });

  it("rejects cross-tenant patient references through the API", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/appointments`,
      payload: {
        patientId: patientB,
        siteId: siteA,
        professionalId: professionalA,
        payerId: payerA,
        appointmentTypeId: typeA,
        scheduledAt: "2026-09-17T15:40:00.000Z",
        idempotencyKey: "cross-tenant-patient"
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().data.error).toContain("patientId");
  });

  it("rejects cross-tenant site references through the API", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/conversations`,
      payload: {
        patientId: patientA,
        siteId: siteB,
        channel: "whatsapp",
        primaryIntent: "agendar_cita"
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().data.error).toContain("siteId");
  });

  it("stores messages with tenant_id and rejects direct SQL cross-tenant message inserts", async () => {
    const message = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/conversations/${conversationA}/messages`,
      payload: {
        sender: "patient",
        body: "Quiero una cita de control"
      }
    });

    expect(message.statusCode).toBe(201);
    expect(message.json().data.tenantId).toBe(tenantA);

    await expect(
      client.query(
        `insert into pulso_iris.messages (tenant_id, conversation_id, sender, body)
         values ($1, $2, 'patient', 'cross tenant')`,
        [tenantB, conversationA]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects direct SQL cross-tenant appointment inserts with composite foreign keys", async () => {
    await expect(
      client.query(
        `insert into pulso_iris.appointments
           (tenant_id, patient_id, site_id, professional_id, payer_id, appointment_type_id, scheduled_at)
         values ($1, $2, $3, $4, $5, $6, '2026-09-17T15:40:00Z')`,
        [tenantA, patientB, siteA, professionalA, payerA, typeA]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("creates agenda availability rules for same-tenant catalog references", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/availability-rules`,
      payload: {
        siteId: siteA,
        professionalId: professionalA,
        appointmentTypeId: typeA,
        weekday: 1,
        startsAt: "08:00",
        endsAt: "12:00",
        slotDurationMin: 20,
        capacity: 2,
        notes: "Agenda manana"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.capacity).toBe(2);

    const list = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/availability-rules`
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
  });

  it("rejects cross-tenant availability rule references through the API", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/availability-rules`,
      payload: {
        siteId: siteB,
        professionalId: professionalA,
        appointmentTypeId: typeA,
        weekday: 2,
        startsAt: "08:00",
        endsAt: "12:00"
      }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().data.error).toContain("siteId");
  });

  it("rejects direct SQL cross-tenant availability rule inserts with composite foreign keys", async () => {
    await expect(
      client.query(
        `insert into pulso_iris.availability_rules
           (tenant_id, site_id, professional_id, appointment_type_id, weekday, starts_at, ends_at)
         values ($1, $2, $3, $4, 3, '08:00', '12:00')`,
        [tenantA, siteB, professionalA, typeA]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("generates availability slots and consumes capacity when an appointment is registered", async () => {
    const rule = await createRule({
      weekday: 1,
      startsAt: "14:00",
      endsAt: "15:00",
      capacity: 1
    });
    expect(rule.statusCode).toBe(201);

    const before = await app.inject({
      method: "GET",
      url:
        `/v1/tenants/${tenantA}/pulso-iris/availability/slots` +
        `?from=2026-09-14T18:30:00.000Z&to=2026-09-14T20:00:00.000Z` +
        `&siteId=${siteA}&professionalId=${professionalA}&appointmentTypeId=${typeA}`
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().data.slots[0]).toMatchObject({
      startsAt: "2026-09-14T19:00:00.000Z",
      localDate: "2026-09-14",
      localTime: "14:00",
      timeZone: "America/Bogota",
      capacity: 1,
      booked: 0,
      remaining: 1,
      status: "available"
    });

    const appointment = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/appointments`,
      payload: {
        patientId: patientA,
        siteId: siteA,
        professionalId: professionalA,
        payerId: payerA,
        appointmentTypeId: typeA,
        scheduledAt: "2026-09-14T19:00:00.000Z",
        origin: "advisor",
        idempotencyKey: "capacity-registration-1"
      }
    });
    expect(appointment.statusCode).toBe(201);

    const full = await app.inject({
      method: "GET",
      url:
        `/v1/tenants/${tenantA}/pulso-iris/availability/slots` +
        `?from=2026-09-14T18:30:00.000Z&to=2026-09-14T20:00:00.000Z` +
        `&siteId=${siteA}&professionalId=${professionalA}&appointmentTypeId=${typeA}&includeFull=true`
    });
    const consumed = full
      .json()
      .data.slots.find((slot: { startsAt: string }) => slot.startsAt === "2026-09-14T19:00:00.000Z");
    expect(consumed).toMatchObject({ booked: 1, remaining: 0, status: "full" });

    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/appointments`,
      payload: {
        patientId: patientA,
        siteId: siteA,
        professionalId: professionalA,
        payerId: payerA,
        appointmentTypeId: typeA,
        scheduledAt: "2026-09-14T19:00:00.000Z",
        origin: "advisor",
        idempotencyKey: "capacity-registration-2"
      }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().data.alternatives[0]).toMatchObject({
      localDate: "2026-09-14",
      localTime: "14:20",
      timeZone: "America/Bogota"
    });
  });

  it("rejects scheduled appointments outside configured availability", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/appointments`,
      payload: {
        patientId: patientA,
        siteId: siteA,
        professionalId: professionalA,
        payerId: payerA,
        appointmentTypeId: typeA,
        scheduledAt: "2026-09-17T15:40:00.000Z",
        idempotencyKey: "outside-availability"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().data.error).toContain("not available");
  });

  it("projects local slot fields from the availability rule timezone", async () => {
    const rule = await createRule({
      weekday: 2,
      startsAt: "11:00",
      endsAt: "12:00",
      capacity: 1,
      timezone: "America/New_York"
    });
    expect(rule.statusCode).toBe(201);

    const response = await app.inject({
      method: "GET",
      url:
        `/v1/tenants/${tenantA}/pulso-iris/availability/slots` +
        `?from=2026-09-15T14:30:00.000Z&to=2026-09-15T17:00:00.000Z` +
        `&siteId=${siteA}&professionalId=${professionalA}&appointmentTypeId=${typeA}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.slots[0]).toMatchObject({
      startsAt: "2026-09-15T15:00:00.000Z",
      localDate: "2026-09-15",
      localTime: "11:00",
      timeZone: "America/New_York"
    });
  });

  it("includes the rule-local day when it differs from the tenant-local day", async () => {
    await client.query("update pulso_iris.agenda_settings set timezone = 'Etc/GMT+12' where tenant_id = $1", [tenantA]);
    let ruleId: string | undefined;

    try {
      const rule = await createRule({
        weekday: 2,
        startsAt: "01:00",
        endsAt: "02:00",
        capacity: 1,
        timezone: "Pacific/Kiritimati"
      });
      expect(rule.statusCode).toBe(201);
      ruleId = rule.json().data.id as string;

      const response = await app.inject({
        method: "GET",
        url:
          `/v1/tenants/${tenantA}/pulso-iris/availability/slots` +
          `?from=2026-09-14T10:30:00.000Z&to=2026-09-14T12:30:00.000Z` +
          `&siteId=${siteA}&professionalId=${professionalA}&appointmentTypeId=${typeA}`
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.slots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            startsAt: "2026-09-14T11:00:00.000Z",
            localDate: "2026-09-15",
            localTime: "01:00",
            timeZone: "Pacific/Kiritimati"
          })
        ])
      );
    } finally {
      if (ruleId) {
        await client.query("delete from pulso_iris.availability_rules where tenant_id = $1 and id = $2", [
          tenantA,
          ruleId
        ]);
      }
      await client.query("update pulso_iris.agenda_settings set timezone = 'America/Bogota' where tenant_id = $1", [
        tenantA
      ]);
    }
  });

  it("excludes active agenda blocks from generated slots", async () => {
    const rule = await createRule({
      weekday: 1,
      startsAt: "15:00",
      endsAt: "16:00",
      capacity: 1
    });
    expect(rule.statusCode).toBe(201);

    const block = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/agenda-blocks`,
      payload: {
        siteId: siteA,
        professionalId: professionalA,
        appointmentTypeId: typeA,
        startsAt: "2026-09-14T20:00:00.000Z",
        endsAt: "2026-09-14T20:20:00.000Z",
        reason: "Ausencia profesional"
      }
    });
    expect(block.statusCode).toBe(201);

    const slots = await app.inject({
      method: "GET",
      url:
        `/v1/tenants/${tenantA}/pulso-iris/availability/slots` +
        `?from=2026-09-14T19:30:00.000Z&to=2026-09-14T21:00:00.000Z` +
        `&siteId=${siteA}&professionalId=${professionalA}&appointmentTypeId=${typeA}`
    });
    expect(slots.statusCode).toBe(200);
    const starts = slots.json().data.slots.map((slot: { startsAt: string }) => slot.startsAt);
    expect(starts).not.toContain("2026-09-14T20:00:00.000Z");
    expect(starts).toContain("2026-09-14T20:20:00.000Z");
  });

  it("excludes holidays from generated slots", async () => {
    const rule = await createRule({
      weekday: 3,
      startsAt: "08:00",
      endsAt: "10:00",
      capacity: 1
    });
    expect(rule.statusCode).toBe(201);

    const before = await app.inject({
      method: "GET",
      url:
        `/v1/tenants/${tenantA}/pulso-iris/availability/slots` +
        `?from=2026-09-16T12:00:00.000Z&to=2026-09-16T16:00:00.000Z` +
        `&siteId=${siteA}&professionalId=${professionalA}&appointmentTypeId=${typeA}`
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().data.slots.length).toBeGreaterThan(0);

    const holiday = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/holidays`,
      payload: { holidayDate: "2026-09-16", name: "Festivo de prueba" }
    });
    expect(holiday.statusCode).toBe(201);

    const slots = await app.inject({
      method: "GET",
      url:
        `/v1/tenants/${tenantA}/pulso-iris/availability/slots` +
        `?from=2026-09-16T12:00:00.000Z&to=2026-09-16T16:00:00.000Z` +
        `&siteId=${siteA}&professionalId=${professionalA}&appointmentTypeId=${typeA}`
    });
    expect(slots.statusCode).toBe(200);
    expect(slots.json().data.slots).toHaveLength(0);
  });

  it("filters payer exclusions from slots and blocks reservation", async () => {
    const rule = await createRule({
      weekday: 2,
      startsAt: "09:00",
      endsAt: "10:00",
      capacity: 1
    });
    expect(rule.statusCode).toBe(201);

    const exclusion = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/payer-exclusions`,
      payload: { professionalId: professionalA, payerId: payerA }
    });
    expect(exclusion.statusCode).toBe(201);

    const slots = await app.inject({
      method: "GET",
      url:
        `/v1/tenants/${tenantA}/pulso-iris/availability/slots` +
        `?from=2026-09-15T13:00:00.000Z&to=2026-09-15T16:00:00.000Z` +
        `&siteId=${siteA}&professionalId=${professionalA}&appointmentTypeId=${typeA}&payerId=${payerA}`
    });
    expect(slots.statusCode).toBe(200);
    expect(slots.json().data.slots).toHaveLength(0);

    const appointment = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/appointments`,
      payload: {
        patientId: patientA,
        siteId: siteA,
        professionalId: professionalA,
        payerId: payerA,
        appointmentTypeId: typeA,
        scheduledAt: "2026-09-15T14:00:00.000Z",
        idempotencyKey: "excluded-payer"
      }
    });
    expect(appointment.statusCode).toBe(422);
    expect(appointment.json().data.error).toContain("excluded");
  });

  it("rejects availability rules with slot shorter than appointment type", async () => {
    const response = await createRule({
      weekday: 3,
      startsAt: "08:00",
      endsAt: "09:00",
      capacity: 1,
      slotDurationMin: 10
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().data.error).toContain("slotDurationMin");
  });

  it("rejects appointment type duration that breaks active rules", async () => {
    const rule = await createRule({
      weekday: 4,
      startsAt: "08:00",
      endsAt: "09:00",
      capacity: 1,
      slotDurationMin: 20
    });
    expect(rule.statusCode).toBe(201);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/appointment-types/${typeA}`,
      payload: { durationMin: 30 }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().data.error).toContain("durationMin");
  });

  it("rejects direct SQL cross-tenant holiday and payer exclusion inserts", async () => {
    await expect(
      client.query(
        `insert into pulso_iris.professional_payer_exclusions
           (tenant_id, professional_id, payer_id)
         values ($1, $2, $3)`,
        [tenantA, professionalA, (await createCoreCatalog(tenantB, "BX")).payerId]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("verifies queued register_appointment actions through the simulator tick", async () => {
    const { runSimulatorTick } = await import("./appointment-verification-simulator.js");
    const events: Array<{ eventType: string; actorId?: string }> = [];

    await createRule({
      weekday: 5,
      startsAt: "10:00",
      endsAt: "11:00",
      capacity: 1
    });

    const created = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/simulation/appointments`,
      headers: { "x-operator-id": "operator-test" },
      payload: {
        patientId: patientA,
        siteId: siteA,
        professionalId: professionalA,
        appointmentTypeId: typeA,
        scheduledAt: "2026-09-18T15:00:00.000Z",
        origin: "advisor"
      }
    });
    expect(created.statusCode).toBe(201);
    const appointmentId = created.json().data.id as string;

    await client.query(
      `insert into pulso_iris.rpa_workers (tenant_id, name, status, last_keepalive_at)
       values ($1, 'SIM-WORKER', 'active', now())
       on conflict (tenant_id, name) do update set status = 'active', last_keepalive_at = now()`,
      [tenantA]
    );

    const completed = await runSimulatorTick(client as never, async (event) => {
      events.push({ eventType: event.eventType, actorId: event.actorId });
    });
    expect(completed).toBeGreaterThanOrEqual(1);

    const appointment = await client.query<{ status: string; metadata: Record<string, unknown> }>(
      `select status, metadata from pulso_iris.appointments where id = $1`,
      [appointmentId]
    );
    expect(appointment.rows[0]?.status).toBe("verified");
    expect(appointment.rows[0]?.metadata).toMatchObject({
      simulated: true,
      verificationMode: "simulator"
    });

    const action = await client.query<{ status: string; metadata: Record<string, unknown> }>(
      `select status, metadata from pulso_iris.rpa_actions
       where tenant_id = $1 and appointment_id = $2 and action_type = 'register_appointment'`,
      [tenantA, appointmentId]
    );
    expect(action.rows[0]?.status).toBe("succeeded");
    expect(action.rows[0]?.metadata).toMatchObject({
      simulated: true,
      verificationMode: "simulator"
    });
    expect(events.some((event) => event.eventType === "appointment.verified" && event.actorId === "simulator")).toBe(
      true
    );
  });

  it("rejects direct SQL cross-tenant agenda block inserts with composite foreign keys", async () => {
    await expect(
      client.query(
        `insert into pulso_iris.agenda_blocks
           (tenant_id, site_id, professional_id, appointment_type_id, starts_at, ends_at, reason)
         values ($1, $2, $3, $4, '2026-09-14T20:00:00Z', '2026-09-14T20:20:00Z', 'cross tenant')`,
        [tenantA, siteB, professionalA, typeA]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("emits config.updated when creating a holiday", async () => {
    const before = emittedEvents.length;
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/holidays`,
      headers: { "x-operator-id": "operator-config" },
      payload: { holidayDate: "2026-12-08", name: "Inmaculada" }
    });
    expect(response.statusCode).toBe(201);
    const events = emittedEvents.slice(before);
    expect(events.some((event) => event.eventType === "config.updated" && event.entityType === "holiday")).toBe(true);
    expect(events.find((event) => event.eventType === "config.updated")?.actorId).toBe("operator-config");
  });

  it("emits handoff.assigned when a handoff is assigned", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/handoffs`,
      payload: {
        conversationId: conversationA,
        patientId: patientA,
        triggerCode: "caso_sensible",
        priority: "medium",
        summary: "Caso de prueba de auditoria"
      }
    });
    expect(created.statusCode).toBe(201);
    const handoffId = created.json().data.id as string;

    const before = emittedEvents.length;
    const assigned = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/pulso-iris/handoffs/${handoffId}`,
      headers: { "x-operator-id": "operator-handoff" },
      payload: { status: "assigned" }
    });
    expect(assigned.statusCode).toBe(200);
    const events = emittedEvents.slice(before);
    expect(
      events.some(
        (event) =>
          event.eventType === "handoff.assigned" && event.entityId === handoffId && event.actorId === "operator-handoff"
      )
    ).toBe(true);
  });
});

async function resetTenantFixtures(): Promise<void> {
  await client.query("delete from platform.tenants where slug in ('isolation-a', 'isolation-b')");
}

async function createTenant(slug: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "insert into platform.tenants (slug, display_name) values ($1, $2) returning id",
    [slug, slug]
  );
  return result.rows[0]!.id;
}

async function createCoreCatalog(
  tenantId: string,
  suffix: string
): Promise<{
  patientId: string;
  siteId: string;
  professionalId: string;
  payerId: string;
  appointmentTypeId: string;
  conversationId: string;
}> {
  const patient = await client.query<{ id: string }>(
    `insert into pulso_iris.administrative_patients (tenant_id, full_name, phone)
     values ($1, $2, $3) returning id`,
    [tenantId, `Paciente ${suffix}`, `+57 300 000 00${suffix}`]
  );
  const site = await client.query<{ id: string }>(
    `insert into pulso_iris.sites (tenant_id, name, city)
     values ($1, $2, 'Bucaramanga') returning id`,
    [tenantId, `Sede ${suffix}`]
  );
  const professional = await client.query<{ id: string }>(
    `insert into pulso_iris.professionals (tenant_id, name, professional_type)
     values ($1, $2, 'ophthalmologist') returning id`,
    [tenantId, `Dra. ${suffix}`]
  );
  const payer = await client.query<{ id: string }>(
    `insert into pulso_iris.payers (tenant_id, name, payer_group)
     values ($1, $2, 'eps') returning id`,
    [tenantId, `EPS ${suffix}`]
  );
  const appointmentType = await client.query<{ id: string }>(
    `insert into pulso_iris.appointment_types (tenant_id, name, category, duration_min)
     values ($1, $2, 'consulta', 20) returning id`,
    [tenantId, `Consulta ${suffix}`]
  );
  const conversation = await client.query<{ id: string }>(
    `insert into pulso_iris.conversations (tenant_id, patient_id, site_id, channel, primary_intent)
     values ($1, $2, $3, 'whatsapp', 'agendar_cita') returning id`,
    [tenantId, patient.rows[0]!.id, site.rows[0]!.id]
  );

  await client.query(
    `insert into pulso_iris.professional_sites (tenant_id, professional_id, site_id)
     values ($1, $2, $3)`,
    [tenantId, professional.rows[0]!.id, site.rows[0]!.id]
  );
  await client.query(
    `insert into pulso_iris.professional_appointment_types
       (tenant_id, professional_id, appointment_type_id)
     values ($1, $2, $3)`,
    [tenantId, professional.rows[0]!.id, appointmentType.rows[0]!.id]
  );

  return {
    patientId: patient.rows[0]!.id,
    siteId: site.rows[0]!.id,
    professionalId: professional.rows[0]!.id,
    payerId: payer.rows[0]!.id,
    appointmentTypeId: appointmentType.rows[0]!.id,
    conversationId: conversation.rows[0]!.id
  };
}

async function createRule(input: {
  weekday: number;
  startsAt: string;
  endsAt: string;
  capacity: number;
  slotDurationMin?: number;
  timezone?: string;
}): Promise<Awaited<ReturnType<typeof app.inject>>> {
  return app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantA}/pulso-iris/config/availability-rules`,
    payload: {
      siteId: siteA,
      professionalId: professionalA,
      appointmentTypeId: typeA,
      weekday: input.weekday,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      slotDurationMin: input.slotDurationMin ?? 20,
      capacity: input.capacity,
      timezone: input.timezone
    }
  });
}
