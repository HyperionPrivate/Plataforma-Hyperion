import { createLogger } from "@hyperion/logger";
import pg from "pg";
import { requireDemoTenantId } from "./demo-tenant-context.js";

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
  const requestedTenantId = requireDemoTenantId(process.env, "LUMEN_DEMO_TENANT_ID");
  await client.connect();
  await client.query("begin");
  transactionOpen = true;
  const tenant = await client.query<{ id: string }>("select id from platform.tenants where id = $1::uuid", [
    requestedTenantId
  ]);
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error(`LUMEN demo tenant ${requestedTenantId} not found; provision it through Access first`);
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
  const encounter = await client.query<{ id: string }>(
    `select id from lumen.encounters
     where tenant_id = $1 and demo_key = 'lumen-demo-001' and is_demo
       and coalesce(metadata->>'synthetic', 'false') = 'true'`,
    [tenantId]
  );
  await client.query(
    `delete from lumen.encounters
     where tenant_id = $1 and demo_key = 'lumen-demo-001' and is_demo
       and coalesce(metadata->>'synthetic', 'false') = 'true'`,
    [tenantId]
  );
  if (encounter.rows[0]) {
    await client.query(
      `delete from lumen.encounter_reference_snapshots
       where tenant_id = $1 and encounter_id = $2`,
      [tenantId, encounter.rows[0].id]
    );
  }
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
  const approved = await client.query<{ encounterStatus: string; recordStatus: string | null }>(
    `select encounter.status as "encounterStatus", record.status as "recordStatus"
     from lumen.encounters encounter
     left join lumen.clinical_records record
       on record.tenant_id = encounter.tenant_id and record.encounter_id = encounter.id
     where encounter.tenant_id = $1 and encounter.demo_key = 'lumen-demo-001'
     for update of encounter`,
    [tenantId]
  );
  if (approved.rows[0]?.encounterStatus === "approved" || approved.rows[0]?.recordStatus === "approved") {
    logger.info("approved LUMEN demo preserved", { seedKey: "lumen-demo-001" });
    return;
  }

  const site = await client.query<{ id: string }>(
    `select id from pulso_iris.sites
     where tenant_id = $1 and status = 'active'
     order by created_at
     limit 1`,
    [tenantId]
  );
  if (!site.rows[0]) throw new Error("The selected tenant requires an active site before seeding the LUMEN demo");

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
       values ($1, 'Dra. Adriana Camacho · Demo', 'ophthalmologist', 'Glaucoma',
               '{"is_demo":true,"lumenDemoKey":"lumen-demo-professional-001","subspecialty":"Glaucoma","registrationMasked":"RM 76-5412"}'::jsonb)
       returning id`,
      [tenantId]
    );
  } else {
    await client.query(
      `update pulso_iris.professionals
       set name = 'Dra. Adriana Camacho · Demo', professional_type = 'ophthalmologist',
           subspecialty = 'Glaucoma', status = 'active',
           metadata = metadata ||
             '{"is_demo":true,"lumenDemoKey":"lumen-demo-professional-001","subspecialty":"Glaucoma","registrationMasked":"RM 76-5412"}'::jsonb,
           updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, professional.rows[0].id]
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
         (tenant_id, full_name, status, document_type, document_number_masked, metadata)
       values ($1, 'María Eugenia Duarte · Demo', 'active', 'CC', 'CC •••7 342',
               '{"is_demo":true,"demoAge":64,"lumenDemoKey":"lumen-demo-patient-001","documentMasked":"CC •••7 342","payer":"Sanitas","payerType":"EPS"}'::jsonb)
       returning id`,
      [tenantId]
    );
  } else {
    await client.query(
      `update pulso_iris.administrative_patients
       set full_name = 'María Eugenia Duarte · Demo', status = 'active', document_type = 'CC',
           document_number_masked = 'CC •••7 342',
           metadata = metadata ||
             '{"is_demo":true,"demoAge":64,"lumenDemoKey":"lumen-demo-patient-001","documentMasked":"CC •••7 342","payer":"Sanitas","payerType":"EPS"}'::jsonb,
           updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, patient.rows[0].id]
    );
  }

  await client.query(
    `insert into lumen.tenant_snapshots (
       tenant_id, status, is_demo, is_active, source_version, source_updated_at, payload_hash
     )
     select tenant.id,
            tenant.status,
            true,
            tenant.status = 'active',
            greatest(1, floor(extract(epoch from tenant.updated_at) * 1000)::bigint),
            tenant.updated_at,
            encode(digest(concat_ws('|', tenant.id::text, tenant.status, 'true'), 'sha256'), 'hex')
     from platform.tenants tenant
     where tenant.id = $1
     on conflict (tenant_id) do update set
       status = excluded.status,
       is_demo = true,
       is_active = excluded.is_active,
       source_version = greatest(lumen.tenant_snapshots.source_version, excluded.source_version),
       source_updated_at = greatest(lumen.tenant_snapshots.source_updated_at, excluded.source_updated_at),
       payload_hash = excluded.payload_hash,
       updated_at = now()`,
    [tenantId]
  );

  const encounterIdentity = await client.query<{ id: string }>(
    `select id from lumen.encounters
     where tenant_id = $1 and demo_key = 'lumen-demo-001'
     union all
     select gen_random_uuid() where not exists (
       select 1 from lumen.encounters where tenant_id = $1 and demo_key = 'lumen-demo-001'
     )
     limit 1`,
    [tenantId]
  );
  const encounterId = encounterIdentity.rows[0]?.id;
  if (!encounterId) throw new Error("could not reserve the LUMEN demo encounter id");

  await client.query(
    `insert into lumen.encounter_reference_snapshots (
       tenant_id, encounter_id, patient_id, site_id, professional_id,
       patient_display_name, patient_age, payer, document_masked,
       professional_name, subspecialty, site_name,
       patient_is_demo, professional_is_demo,
       source_version, source_updated_at, payload_hash
     )
     select $1::uuid,
            $2::uuid,
            patient.id,
            site.id,
            professional.id,
            patient.full_name,
            64,
            'Sanitas',
            patient.document_number_masked,
            professional.name,
            professional.subspecialty,
            site.name,
            true,
            true,
            greatest(
              1,
              floor(extract(epoch from greatest(patient.updated_at, professional.updated_at, site.updated_at)) * 1000)::bigint
            ),
            greatest(patient.updated_at, professional.updated_at, site.updated_at),
            encode(
              digest(
                concat_ws('|', $1::text, $2::text, patient.id::text, site.id::text,
                  professional.id::text, patient.full_name, patient.document_number_masked,
                  professional.name, professional.subspecialty, site.name, 'true', 'true'),
                'sha256'
              ),
              'hex'
            )
     from pulso_iris.administrative_patients patient
     join pulso_iris.professionals professional
       on professional.tenant_id = patient.tenant_id and professional.id = $4::uuid
     join pulso_iris.sites site
       on site.tenant_id = patient.tenant_id and site.id = $5::uuid
     where patient.tenant_id = $1::uuid and patient.id = $3::uuid
     on conflict (tenant_id, encounter_id) do update set
       patient_id = excluded.patient_id,
       site_id = excluded.site_id,
       professional_id = excluded.professional_id,
       patient_display_name = excluded.patient_display_name,
       patient_age = excluded.patient_age,
       payer = excluded.payer,
       document_masked = excluded.document_masked,
       professional_name = excluded.professional_name,
       subspecialty = excluded.subspecialty,
       site_name = excluded.site_name,
       patient_is_demo = true,
       professional_is_demo = true,
       source_version = greatest(lumen.encounter_reference_snapshots.source_version, excluded.source_version),
       source_updated_at = greatest(lumen.encounter_reference_snapshots.source_updated_at, excluded.source_updated_at),
       payload_hash = excluded.payload_hash,
       updated_at = now()
     where lumen.encounter_reference_snapshots.frozen_at is null`,
    [tenantId, encounterId, patient.rows[0]!.id, professional.rows[0]!.id, site.rows[0].id]
  );

  const encounter = await client.query<{ id: string }>(
    `with inserted as (
       insert into lumen.encounters
         (id, tenant_id, patient_id, professional_id, site_id, status, scheduled_at, is_demo, demo_key,
          metadata)
       values (
         $2, $1, $3, $4, $5, 'in_progress', '2026-09-15T15:00:00Z',
         true, 'lumen-demo-001',
         '{"synthetic":true,"visitReason":"Control de glaucoma; refiere visión borrosa ocasional OI.","appointmentSource":"SOFIA · PULSO IRIS","siteDisplayName":"Principal Sotomayor"}'::jsonb
       )
       on conflict (tenant_id, demo_key) where demo_key is not null do update set
         patient_id = excluded.patient_id,
         professional_id = excluded.professional_id,
         site_id = excluded.site_id,
         status = 'in_progress',
         scheduled_at = excluded.scheduled_at,
         metadata = excluded.metadata,
         updated_at = now()
       where lumen.encounters.status <> 'approved'
       returning id
     )
     select id from inserted
     union all
     select id from lumen.encounters where tenant_id = $1 and demo_key = 'lumen-demo-001'
     limit 1`,
    [tenantId, encounterId, patient.rows[0]!.id, professional.rows[0]!.id, site.rows[0].id]
  );

  if (!encounter.rows[0]) throw new Error("approved LUMEN encounter cannot be reseeded");

  const sources = [
    {
      id: "encounter-2025-10-14",
      type: "encounter",
      label: "Control de glaucoma · 14 oct 2025",
      recordedAt: "2025-10-14T15:00:00.000Z",
      detail: "PIO OD 17 mmHg / OI 19 mmHg."
    },
    {
      id: "procedure-2025-02-slt-oi",
      type: "procedure",
      label: "Trabeculoplastia láser selectiva OI",
      recordedAt: "2025-02-18T14:00:00.000Z",
      detail: "SLT OI registrada en expediente sintético."
    },
    {
      id: "encounter-2026-03-12",
      type: "encounter",
      label: "Control de glaucoma · 12 mar 2026",
      recordedAt: "2026-03-12T15:00:00.000Z",
      detail: "PIO OD 16 mmHg / OI 21 mmHg."
    },
    {
      id: "exam-oct-2026-09-10",
      type: "diagnostic_exam",
      label: "OCT RNFL · 10 sep 2026",
      recordedAt: "2026-09-10T13:30:00.000Z",
      detail: "RNFL promedio OD 84 µm / OI 71 µm; resultado pendiente de revisión."
    },
    {
      id: "exam-field-2026-09-10",
      type: "diagnostic_exam",
      label: "Campo visual 24-2 OI · 10 sep 2026",
      recordedAt: "2026-09-10T14:00:00.000Z",
      detail: "MD −6,8 dB; PSD 5,2 dB; escalón nasal superior."
    },
    {
      id: "medication-latanoprost",
      type: "medication",
      label: "Fórmula vigente de latanoprost",
      recordedAt: "2026-03-12T15:20:00.000Z",
      detail: "Latanoprost 0,005 %: una gota en la noche AO."
    },
    {
      id: "appointment-sofia-2026-09-15",
      type: "appointment",
      label: "Motivo declarado al agendar con SOFÍA",
      recordedAt: "2026-09-08T16:00:00.000Z",
      detail: "La paciente refiere visión borrosa ocasional OI."
    }
  ];
  const summary = {
    summaryText:
      "Paciente sintética de 64 años en control de glaucoma primario de ángulo abierto AO. La última PIO registrada del ojo izquierdo aumentó de 19 a 21 mmHg y supera la meta de 18 mmHg. OCT RNFL y campo visual recientes están disponibles con trazabilidad al expediente demo.",
    activeDiagnoses: ["H40.11 · Glaucoma primario de ángulo abierto AO"],
    medications: ["Latanoprost 0,005 % · una gota en la noche AO"],
    alerts: [
      "PIO OI 21 mmHg en la última consulta registrada; meta 18 mmHg.",
      "OCT RNFL ordenado hace cuatro meses: resultado recibido y pendiente de revisión."
    ],
    alertSourceIds: ["encounter-2026-03-12", "exam-oct-2026-09-10"],
    trends: [
      {
        label: "PIO OD",
        unit: "mmHg",
        points: [
          { recordedAt: "2025-10-14", value: 17 },
          { recordedAt: "2026-03-12", value: 16 }
        ],
        targetMin: 12,
        targetMax: 18
      },
      {
        label: "PIO OI",
        unit: "mmHg",
        points: [
          { recordedAt: "2025-10-14", value: 19 },
          { recordedAt: "2026-03-12", value: 21 }
        ],
        targetMin: 12,
        targetMax: 18
      }
    ],
    sources,
    recentExams: [
      {
        id: "recent-oct-rnfl",
        name: "OCT RNFL",
        recordedAt: "2026-09-10T13:30:00.000Z",
        detail: "Promedio OD 84 µm / OI 71 µm.",
        status: "pending_review",
        sourceId: "exam-oct-2026-09-10"
      },
      {
        id: "recent-field-24-2-oi",
        name: "Campo visual 24-2 OI",
        recordedAt: "2026-09-10T14:00:00.000Z",
        detail: "MD −6,8 dB · PSD 5,2 dB · escalón nasal superior.",
        status: "available",
        sourceId: "exam-field-2026-09-10"
      }
    ],
    timeline: [
      {
        id: "timeline-slt-oi",
        recordedAt: "2025-02-18T14:00:00.000Z",
        kind: "procedure",
        title: "SLT OI",
        detail: "Trabeculoplastia láser selectiva del ojo izquierdo.",
        sourceId: "procedure-2025-02-slt-oi"
      },
      {
        id: "timeline-control-2025-10",
        recordedAt: "2025-10-14T15:00:00.000Z",
        kind: "encounter",
        title: "Control: PIO OI 19 mmHg",
        sourceId: "encounter-2025-10-14"
      },
      {
        id: "timeline-control-2026-03",
        recordedAt: "2026-03-12T15:00:00.000Z",
        kind: "encounter",
        title: "Control: PIO OI 21 mmHg",
        sourceId: "encounter-2026-03-12"
      },
      {
        id: "timeline-exams-2026-09",
        recordedAt: "2026-09-10T13:30:00.000Z",
        kind: "diagnostic_exam",
        title: "OCT RNFL y campo visual disponibles",
        detail: "OCT pendiente de revisión profesional.",
        sourceId: "exam-oct-2026-09-10"
      }
    ]
  };
  await client.query(
    `insert into lumen.preconsultation_summaries (tenant_id, encounter_id, content, source_count)
     values ($1, $2, $3::jsonb, 7)
     on conflict (tenant_id, encounter_id) do update set
       content = excluded.content,
       source_count = excluded.source_count,
       generated_at = '2026-09-15T10:47:00Z',
       updated_at = now()
     where exists (
       select 1 from lumen.encounters current_encounter
       where current_encounter.tenant_id = excluded.tenant_id
         and current_encounter.id = excluded.encounter_id
         and current_encounter.status <> 'approved'
     )`,
    [tenantId, encounter.rows[0]!.id, JSON.stringify(summary)]
  );

  const transcript = [
    "Motivo de consulta: control de glaucoma; visión borrosa ocasional en ojo izquierdo.",
    "Evolución: paciente sintética de 64 años con glaucoma primario de ángulo abierto en ambos ojos, en tratamiento registrado con latanoprost 0,005 % una gota en la noche en ambos ojos.",
    "Agudeza visual con corrección: ojo derecho veinte treinta y ojo izquierdo veinte cuarenta.",
    "Presión intraocular con Goldmann a las diez y quince: ojo derecho dieciséis y ojo izquierdo veinticuatro milímetros de mercurio, sobre meta de dieciocho.",
    "Biomicroscopía: córnea clara y cámara anterior amplia en ojo derecho; córnea clara y cámara anterior amplia en ojo izquierdo.",
    "Gonioscopía: ángulo abierto grado tres en ojo derecho; ángulo abierto grado... en ojo izquierdo.",
    "Fondo de ojo: excavación cero punto seis en ojo derecho y excavación cero punto ocho en ojo izquierdo.",
    "Impresión clínica: glaucoma primario de ángulo abierto en ambos ojos.",
    "Plan: continuar latanoprost 0,005 % una gota en la noche en ambos ojos; adicionar timolol 0,5 % cada 12 horas en ojo izquierdo; control con curva de presión intraocular en seis semanas; OCT RNFL de control en cuatro meses."
  ].join(" ");
  let dictation = await client.query<{ id: string }>(
    `select id from lumen.dictations
     where tenant_id = $1 and encounter_id = $2
       and metadata->>'lumenDemoKey' = 'lumen-demo-dictation-001'
     for update`,
    [tenantId, encounter.rows[0]!.id]
  );
  if (!dictation.rows[0]) {
    dictation = await client.query<{ id: string }>(
      `insert into lumen.dictations
         (tenant_id, encounter_id, status, transcript, mime_type, provider, model, duration_seconds, metadata)
       values ($1, $2, 'transcribed', $3, 'text/plain', null, null, 72,
               '{"audioStored":false,"source":"synthetic_demo","synthetic":true,"lumenDemoKey":"lumen-demo-dictation-001"}'::jsonb)
       returning id`,
      [tenantId, encounter.rows[0]!.id, transcript]
    );
  } else {
    await client.query(
      `update lumen.dictations
       set status = 'transcribed', transcript = $3, mime_type = 'text/plain', provider = null, model = null,
           duration_seconds = 72,
           metadata = '{"audioStored":false,"source":"synthetic_demo","synthetic":true,"lumenDemoKey":"lumen-demo-dictation-001"}'::jsonb
       where tenant_id = $1 and id = $2`,
      [tenantId, dictation.rows[0].id, transcript]
    );
  }

  const content = {
    reasonForVisit: "Control de glaucoma; visión borrosa ocasional en ojo izquierdo.",
    history:
      "Paciente sintética de 64 años con glaucoma primario de ángulo abierto AO, en tratamiento registrado con latanoprost 0,005 % una gota en la noche AO.",
    visualAcuity: { right: "20/30 cc", left: "20/40 cc" },
    intraocularPressure: { right: "16 mmHg", left: "24 mmHg · meta 18 mmHg" },
    biomicroscopy: {
      right: "Córnea clara; cámara anterior amplia",
      left: "Córnea clara; cámara anterior amplia"
    },
    fundus: { right: "Excavación C/D 0.6", left: "Excavación C/D 0.8" },
    gonioscopy: { right: "Ángulo abierto grado III", left: "Ángulo abierto; grado por confirmar" },
    assessment: [
      {
        description: "Glaucoma primario de ángulo abierto AO",
        code: "H40.11",
        confidence: 0.96
      }
    ],
    plan: [
      "Continuar latanoprost 0,005 % una gota en la noche AO.",
      "Adicionar timolol 0,5 % cada 12 horas OI.",
      "Control con curva de PIO en seis semanas.",
      "OCT RNFL de control en cuatro meses."
    ],
    uncertainties: [
      {
        field: "gonioscopy.left",
        message: "Confirmar el grado de gonioscopía antes de aprobar la historia clínica.",
        sourceText: "ángulo abierto grado... en ojo izquierdo"
      }
    ],
    fieldEvidence: [
      {
        field: "reasonForVisit",
        confidence: 0.99,
        origin: "synthetic_demo",
        sourceText: "control de glaucoma; visión borrosa ocasional en ojo izquierdo"
      },
      {
        field: "history",
        confidence: 0.98,
        origin: "synthetic_demo",
        sourceText:
          "paciente sintética de 64 años con glaucoma primario de ángulo abierto en ambos ojos, en tratamiento registrado con latanoprost 0,005 % una gota en la noche en ambos ojos"
      },
      {
        field: "visualAcuity.right",
        confidence: 0.98,
        origin: "synthetic_demo",
        sourceText: "ojo derecho veinte treinta"
      },
      {
        field: "visualAcuity.left",
        confidence: 0.98,
        origin: "synthetic_demo",
        sourceText: "ojo izquierdo veinte cuarenta"
      },
      {
        field: "intraocularPressure.right",
        confidence: 0.98,
        origin: "synthetic_demo",
        sourceText: "ojo derecho dieciséis"
      },
      {
        field: "intraocularPressure.left",
        confidence: 0.98,
        origin: "synthetic_demo",
        sourceText: "ojo izquierdo veinticuatro milímetros de mercurio"
      },
      {
        field: "biomicroscopy.right",
        confidence: 0.97,
        origin: "synthetic_demo",
        sourceText: "córnea clara y cámara anterior amplia en ojo derecho"
      },
      {
        field: "biomicroscopy.left",
        confidence: 0.97,
        origin: "synthetic_demo",
        sourceText: "córnea clara y cámara anterior amplia en ojo izquierdo"
      },
      {
        field: "gonioscopy.right",
        confidence: 0.96,
        origin: "synthetic_demo",
        sourceText: "ángulo abierto grado tres en ojo derecho"
      },
      {
        field: "gonioscopy.left",
        confidence: 0.72,
        origin: "synthetic_demo",
        sourceText: "ángulo abierto grado... en ojo izquierdo"
      },
      {
        field: "fundus.right",
        confidence: 0.96,
        origin: "synthetic_demo",
        sourceText: "excavación cero punto seis en ojo derecho"
      },
      {
        field: "fundus.left",
        confidence: 0.96,
        origin: "synthetic_demo",
        sourceText: "excavación cero punto ocho en ojo izquierdo"
      },
      {
        field: "assessment",
        confidence: 0.96,
        origin: "synthetic_demo",
        sourceText: "glaucoma primario de ángulo abierto en ambos ojos"
      },
      {
        field: "plan",
        confidence: 0.95,
        origin: "synthetic_demo",
        sourceText:
          "continuar latanoprost 0,005 % una gota en la noche en ambos ojos; adicionar timolol 0,5 % cada 12 horas en ojo izquierdo; control con curva de presión intraocular en seis semanas; OCT RNFL de control en cuatro meses"
      }
    ]
  };
  await client.query(
    `insert into lumen.clinical_records
       (tenant_id, encounter_id, dictation_id, status, schema_version, content, provider, model)
     values ($1, $2, $3, 'draft', 'ophthalmology-demo-v2', $4::jsonb, null, null)
     on conflict (tenant_id, encounter_id) do update set
       dictation_id = excluded.dictation_id,
       schema_version = excluded.schema_version,
       content = excluded.content,
       provider = null,
       model = null,
       updated_at = now()
     where lumen.clinical_records.status = 'draft'`,
    [tenantId, encounter.rows[0]!.id, dictation.rows[0]!.id, JSON.stringify(content)]
  );
  await client.query(
    `update lumen.encounters
     set status = 'review', updated_at = now()
     where tenant_id = $1 and id = $2 and status <> 'approved'`,
    [tenantId, encounter.rows[0]!.id]
  );
}
