import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

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
      registerRoutes
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
        scheduledAt: "2026-09-17T15:40:00.000Z"
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
    ).rejects.toMatchObject({ code: "23503" });
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

  return {
    patientId: patient.rows[0]!.id,
    siteId: site.rows[0]!.id,
    professionalId: professional.rows[0]!.id,
    payerId: payer.rows[0]!.id,
    appointmentTypeId: appointmentType.rows[0]!.id,
    conversationId: conversation.rows[0]!.id
  };
}
