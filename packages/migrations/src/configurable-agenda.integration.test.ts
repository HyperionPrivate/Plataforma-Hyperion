import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("011 configurable agenda migration", () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  let tenantA = "";
  let tenantB = "";
  let siteA = "";
  let siteB = "";
  let professionalA = "";
  let appointmentTypeA = "";
  let settingsBeforePulsoInitialization = -1;
  let savepoint = 0;

  beforeAll(async () => {
    await client.connect();
    await client.query("begin");

    const tenants = await client.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'Agenda migration tenant A'), ($2, 'Agenda migration tenant B')
       returning id`,
      [`agenda-migration-a-${Date.now()}`, `agenda-migration-b-${Date.now()}`]
    );
    tenantA = tenants.rows[0]!.id;
    tenantB = tenants.rows[1]!.id;

    settingsBeforePulsoInitialization = (
      await client.query<{ count: number }>(
        `select count(*)::int as count
           from pulso_iris.agenda_settings
          where tenant_id = any($1::uuid[])`,
        [[tenantA, tenantB]]
      )
    ).rows[0]!.count;
    await client.query(
      `insert into pulso_iris.agenda_settings (tenant_id, mode, external_reference_required)
       values ($1, 'hybrid_manual', true), ($2, 'hybrid_manual', true)
       on conflict (tenant_id) do nothing`,
      [tenantA, tenantB]
    );

    const sites = await client.query<{ id: string; tenantId: string }>(
      `insert into pulso_iris.sites (tenant_id, name)
       values ($1, 'Controlled site A'), ($2, 'Controlled site B')
       returning id, tenant_id as "tenantId"`,
      [tenantA, tenantB]
    );
    siteA = sites.rows.find((row) => row.tenantId === tenantA)!.id;
    siteB = sites.rows.find((row) => row.tenantId === tenantB)!.id;

    professionalA = (
      await client.query<{ id: string }>(
        `insert into pulso_iris.professionals (tenant_id, name, professional_type)
         values ($1, 'Controlled professional', 'optometrist') returning id`,
        [tenantA]
      )
    ).rows[0]!.id;

    appointmentTypeA = (
      await client.query<{ id: string }>(
        `insert into pulso_iris.appointment_types
           (tenant_id, name, category, duration_min, bookable_by_ia)
         values ($1, 'Controlled appointment type', 'consulta', 20, true) returning id`,
        [tenantA]
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await client.query("rollback");
    await client.end();
  });

  async function expectDatabaseError(action: () => Promise<unknown>, code: string) {
    const name = `expected_error_${++savepoint}`;
    await client.query(`savepoint ${name}`);
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }
    await client.query(`rollback to savepoint ${name}`);
    await client.query(`release savepoint ${name}`);
    expect(caught).toMatchObject({ code });
  }

  it("leaves Access tenant writes decoupled and accepts PULSO-owned idempotent defaults", async () => {
    const result = await client.query<{ mode: string; referenceRequired: boolean }>(
      `select mode, external_reference_required as "referenceRequired"
       from pulso_iris.agenda_settings where tenant_id = $1`,
      [tenantA]
    );

    expect(settingsBeforePulsoInitialization).toBe(0);
    expect(result.rows[0]).toEqual({ mode: "hybrid_manual", referenceRequired: true });
  });

  it("enforces tenant-aware professional relationships", async () => {
    await expectDatabaseError(
      () =>
        client.query(
          `insert into pulso_iris.professional_sites (tenant_id, professional_id, site_id)
           values ($1, $2, $3)`,
          [tenantA, professionalA, siteB]
        ),
      "23503"
    );

    await client.query(
      `insert into pulso_iris.professional_sites (tenant_id, professional_id, site_id)
       values ($1, $2, $3)`,
      [tenantA, professionalA, siteA]
    );
    await client.query(
      `insert into pulso_iris.professional_appointment_types
         (tenant_id, professional_id, appointment_type_id)
       values ($1, $2, $3)`,
      [tenantA, professionalA, appointmentTypeA]
    );
  });

  it("rejects short and overlapping availability rules", async () => {
    await expectDatabaseError(
      () =>
        client.query(
          `insert into pulso_iris.availability_rules
             (tenant_id, site_id, professional_id, appointment_type_id, weekday,
              starts_at, ends_at, slot_duration_min, capacity)
           values ($1, $2, $3, $4, 1, '08:00', '10:00', 10, 1)`,
          [tenantA, siteA, professionalA, appointmentTypeA]
        ),
      "23514"
    );

    await client.query(
      `insert into pulso_iris.availability_rules
         (tenant_id, site_id, professional_id, appointment_type_id, weekday,
          starts_at, ends_at, slot_duration_min, capacity)
       values ($1, $2, $3, $4, 1, '08:00', '10:00', 20, 1)`,
      [tenantA, siteA, professionalA, appointmentTypeA]
    );

    await expectDatabaseError(
      () =>
        client.query(
          `insert into pulso_iris.availability_rules
             (tenant_id, site_id, professional_id, appointment_type_id, weekday,
              starts_at, ends_at, slot_duration_min, capacity)
           values ($1, $2, $3, $4, 1, '09:00', '11:00', 20, 1)`,
          [tenantA, siteA, professionalA, appointmentTypeA]
        ),
      "23P01"
    );
  });

  it("serializes capacity across holds and appointments", async () => {
    const scheduledAt = "2026-12-07T13:00:00.000Z";
    const hold = await client.query<{ id: string }>(
      `insert into pulso_iris.appointment_holds
         (tenant_id, site_id, professional_id, appointment_type_id, scheduled_at,
          duration_min, slot_capacity_token, expires_at, idempotency_key)
       values ($1, $2, $3, $4, $5, 20, 1, now() + interval '10 minutes', 'hold-capacity-1')
       returning id`,
      [tenantA, siteA, professionalA, appointmentTypeA, scheduledAt]
    );

    await expectDatabaseError(
      () =>
        client.query(
          `insert into pulso_iris.appointments
             (tenant_id, site_id, professional_id, appointment_type_id, scheduled_at,
              slot_capacity_token, status)
           values ($1, $2, $3, $4, $5, 1, 'pending_external_confirmation')`,
          [tenantA, siteA, professionalA, appointmentTypeA, scheduledAt]
        ),
      "23505"
    );

    const appointment = await client.query<{ id: string }>(
      `insert into pulso_iris.appointments
         (tenant_id, site_id, professional_id, appointment_type_id, scheduled_at,
          duration_min, slot_capacity_token, status, hold_id, idempotency_key)
       values ($1, $2, $3, $4, $5, 20, 1, 'pending_external_confirmation', $6, 'appointment-capacity-1')
       returning id`,
      [tenantA, siteA, professionalA, appointmentTypeA, scheduledAt, hold.rows[0]!.id]
    );

    await client.query(
      `update pulso_iris.appointment_holds
       set status = 'consumed', appointment_id = $3, consumed_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantA, hold.rows[0]!.id, appointment.rows[0]!.id]
    );

    await expectDatabaseError(
      () =>
        client.query(
          `update pulso_iris.appointments
           set status = 'verified', verification_mode = 'manual_external',
               external_system = 'Controlled external system', verified_at = now(), verified_by = 'operator'
           where tenant_id = $1 and id = $2`,
          [tenantA, appointment.rows[0]!.id]
        ),
      "23514"
    );

    await client.query(
      `update pulso_iris.appointments
       set status = 'verified', verification_mode = 'manual_external',
           external_system = 'Controlled external system', external_reference = 'CONTROLLED-REF-1',
           verified_at = now(), verified_by = 'operator'
       where tenant_id = $1 and id = $2`,
      [tenantA, appointment.rows[0]!.id]
    );

    const history = await client.query<{ status: string }>(
      `select to_status as status from pulso_iris.appointment_status_history
       where tenant_id = $1 and appointment_id = $2 order by created_at`,
      [tenantA, appointment.rows[0]!.id]
    );
    expect(history.rows.map((row) => row.status)).toEqual(["pending_external_confirmation", "verified"]);
  });
});
