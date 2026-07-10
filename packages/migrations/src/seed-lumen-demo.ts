import { createLogger } from "@hyperion/logger";
import pg from "pg";

const { Client } = pg;
const logger = createLogger("lumen-demo-seed");
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  logger.error("DATABASE_URL is required");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
const clearOnly = process.argv.includes("--clear");
let transactionOpen = false;

try {
  await client.connect();
  await client.query("begin");
  transactionOpen = true;
  const tenant = await client.query<{ id: string }>(`select id from platform.tenants where slug = 'cedco'`);
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error("CEDCO tenant not found");
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${tenantId}|lumen-demo-001`]);

  if (clearOnly) {
    await clearLumenDemo(tenantId);
    await client.query("commit");
    transactionOpen = false;
    logger.info("LUMEN demo data cleared");
  } else {
    await seedLumenDemo(tenantId);
    await client.query("commit");
    transactionOpen = false;
    logger.info("LUMEN demo data ready", { seedKey: "lumen-demo-001" });
  }
} catch (error) {
  if (transactionOpen) {
    await client.query("rollback").catch(() => undefined);
  }
  logger.error("LUMEN demo seed failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await client.end();
}

async function clearLumenDemo(tenantId: string): Promise<void> {
  await client.query(
    `delete from lumen.encounters
     where tenant_id = $1 and demo_key = 'lumen-demo-001' and is_demo
       and coalesce(metadata->>'synthetic', 'false') = 'true'`,
    [tenantId]
  );
  await client.query(
    `delete from pulso_iris.administrative_patients
     where tenant_id = $1 and metadata->>'lumenDemoKey' = 'lumen-demo-patient-001'
       and coalesce(metadata->>'is_demo', 'false') = 'true'`,
    [tenantId]
  );
  await client.query(
    `delete from pulso_iris.professionals
     where tenant_id = $1 and metadata->>'lumenDemoKey' = 'lumen-demo-professional-001'
       and coalesce(metadata->>'is_demo', 'false') = 'true'`,
    [tenantId]
  );
}

async function seedLumenDemo(tenantId: string): Promise<void> {
  const site = await client.query<{ id: string; name: string }>(
    `select id, name from pulso_iris.sites where tenant_id = $1 and status = 'active' order by created_at limit 1`,
    [tenantId]
  );
  if (!site.rows[0]) throw new Error("CEDCO requires at least one active site before seeding LUMEN demo");

  let professional = await client.query<{ id: string }>(
    `select id from pulso_iris.professionals
     where tenant_id = $1 and metadata->>'lumenDemoKey' = 'lumen-demo-professional-001'
       and coalesce(metadata->>'is_demo', 'false') = 'true'`,
    [tenantId]
  );
  if (!professional.rows[0]) {
    professional = await client.query<{ id: string }>(
      `insert into pulso_iris.professionals
         (tenant_id, name, professional_type, subspecialty, metadata)
       values ($1, 'Dra. Laura Rueda Demo', 'ophthalmologist', 'Glaucoma',
               '{"is_demo":true,"lumenDemoKey":"lumen-demo-professional-001"}'::jsonb)
       returning id`,
      [tenantId]
    );
  }
  let patient = await client.query<{ id: string }>(
    `select id from pulso_iris.administrative_patients
     where tenant_id = $1 and metadata->>'lumenDemoKey' = 'lumen-demo-patient-001'
       and coalesce(metadata->>'is_demo', 'false') = 'true'`,
    [tenantId]
  );
  if (!patient.rows[0]) {
    patient = await client.query<{ id: string }>(
      `insert into pulso_iris.administrative_patients
         (tenant_id, full_name, status, metadata)
       values ($1, 'María Fernanda Demo', 'active',
               '{"is_demo":true,"demoAge":54,"lumenDemoKey":"lumen-demo-patient-001"}'::jsonb)
       returning id`,
      [tenantId]
    );
  }
  const encounter = await client.query<{ id: string }>(
    `with inserted as (
       insert into lumen.encounters
         (tenant_id, patient_id, professional_id, site_id, status, scheduled_at, is_demo, demo_key,
          metadata)
       values (
         $1, $2, $3, $4, 'preconsultation',
         ((date_trunc('day', now() at time zone 'America/Bogota') + interval '10 hours') at time zone 'America/Bogota'),
         true, 'lumen-demo-001', '{"synthetic":true}'::jsonb
       )
       on conflict (tenant_id, demo_key) where demo_key is not null do nothing
       returning id
     )
     select id from inserted
     union all
     select id from lumen.encounters where tenant_id = $1 and demo_key = 'lumen-demo-001'
     limit 1`,
    [tenantId, patient.rows[0]!.id, professional.rows[0]!.id, site.rows[0].id]
  );

  const summary = {
    summaryText:
      "Paciente sintética de 54 años en control de glaucoma. PIO estable en los últimos tres controles. Última OCT sin progresión documentada. Pendiente campimetría de control.",
    activeDiagnoses: ["Glaucoma primario de ángulo abierto AO", "Membrana epirretiniana OI"],
    medications: ["Latanoprost 0,005 % AO en la noche"],
    alerts: [
      "Campimetría de control vencida hace dos semanas.",
      "Verificar antecedente respiratorio antes de considerar un beta-bloqueador."
    ],
    trends: [
      {
        label: "PIO ojo izquierdo",
        unit: "mmHg",
        points: [
          { recordedAt: "2025-08-10", value: 19 },
          { recordedAt: "2026-03-12", value: 17 },
          { recordedAt: "2026-06-08", value: 16 }
        ]
      }
    ]
  };
  await client.query(
    `insert into lumen.preconsultation_summaries (tenant_id, encounter_id, content, source_count)
     values ($1, $2, $3::jsonb, 8)
     on conflict (tenant_id, encounter_id) do nothing`,
    [tenantId, encounter.rows[0]!.id, JSON.stringify(summary)]
  );
}
