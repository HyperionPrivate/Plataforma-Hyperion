import { randomUUID } from "node:crypto";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enqueuePulsoAuditEvent, type EmitAuditEventInput, PULSO_AUDIT_EVENT_TYPE } from "./audit-client.js";
import { registerConfigRoutes } from "./config-routes.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_PULSO_FIXTURE_DATABASE_URL = process.env.TEST_PULSO_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_PULSO_FIXTURE_DATABASE_URL ? describe : describe.skip;

let app: ServiceHandle["app"];
let client: pg.Client;
let fixtureClient: pg.Client;
let tenantA: string;
let tenantB: string;
let siteA: string;
let siteB: string;
let professionalA: string;
let appointmentTypeA: string;
let payerA: string;
const events: EmitAuditEventInput[] = [];
let failingAuditSiteName: string | undefined;
let failingAuditObservedUncommittedMutation = false;
let failingAuditImportProfessionalName: string | undefined;
let failingAuditObservedUncommittedImport = false;

describeIntegration("pulso-iris configurable agenda", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    client = new Client({ connectionString: TEST_DATABASE_URL });
    fixtureClient = new Client({ connectionString: TEST_PULSO_FIXTURE_DATABASE_URL });
    await client.connect();
    await fixtureClient.connect();

    tenantA = await createTenant("agenda-config-a");
    tenantB = await createTenant("agenda-config-b");
    const catalogA = await createCatalog(tenantA, "A");
    const catalogB = await createCatalog(tenantB, "B");
    siteA = catalogA.siteId;
    siteB = catalogB.siteId;
    professionalA = catalogA.professionalId;
    appointmentTypeA = catalogA.appointmentTypeId;
    payerA = catalogA.payerId;

    const service = await createService({
      serviceName: "pulso-iris-service",
      databaseRequired: true,
      registerRoutes: async (serviceApp, context) => {
        await registerConfigRoutes(serviceApp, context, async (event, executor) => {
          if (!executor) {
            throw new Error("Config audit must receive the active transaction executor");
          }
          events.push(event);
          if (failingAuditSiteName && event.entityType === "site" && event.entityId) {
            const visible = await executor.query<{ name: string }>(
              "select name from pulso_iris.sites where tenant_id = $1 and id = $2",
              [event.tenantId, event.entityId]
            );
            failingAuditObservedUncommittedMutation = visible.rows[0]?.name === failingAuditSiteName;
            throw new Error("forced config audit failure");
          }
          if (
            failingAuditImportProfessionalName &&
            event.eventType === "agenda.configuration.imported" &&
            event.entityId
          ) {
            const visible = await executor.query<{ visible: boolean }>(
              `select
                 exists(
                   select 1 from pulso_iris.configuration_imports
                   where tenant_id = $1 and id = $2
                 ) and exists(
                   select 1 from pulso_iris.professionals
                   where tenant_id = $1 and name = $3
                 ) as visible`,
              [event.tenantId, event.entityId, failingAuditImportProfessionalName]
            );
            failingAuditObservedUncommittedImport = visible.rows[0]?.visible === true;
            throw new Error("forced configuration import audit failure");
          }
          await enqueuePulsoAuditEvent(executor, event);
        });
      }
    });
    app = service.app;
  });

  afterAll(async () => {
    await app?.close();
    if (client) {
      await client.end();
    }
    if (fixtureClient) {
      if (tenantA) await fixtureClient.query("delete from platform.tenants where id = $1", [tenantA]);
      if (tenantB) await fixtureClient.query("delete from platform.tenants where id = $1", [tenantB]);
      await fixtureClient.end();
    }
    delete process.env.DATABASE_URL;
  });

  it("keeps settings tenant-scoped and blocks active legacy mode", async () => {
    const beforeFirstPulsoUse = await client.query<{ count: number }>(
      "select count(*)::int as count from pulso_iris.agenda_settings where tenant_id = $1",
      [tenantA]
    );
    expect(beforeFirstPulsoUse.rows[0]?.count).toBe(0);

    const defaults = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/agenda-settings`
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().data).toMatchObject({
      mode: "hybrid_manual",
      timezone: "America/Bogota",
      externalReferenceRequired: true,
      capacityPolicy: "strict"
    });
    const afterFirstPulsoUse = await client.query<{ count: number }>(
      "select count(*)::int as count from pulso_iris.agenda_settings where tenant_id = $1",
      [tenantA]
    );
    expect(afterFirstPulsoUse.rows[0]?.count).toBe(1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/agenda-settings`,
      headers: { "x-operator-id": "config-test" },
      payload: { bookingHorizonDays: 120, holdDurationMinutes: 15 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data).toMatchObject({ bookingHorizonDays: 120, holdDurationMinutes: 15 });

    const otherTenant = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantB}/pulso-iris/config/agenda-settings`
    });
    expect(otherTenant.json().data.bookingHorizonDays).toBe(90);

    const legacy = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/agenda-settings`,
      payload: { mode: "legacy_integrated", status: "active" }
    });
    expect(legacy.statusCode).toBe(422);
    expect(events.some((event) => event.eventType === "agenda.settings.updated")).toBe(true);
  });

  it("records both settings mutations when the client reuses x-request-id", async () => {
    const requestId = `reused-correlation-${randomUUID()}`;
    const first = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/agenda-settings`,
      headers: { "x-request-id": requestId, "x-operator-id": "config-test" },
      payload: { bookingHorizonDays: 121 }
    });
    const second = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/agenda-settings`,
      headers: { "x-request-id": requestId, "x-operator-id": "config-test" },
      payload: { bookingHorizonDays: 122 }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const persisted = await client.query<{ count: number }>(
      `select count(*)::int as count
         from pulso_iris.outbox_events
        where tenant_id = $1::uuid
          and event_type = $2
          and payload->>'eventType' = 'agenda.settings.updated'
          and payload->>'entityId' = $1::text
          and payload#>>'{metadata,requestId}' = $3`,
      [tenantA, PULSO_AUDIT_EVENT_TYPE, requestId]
    );
    expect(persisted.rows[0]?.count).toBe(2);
  });

  it("creates explicit relations and rejects cross-tenant references", async () => {
    const crossTenant = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/professional-sites`,
      payload: { professionalId: professionalA, siteId: siteB }
    });
    expect(crossTenant.statusCode).toBe(422);

    const professionalSite = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/professional-sites`,
      payload: { professionalId: professionalA, siteId: siteA }
    });
    expect(professionalSite.statusCode).toBe(201);

    const professionalType = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/professional-appointment-types`,
      payload: { professionalId: professionalA, appointmentTypeId: appointmentTypeA }
    });
    expect(professionalType.statusCode).toBe(201);
  });

  it("previews, applies and deduplicates a transactional CSV import", async () => {
    const csv = [
      "site_id,professional_id,appointment_type_id,weekday,starts_at,ends_at,slot_duration_min,capacity,timezone,effective_from,effective_to,status,notes",
      `${siteA},${professionalA},${appointmentTypeA},1,08:00,09:00,20,2,America/Bogota,2026-08-01,2026-12-31,active,Horario controlado`,
      `${siteA},${professionalA},${appointmentTypeA},2,08:00,09:00,5,1,America/Bogota,2026-08-01,2026-12-31,active,Duracion invalida`
    ].join("\n");

    const preview = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/import/availability-rules/preview`,
      payload: { csv }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.summary).toEqual({ total: 2, accepted: 1, rejected: 1 });

    const first = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/import/availability-rules/apply`,
      headers: { "x-operator-id": "config-import-test" },
      payload: { csv, idempotencyKey: "availability-import-001" }
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ applied: 1, idempotent: false });

    const repeated = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/import/availability-rules/apply`,
      payload: { csv, idempotencyKey: "availability-import-001" }
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().data).toMatchObject({ applied: 1, idempotent: true });

    const count = await client.query<{ count: number }>(
      `select count(*)::int as count from pulso_iris.availability_rules
       where tenant_id = $1 and notes = 'Horario controlado'`,
      [tenantA]
    );
    expect(count.rows[0]?.count).toBe(1);
    expect(events.filter((event) => event.eventType === "agenda.configuration.imported")).toHaveLength(1);
  });

  it("applies every supported configuration CSV resource", async () => {
    const professionalCsv = [
      "name,professional_type,subspecialty,status",
      "Profesional importado,optometrist,,active"
    ].join("\n");
    await expectApplied("professionals", professionalCsv, "professionals-import-001");
    const imported = await client.query<{ id: string }>(
      "select id from pulso_iris.professionals where tenant_id = $1 and name = 'Profesional importado'",
      [tenantA]
    );
    const importedProfessionalId = imported.rows[0]!.id;

    await expectApplied(
      "professional-sites",
      ["professional_id,site_id,status", `${importedProfessionalId},${siteA},active`].join("\n"),
      "professional-sites-import-001"
    );
    await expectApplied(
      "professional-appointment-types",
      ["professional_id,appointment_type_id,status", `${importedProfessionalId},${appointmentTypeA},active`].join("\n"),
      "professional-types-import-001"
    );
    await expectApplied(
      "payer-exclusions",
      ["professional_id,payer_id,status", `${importedProfessionalId},${payerA},active`].join("\n"),
      "payer-exclusions-import-001"
    );
    await expectApplied(
      "agenda-blocks",
      [
        "site_id,professional_id,appointment_type_id,starts_at,ends_at,block_type,reason,status",
        `${siteA},${importedProfessionalId},${appointmentTypeA},2027-01-04T13:00:00-05:00,2027-01-08T22:00:00-05:00,vacation,Vacaciones programadas,active`
      ].join("\n"),
      "agenda-blocks-import-001"
    );

    const persisted = await client.query<{ exclusions: number; blocks: number }>(
      `select
         (select count(*)::int from pulso_iris.professional_payer_exclusions
          where tenant_id = $1 and professional_id = $2) as exclusions,
         (select count(*)::int from pulso_iris.agenda_blocks
          where tenant_id = $1 and professional_id = $2 and block_type = 'vacation') as blocks`,
      [tenantA, importedProfessionalId]
    );
    expect(persisted.rows[0]).toEqual({ exclusions: 1, blocks: 1 });
  });

  it("rolls back a configuration mutation when its audit enqueue fails in the shared transaction", async () => {
    failingAuditSiteName = `Sede rollback ${randomUUID()}`;
    failingAuditObservedUncommittedMutation = false;

    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/pulso-iris/config/sites`,
        payload: { name: failingAuditSiteName }
      });
      expect(response.statusCode).toBe(500);
      expect(failingAuditObservedUncommittedMutation).toBe(true);

      const persisted = await client.query<{ count: number }>(
        "select count(*)::int as count from pulso_iris.sites where tenant_id = $1 and name = $2",
        [tenantA, failingAuditSiteName]
      );
      expect(persisted.rows[0]?.count).toBe(0);
    } finally {
      failingAuditSiteName = undefined;
    }
  });

  it("rolls back an imported configuration and its idempotency record when audit enqueue fails", async () => {
    failingAuditImportProfessionalName = `Profesional rollback ${randomUUID()}`;
    failingAuditObservedUncommittedImport = false;
    const idempotencyKey = `professionals-rollback-${randomUUID()}`;
    const csv = [
      "name,professional_type,subspecialty,status",
      `${failingAuditImportProfessionalName},optometrist,,active`
    ].join("\n");

    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/pulso-iris/config/import/professionals/apply`,
        payload: { csv, idempotencyKey }
      });
      expect(response.statusCode).toBe(500);
      expect(failingAuditObservedUncommittedImport).toBe(true);

      const persisted = await client.query<{ imports: number; professionals: number }>(
        `select
           (select count(*)::int from pulso_iris.configuration_imports
            where tenant_id = $1 and idempotency_key = $2) as imports,
           (select count(*)::int from pulso_iris.professionals
            where tenant_id = $1 and name = $3) as professionals`,
        [tenantA, idempotencyKey, failingAuditImportProfessionalName]
      );
      expect(persisted.rows[0]).toEqual({ imports: 0, professionals: 0 });
    } finally {
      failingAuditImportProfessionalName = undefined;
    }
  });

  it("exports configuration as CSV without synthetic rows", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantA}/pulso-iris/config/export/professional-sites`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.filename).toBe("pulso-iris-professional-sites.csv");
    expect(response.json().data.csv).toContain(`${professionalA},${siteA},active`);
  });
});

async function createTenant(prefix: string): Promise<string> {
  const slug = `${prefix}-${randomUUID()}`;
  const result = await fixtureClient.query<{ id: string }>(
    `insert into platform.tenants (slug, display_name, status)
     values ($1, $2, 'active') returning id`,
    [slug, slug]
  );
  return result.rows[0]!.id;
}

async function createCatalog(
  tenantId: string,
  suffix: string
): Promise<{ siteId: string; professionalId: string; appointmentTypeId: string; payerId: string }> {
  const site = await client.query<{ id: string }>(
    "insert into pulso_iris.sites (tenant_id, name) values ($1, $2) returning id",
    [tenantId, `Sede ${suffix}`]
  );
  const professional = await client.query<{ id: string }>(
    `insert into pulso_iris.professionals (tenant_id, name, professional_type)
     values ($1, $2, 'optometrist') returning id`,
    [tenantId, `Profesional ${suffix}`]
  );
  const appointmentType = await client.query<{ id: string }>(
    `insert into pulso_iris.appointment_types (tenant_id, name, category, duration_min)
     values ($1, $2, 'consulta', 20) returning id`,
    [tenantId, `Consulta ${suffix}`]
  );
  const payer = await client.query<{ id: string }>(
    `insert into pulso_iris.payers (tenant_id, name, payer_group)
     values ($1, $2, 'particular') returning id`,
    [tenantId, `Convenio ${suffix}`]
  );
  return {
    siteId: site.rows[0]!.id,
    professionalId: professional.rows[0]!.id,
    appointmentTypeId: appointmentType.rows[0]!.id,
    payerId: payer.rows[0]!.id
  };
}

async function expectApplied(resource: string, csv: string, idempotencyKey: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/tenants/${tenantA}/pulso-iris/config/import/${resource}/apply`,
    payload: { csv, idempotencyKey }
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().data).toMatchObject({ applied: 1, idempotent: false });
}
