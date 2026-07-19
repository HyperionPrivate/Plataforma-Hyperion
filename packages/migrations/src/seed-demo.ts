/**
 * Dataset DEMO sintético para PULSO IRIS (tenant UUID explícito).
 *
 * - Todo lo insertado queda marcado con metadata.is_demo = true (o colgado de
 *   filas demo), y se elimina completo con `--clear`.
 * - No contiene pacientes reales: nombres, documentos y telefonos son ficticios.
 * - Las cifras siguen el orden de magnitud del documento de requerimientos
 *   (absorcion ~82-87%, no-show decreciente hacia ~9%, verificacion RPA ~97%).
 *
 * Uso: PULSO_DEMO_TENANT_ID=<uuid> node packages/migrations/dist/seed-demo.js [--clear]
 */
import { createLogger } from "@hyperion/logger";
import pg from "pg";
import { requireDemoTenantId } from "./demo-tenant-context.js";

const { Client } = pg;

const logger = createLogger("seed-demo");

const DEMO = '{"is_demo": true}';

const PROFESSIONALS: Array<[string, "ophthalmologist" | "optometrist", string | null]> = [
  ["Dra. Mariana Rios", "ophthalmologist", "glaucoma"],
  ["Dr. Andres Pena", "ophthalmologist", "retina"],
  ["Dra. Carolina Salas", "ophthalmologist", "catarata"],
  ["Dr. Julian Vera", "ophthalmologist", "cornea"],
  ["Dra. Paula Andrade", "ophthalmologist", "refractiva"],
  ["Dr. Santiago Lozano", "ophthalmologist", "pediatria"],
  ["Dra. Valentina Duarte", "ophthalmologist", "glaucoma"],
  ["Dr. Camilo Restrepo", "ophthalmologist", "retina"],
  ["Dra. Isabela Franco", "ophthalmologist", "catarata"],
  ["Dr. Mateo Cardenas", "ophthalmologist", "cornea"],
  ["Dra. Gabriela Pardo", "ophthalmologist", "refractiva"],
  ["Dr. Nicolas Suarez", "ophthalmologist", "pediatria"],
  ["Dra. Luciana Mejia", "ophthalmologist", "glaucoma"],
  ["Dr. Sebastian Rueda", "ophthalmologist", "retina"],
  ["Dra. Antonia Silva", "ophthalmologist", "catarata"],
  ["Dr. Emilio Navarro", "ophthalmologist", "cornea"],
  ["Dra. Renata Quintero", "ophthalmologist", "refractiva"],
  ["Dr. Tomas Aguirre", "ophthalmologist", "pediatria"],
  ["Dra. Sofia Camargo", "optometrist", null],
  ["Dr. Daniel Osorio", "optometrist", null],
  ["Dra. Manuela Torres", "optometrist", null],
  ["Dr. Felipe Guzman", "optometrist", null],
  ["Dra. Juliana Prada", "optometrist", null],
  ["Dr. Alejandro Mora", "optometrist", null],
  ["Dra. Camila Herrera", "optometrist", null]
];

const PATIENTS: Array<[string, string, string]> = [
  ["Marta Lucia Pena", "CC ***7203", "+57 300 111 4410"],
  ["Jose Manuel Duarte", "CC ***5518", "+57 301 222 8837"],
  ["Camila Rondon", "CC ***9034", "+57 310 333 1204"],
  ["Pedro Galvis", "CC ***1187", "+57 311 444 5529"],
  ["Luz Dary Martinez", "CC ***6642", "+57 312 555 7716"],
  ["Maria Fernanda Rojas", "CC ***2098", "+57 313 666 9923"],
  ["Carlos Alberto Gomez", "CC ***4471", "+57 314 777 2210"],
  ["Ana Lucia Parra", "CC ***8830", "+57 315 888 4467"],
  ["Jorge Enrique Medina", "CC ***3356", "+57 316 999 6684"],
  ["Juliana Restrepo", "CC ***7789", "+57 317 111 8891"],
  ["Manuel Jose Castro", "CC ***0125", "+57 318 222 1138"],
  ["Veronica Salazar", "CC ***5540", "+57 319 333 3345"],
  ["Felipe Gomez", "CC ***9917", "+57 320 444 5562"],
  ["Andrea Lopez", "CC ***2284", "+57 321 555 7789"],
  ["Martin Elias Rivas", "CC ***6608", "+57 322 666 9906"],
  ["Catalina Mejia", "CC ***1053", "+57 323 777 2123"],
  ["Ana Maria Lopez", "CC ***4426", "+57 324 888 4340"],
  ["Sebastian Yepes", "CC ***8873", "+57 325 999 6557"],
  ["Alejandro Salazar", "CC ***3310", "+57 326 111 8774"],
  ["Camila Restrepo", "CC ***7748", "+57 327 222 0991"],
  ["Felipe Granada", "CC ***0186", "+57 328 333 3208"],
  ["Carlos Ramirez", "CC ***5623", "+57 329 444 5425"],
  ["Valentina Diaz", "CC ***9061", "+57 330 555 7642"],
  ["Beatriz Elena Lugo", "CC ***2409", "+57 331 666 9859"],
  ["Juan Pablo Suarez", "CC ***6846", "+57 332 777 2076"],
  ["Isabel Cristina Munoz", "CC ***1284", "+57 333 888 4293"],
  ["Luisa Fernanda Gil", "CC ***5721", "+57 334 999 6510"],
  ["Fernando Ospina", "CC ***0169", "+57 335 111 8727"],
  ["Ernesto Tobon", "CC ***4506", "+57 336 222 0944"],
  ["Maria Paulina Toro", "CC ***8943", "+57 337 333 3161"],
  ["Juanita Morales", "CC ***3381", "+57 338 444 5378"],
  ["Juan Camilo Toro", "CC ***7818", "+57 339 555 7595"],
  ["Lina Maria Castano", "CC ***2256", "+57 340 666 9812"],
  ["Sofia Martinez", "CC ***6693", "+57 341 777 2029"],
  ["Luis Miguel Acosta", "CC ***1130", "+57 342 888 4246"],
  ["Oscar Ivan Quintero", "CC ***5568", "+57 343 999 6463"],
  ["Marta Cecilia Ruiz", "CC ***0005", "+57 344 111 8680"],
  ["Diego Alejandro Hoyos", "CC ***4443", "+57 345 222 0897"],
  ["Ricardo Leon", "CC ***8880", "+57 346 333 3114"],
  ["Gloria Ines Botero", "CC ***3318", "+57 347 444 5331"]
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    logger.error("DATABASE_URL is required");
    process.exit(1);
  }
  const requestedTenantId = requireDemoTenantId(process.env, "PULSO_DEMO_TENANT_ID");

  const clearOnly = process.argv.includes("--clear");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const tenantResult = await client.query<{ id: string }>("select id from platform.tenants where id = $1::uuid", [
      requestedTenantId
    ]);
    const tenantId = tenantResult.rows[0]?.id;
    if (!tenantId) {
      throw new Error(`PULSO demo tenant ${requestedTenantId} not found; provision it through Access first`);
    }

    await clearDemoData(client, tenantId);
    if (clearOnly) {
      logger.info("demo data cleared");
      return;
    }

    await seed(client, tenantId);
    logger.info("demo data seeded");
  } finally {
    await client.end();
  }
}

async function clearDemoData(client: pg.Client, tenantId: string): Promise<void> {
  // El orden respeta las FKs; campanas y conversaciones arrastran hijos por cascade.
  const statements = [
    `delete from pulso_iris.rpa_events where tenant_id = $1`,
    `delete from pulso_iris.rpa_actions where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.rpa_workers where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.waitlist where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.campaigns where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.handoffs where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.appointments where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.conversations where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.administrative_patients where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.agenda_blocks where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.availability_rules where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.professional_payer_exclusions where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.holidays where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`,
    `delete from pulso_iris.professionals where tenant_id = $1 and metadata @> '${DEMO}'::jsonb`
  ];

  for (const statement of statements) {
    await client.query(statement, [tenantId]);
  }
}

async function seed(client: pg.Client, tenantId: string): Promise<void> {
  // ----- Profesionales sinteticos (25) -----
  for (const [name, type, subspecialty] of PROFESSIONALS) {
    await client.query(
      `insert into pulso_iris.professionals (tenant_id, name, professional_type, subspecialty, metadata)
       values ($1, $2, $3, $4, '${DEMO}'::jsonb)
       on conflict do nothing`,
      [tenantId, name, type, subspecialty]
    );
  }

  // ----- Pacientes sinteticos (40) -----
  for (const [name, doc, phone] of PATIENTS) {
    await client.query(
      `insert into pulso_iris.administrative_patients
         (tenant_id, full_name, document_type, document_number_masked, phone, preferred_channel, metadata)
       values ($1, $2, 'CC', $3, $4, case when random() < 0.6 then 'whatsapp' else 'voice' end, '${DEMO}'::jsonb)`,
      [tenantId, name, doc, phone]
    );
  }

  logger.info("professionals and patients seeded");

  // ----- Reglas de disponibilidad demo (L-V, manana y tarde) -----
  await client.query(
    `insert into pulso_iris.availability_rules
       (tenant_id, site_id, professional_id, appointment_type_id, weekday, starts_at, ends_at,
        slot_duration_min, capacity, timezone, status, metadata)
     select
       $1,
       s.id,
       p.id,
       t.id,
       w.weekday,
       w.starts_at::time,
       w.ends_at::time,
       greatest(t.duration_min, 20),
       case when p.professional_type = 'optometrist' then 2 else 1 end,
       'America/Bogota',
       'active',
       '${DEMO}'::jsonb
     from pulso_iris.professionals p
     cross join lateral (
       select id from pulso_iris.sites where tenant_id = $1 order by name limit 1
     ) s
     cross join lateral (
       select id, duration_min
       from pulso_iris.appointment_types
       where tenant_id = $1 and status = 'active'
       order by slot_priority, name
       limit 1
     ) t
     cross join (values
       (1, '07:00', '12:00'), (1, '14:00', '17:00'),
       (2, '07:00', '12:00'), (2, '14:00', '17:00'),
       (3, '07:00', '12:00'), (3, '14:00', '17:00'),
       (4, '07:00', '12:00'), (4, '14:00', '17:00'),
       (5, '07:00', '12:00'), (5, '14:00', '17:00')
     ) as w(weekday, starts_at, ends_at)
     where p.tenant_id = $1 and p.metadata @> '${DEMO}'::jsonb
     on conflict do nothing`,
    [tenantId]
  );

  // ----- Bloqueos demo -----
  await client.query(
    `insert into pulso_iris.agenda_blocks
       (tenant_id, site_id, professional_id, starts_at, ends_at, reason, status, metadata)
     select
       $1,
       (select id from pulso_iris.sites where tenant_id = $1 order by name limit 1),
       p.id,
       (date_trunc('week', current_date) + interval '2 days' + time '12:00') at time zone 'America/Bogota',
       (date_trunc('week', current_date) + interval '2 days' + time '14:00') at time zone 'America/Bogota',
       'Junta medica demo',
       'active',
       '${DEMO}'::jsonb
     from pulso_iris.professionals p
     where p.tenant_id = $1 and p.metadata @> '${DEMO}'::jsonb
     order by p.name
     limit 2`,
    [tenantId]
  );

  await client.query(
    `insert into pulso_iris.agenda_blocks
       (tenant_id, site_id, starts_at, ends_at, reason, status, metadata)
     values (
       $1,
       (select id from pulso_iris.sites where tenant_id = $1 order by name limit 1),
       (date_trunc('week', current_date) + interval '4 days' + time '15:00') at time zone 'America/Bogota',
       (date_trunc('week', current_date) + interval '4 days' + time '17:00') at time zone 'America/Bogota',
       'Mantenimiento de agenda demo',
       'active',
       '${DEMO}'::jsonb
     )`,
    [tenantId]
  );

  // ----- Festivos Colombia jul-dic 2026 (solo demo local/staging) -----
  const demoHolidays: Array<[string, string]> = [
    ["2026-07-20", "Independencia de Colombia"],
    ["2026-08-07", "Batalla de Boyaca"],
    ["2026-08-17", "Asuncion de la Virgen"],
    ["2026-10-12", "Dia de la Raza"],
    ["2026-11-02", "Todos los Santos"],
    ["2026-11-16", "Independencia de Cartagena"],
    ["2026-12-08", "Inmaculada Concepcion"],
    ["2026-12-25", "Navidad"]
  ];
  for (const [date, name] of demoHolidays) {
    await client.query(
      `insert into pulso_iris.holidays (tenant_id, holiday_date, name, status, metadata)
       values ($1, $2::date, $3, 'active', '${DEMO}'::jsonb)
       on conflict (tenant_id, holiday_date) do nothing`,
      [tenantId, date, name]
    );
  }

  // ----- Exclusiones profesional x convenio (2-3) -----
  await client.query(
    `insert into pulso_iris.professional_payer_exclusions
       (tenant_id, professional_id, payer_id, status, metadata)
     select
       $1,
       p.id,
       pay.id,
       'active',
       '${DEMO}'::jsonb
     from (
       select id from pulso_iris.professionals
       where tenant_id = $1 and metadata @> '${DEMO}'::jsonb
       order by name
       limit 3
     ) p
     cross join lateral (
       select id from pulso_iris.payers
       where tenant_id = $1 and payer_group = 'eps'
       order by name
       limit 1
     ) pay
     on conflict do nothing`,
    [tenantId]
  );

  logger.info("availability rules, holidays and payer exclusions seeded");

  // ----- Historial de conversaciones (30 dias, ~600/dia habil) -----
  await client.query(
    `insert into pulso_iris.conversations
       (tenant_id, patient_id, site_id, channel, direction, status, primary_intent, started_at, ended_at, metadata, created_at, updated_at)
     select
       $1,
       case when random() < 0.5 then (select id from pulso_iris.administrative_patients where tenant_id = $1 and metadata @> '${DEMO}'::jsonb order by random() limit 1) end,
       (select id from pulso_iris.sites where tenant_id = $1 order by random() * case when name like '%Sotomayor%' then 0.5 else 1 end limit 1),
       case when random() < 0.62 then 'voice' else 'whatsapp' end,
       'inbound',
       case
         when random() < 0.84 then 'resolved'
         when random() < 0.65 then 'closed'
         else 'resolved'
       end,
       (array['agendar_cita','agendar_cita','agendar_cita','agendar_cita','reagendar','confirmar_asistencia','info_convenios','preparacion_examen','consultar_cita','info_sedes_horarios'])[ceil(random()*10)],
       ts.start_ts,
       ts.start_ts + (interval '1 minute' * (2 + random() * 6)),
       jsonb_build_object('is_demo', true, 'first_response_s', round((2 + random() * 8)::numeric, 1)),
       ts.start_ts,
       ts.start_ts + (interval '1 minute' * (2 + random() * 6))
     from (
       select (d + make_interval(
         hours => (array[7,8,8,8,9,9,9,10,10,10,11,11,12,13,14,14,15,15,16,17])[ceil(random()*20)],
         mins => floor(random()*60)::int
       )) at time zone 'America/Bogota' as start_ts
       from generate_series(current_date - interval '29 days', current_date - interval '1 day', interval '1 day') d,
            generate_series(1, 420)
       where extract(isodow from d) < 6
     ) ts`,
    [tenantId]
  );

  // ----- Conversaciones de HOY (forma de pico de manana) -----
  await client.query(
    `insert into pulso_iris.conversations
       (tenant_id, patient_id, site_id, channel, direction, status, primary_intent, started_at, ended_at, metadata, created_at, updated_at)
     select
       $1,
       case when random() < 0.6 then (select id from pulso_iris.administrative_patients where tenant_id = $1 and metadata @> '${DEMO}'::jsonb order by random() limit 1) end,
       (select id from pulso_iris.sites where tenant_id = $1 order by random() limit 1),
       case when random() < 0.6 then 'voice' else 'whatsapp' end,
       'inbound',
       case
         when ts.start_ts > now() - interval '35 minutes' then 'active'
         when random() < 0.85 then 'resolved'
         else 'closed'
       end,
       (array['agendar_cita','agendar_cita','agendar_cita','reagendar','confirmar_asistencia','info_convenios','preparacion_examen','consultar_cita'])[ceil(random()*8)],
       ts.start_ts,
       case when ts.start_ts <= now() - interval '35 minutes' then ts.start_ts + (interval '1 minute' * (2 + random() * 6)) end,
       jsonb_build_object('is_demo', true, 'first_response_s', round((2 + random() * 7)::numeric, 1)),
       ts.start_ts,
       coalesce(case when ts.start_ts <= now() - interval '35 minutes' then ts.start_ts + (interval '1 minute' * (2 + random() * 6)) end, now())
     from (
       select (current_date + make_interval(
         hours => (array[7,8,8,8,9,9,9,9,10,10,10,11,11,12,13,13,14,15,16,17])[ceil(random()*20)],
         mins => floor(random()*60)::int
       )) at time zone 'America/Bogota' as start_ts
       from generate_series(1, 320)
     ) ts
     where ts.start_ts <= now()`,
    [tenantId]
  );

  logger.info("conversations seeded");

  // ----- Citas: historial del mes + agenda de esta semana y la proxima -----
  // Historial (no-show decreciente por semana: 15% -> 13% -> 11% -> 9%).
  await client.query(
    `insert into pulso_iris.appointments
       (tenant_id, patient_id, site_id, professional_id, payer_id, appointment_type_id, origin, status, scheduled_at, metadata, created_at, updated_at)
     select
       $1,
       case when random() < 0.8 then (select id from pulso_iris.administrative_patients where tenant_id = $1 and metadata @> '${DEMO}'::jsonb order by random() limit 1) end,
       (select id from pulso_iris.sites where tenant_id = $1 order by random() limit 1),
       (select id from pulso_iris.professionals where tenant_id = $1 and metadata @> '${DEMO}'::jsonb order by random() limit 1),
       (select id from pulso_iris.payers where tenant_id = $1
         and payer_group = (array['eps','eps','eps','private_prepaid','particular','policy'])[ceil(random()*6)]
         and d.d = d.d
         order by random() limit 1),
       (select id from pulso_iris.appointment_types where tenant_id = $1 and d.d = d.d order by random() limit 1),
       (array['sofia_wa','sofia_wa','sofia_voz','sofia_voz','advisor','legacy'])[ceil(random()*6)],
       case
         when random() < (0.15 - 0.02 * floor((29 - (current_date - d.d::date)) / 7.0)) then 'no_show'
         when random() < 0.10 then 'cancelled'
         when random() < 0.12 then 'rescheduled'
         when random() < 0.72 then 'confirmed'
         else 'verified'
       end,
       (d.d + make_interval(hours => 7 + floor(random()*10)::int, mins => (array[0,20,40])[ceil(random()*3)])) at time zone 'America/Bogota',
       '${DEMO}'::jsonb,
       d.d - interval '2 days',
       d.d
     from (
       select d
       from generate_series(current_date - interval '29 days', current_date - interval '1 day', interval '1 day') d,
            generate_series(1, 120)
       where extract(isodow from d) < 6
     ) d`,
    [tenantId]
  );

  // Agenda operativa: semana actual y proxima, grilla por profesional.
  await client.query(
    `insert into pulso_iris.appointments
       (tenant_id, patient_id, site_id, professional_id, payer_id, appointment_type_id, origin, status, scheduled_at, metadata, created_at, updated_at)
     select
       $1,
       (select id from pulso_iris.administrative_patients where tenant_id = $1 and metadata @> '${DEMO}'::jsonb order by random() limit 1),
       (select id from pulso_iris.sites where tenant_id = $1 order by random() limit 1),
       p.id,
       (select id from pulso_iris.payers where tenant_id = $1
         and payer_group = (array['eps','eps','eps','private_prepaid','particular','policy'])[ceil(random()*6)]
         and p.id = p.id
         order by random() limit 1),
       (select id from pulso_iris.appointment_types where tenant_id = $1 and p.id = p.id order by random() limit 1),
       (array['sofia_wa','sofia_wa','sofia_voz','advisor'])[ceil(random()*4)],
       case
         when d.d < current_date and random() < 0.06 then 'no_show'
         when random() < 0.55 then 'confirmed'
         when random() < 0.5 then 'registered'
         else 'verified'
       end,
       (d.d + make_interval(hours => s.h, mins => 0)) at time zone 'America/Bogota',
       '${DEMO}'::jsonb,
       d.d - interval '3 days',
       now()
     from pulso_iris.professionals p
     cross join generate_series(date_trunc('week', current_date), date_trunc('week', current_date) + interval '11 days', interval '1 day') d(d)
     cross join generate_series(7, 17) s(h)
     where p.tenant_id = $1 and p.metadata @> '${DEMO}'::jsonb
       and extract(isodow from d.d) < 6
       and random() < 0.42`,
    [tenantId]
  );

  logger.info("appointments seeded");

  // ----- Workers RPA (5, como el mockup) -----
  await client.query(
    `insert into pulso_iris.rpa_workers
       (tenant_id, name, vps_host, status, session_started_at, last_keepalive_at, current_action, cpu_pct, metadata)
     values
       ($1, 'WORKER-01', 'VPS Bucaramanga', 'active', now() - interval '2 hours 14 minutes', now() - interval '9 seconds', 'Registrar cita', 41, '${DEMO}'::jsonb),
       ($1, 'WORKER-02', 'VPS Medellin', 'active', now() - interval '3 hours 2 minutes', now() - interval '6 seconds', 'Consultando disponibilidad', 37, '${DEMO}'::jsonb),
       ($1, 'WORKER-03', 'VPS Bogota', 'active', now() - interval '1 hour 47 minutes', now() - interval '11 seconds', 'Verificando cita', 29, '${DEMO}'::jsonb),
       ($1, 'WORKER-04', 'VPS Cali', 'standby', null, now() - interval '30 seconds', null, 12, '${DEMO}'::jsonb),
       ($1, 'WORKER-05', 'VPS Barranquilla', 'maintenance', null, now() - interval '8 minutes', 'Reintento 2/3', 18, '${DEMO}'::jsonb)
     on conflict (tenant_id, name) do update set
       status = excluded.status,
       session_started_at = excluded.session_started_at,
       last_keepalive_at = excluded.last_keepalive_at,
       current_action = excluded.current_action,
       cpu_pct = excluded.cpu_pct,
       metadata = excluded.metadata`,
    [tenantId]
  );

  // ----- Acciones RPA: mes + hoy con cola viva -----
  await client.query(
    `insert into pulso_iris.rpa_actions
       (tenant_id, worker_id, action_type, status, priority, phase, duration_ms, executed_at, idempotency_key, payload, metadata, created_at, updated_at)
     select
       $1,
       (select id from pulso_iris.rpa_workers where tenant_id = $1 and status = 'active' order by random() limit 1),
       t.action_type,
       case
         when random() < 0.972 then 'succeeded'
         when random() < 0.55 then 'verification_failed'
         when random() < 0.6 then 'deferred'
         else 'failed'
       end,
       t.priority,
       'completado',
       t.base_ms + floor(random() * t.jitter_ms)::int,
       ts.created_at + interval '15 seconds',
       'demo:' || gen_random_uuid(),
       '{"simulated":true}'::jsonb,
       '${DEMO}'::jsonb,
       ts.created_at,
       ts.created_at + interval '15 seconds'
     from (
       select d + make_interval(hours => 7 + floor(random()*11)::int, mins => floor(random()*60)::int) as created_at
       from generate_series(current_date - interval '29 days', current_date, interval '1 day') d,
            generate_series(1, 220)
       where extract(isodow from d) < 6
     ) ts
     cross join lateral (
       select *
       from (values
         ('check_availability', 60, 2000, 3500),
         ('check_availability', 60, 2000, 3500),
         ('register_appointment', 20, 9000, 5000),
         ('confirm', 40, 6000, 4000),
         ('reschedule', 30, 12000, 6000),
         ('sweep', 90, 30000, 20000)
       ) as x(action_type, priority, base_ms, jitter_ms)
       order by random() limit 1
     ) t
     where ts.created_at <= now()`,
    [tenantId]
  );

  // Cola viva: acciones en curso y encoladas ahora mismo.
  await client.query(
    `insert into pulso_iris.rpa_actions
       (tenant_id, worker_id, action_type, status, priority, phase, duration_ms, idempotency_key, payload, metadata, created_at, updated_at)
     values
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-01'), 'register_appointment', 'running', 10, 'escribiendo', null, 'demo:live-1', '{"simulated":true}'::jsonb, '${DEMO}'::jsonb, now() - interval '62 seconds', now()),
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-02'), 'check_availability', 'running', 30, 'leyendo agenda', null, 'demo:live-2', '{"simulated":true}'::jsonb, '${DEMO}'::jsonb, now() - interval '18 seconds', now()),
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-03'), 'register_appointment', 'running', 15, 'verificacion', null, 'demo:live-3', '{"simulated":true}'::jsonb, '${DEMO}'::jsonb, now() - interval '41 seconds', now()),
       ($1, null, 'check_availability', 'queued', 40, null, null, 'demo:live-4', '{"simulated":true}'::jsonb, '${DEMO}'::jsonb, now() - interval '4 seconds', now()),
       ($1, null, 'confirm', 'queued', 50, null, null, 'demo:live-5', '{"simulated":true}'::jsonb, '${DEMO}'::jsonb, now() - interval '2 seconds', now()),
       ($1, null, 'register_appointment', 'queued', 20, null, null, 'demo:live-6', '{"simulated":true}'::jsonb, '${DEMO}'::jsonb, now() - interval '1 second', now()),
       ($1, null, 'reschedule', 'deferred', 30, null, null, 'demo:live-7', '{"simulated":true}'::jsonb, '${DEMO}'::jsonb, now() - interval '22 minutes', now())
     on conflict (tenant_id, idempotency_key) do nothing`,
    [tenantId]
  );

  // ----- Eventos RPA -----
  await client.query(
    `insert into pulso_iris.rpa_events (tenant_id, worker_id, level, message, created_at)
     values
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-03'), 'info', 'screenshot verificacion OK', now() - interval '2 minutes'),
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-01'), 'info', 'cita registrada y releida de vuelta OK', now() - interval '6 minutes'),
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-05'), 'warn', 'cambio de UI detectado: selector recalibrado', now() - interval '18 minutes'),
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-02'), 'info', 'barrido de agenda completado: 4 sedes, 25 profesionales', now() - interval '34 minutes'),
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-02'), 'info', 're-login automatico exitoso tras ERR-SES-01', now() - interval '1 hour 12 minutes'),
       ($1, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-04'), 'info', 'worker en standby caliente, keep-alive OK', now() - interval '2 hours')`,
    [tenantId]
  );

  logger.info("rpa fleet seeded");

  // ----- Handoffs: cola abierta de hoy (como el mockup) + historial resuelto -----
  await client.query(
    `insert into pulso_iris.handoffs
       (tenant_id, patient_id, conversation_id, trigger_code, priority, status, summary, sla_due_at, metadata, created_at, updated_at)
     values
       ($1, (select id from pulso_iris.administrative_patients where tenant_id = $1 and full_name = 'Maria Fernanda Rojas'),
        (select id from pulso_iris.conversations where tenant_id = $1 and status = 'active' order by started_at desc limit 1),
        'urgencia_oftalmologica', 'max', 'open', 'Paciente nueva reporta dolor ocular intenso subito. Protocolo de urgencia entregado.', now() + interval '10 minutes', '${DEMO}'::jsonb, now() - interval '42 seconds', now()),
       ($1, (select id from pulso_iris.administrative_patients where tenant_id = $1 and full_name = 'Carlos Alberto Gomez'),
        (select id from pulso_iris.conversations where tenant_id = $1 and status = 'active' order by started_at desc limit 1 offset 1),
        'programacion_cirugia', 'high', 'open', 'Retinopatia diabetica: pregunta por programacion de cirugia. Requiere asesor.', now() + interval '1 hour', '${DEMO}'::jsonb, now() - interval '3 minutes', now()),
       ($1, (select id from pulso_iris.administrative_patients where tenant_id = $1 and full_name = 'Ana Lucia Parra'),
        (select id from pulso_iris.conversations where tenant_id = $1 and status = 'active' order by started_at desc limit 1 offset 2),
        'caso_sensible', 'medium', 'assigned', 'Postoperatorio: seguimiento medico solicitado, tono preocupado.', now() + interval '4 hours', '${DEMO}'::jsonb, now() - interval '7 minutes', now()),
       ($1, (select id from pulso_iris.administrative_patients where tenant_id = $1 and full_name = 'Jorge Enrique Medina'),
        (select id from pulso_iris.conversations where tenant_id = $1 and status = 'active' order by started_at desc limit 1 offset 3),
        'fuera_de_alcance', 'medium', 'open', 'Glaucoma: consulta sobre medicamentos. Sofia no da consejo medico.', now() + interval '4 hours', '${DEMO}'::jsonb, now() - interval '12 minutes', now())`,
    [tenantId]
  );

  await client.query(
    `insert into pulso_iris.handoffs
       (tenant_id, patient_id, conversation_id, trigger_code, priority, status, summary, metadata, created_at, updated_at)
     select
       $1,
       (select id from pulso_iris.administrative_patients where tenant_id = $1 and metadata @> '${DEMO}'::jsonb order by random() limit 1),
       c.id,
       (array['autorizacion_eps_compleja','programacion_cirugia','solicitud_explicita_humano','queja_pqrs','fallo_comprension'])[ceil(random()*5)],
       (array['high','medium','medium','low'])[ceil(random()*4)],
       'resolved',
       'Caso gestionado por asesor y cerrado.',
       '${DEMO}'::jsonb,
       c.started_at + interval '3 minutes',
       c.started_at + interval '40 minutes'
     from (
       select id, started_at from pulso_iris.conversations
       where tenant_id = $1 and metadata @> '${DEMO}'::jsonb and status = 'closed'
       order by random() limit 80
     ) c`,
    [tenantId]
  );

  // ----- Conversacion guiada estilo mockup 2 (Marta Lucia, reagenda) -----
  const conversation = await client.query<{ id: string }>(
    `insert into pulso_iris.conversations
       (tenant_id, patient_id, site_id, channel, direction, status, primary_intent, started_at, metadata, created_at, updated_at)
     values (
       $1,
       (select id from pulso_iris.administrative_patients where tenant_id = $1 and full_name = 'Marta Lucia Pena'),
       (select id from pulso_iris.sites where tenant_id = $1 and name like '%Sotomayor%'),
       'whatsapp', 'inbound', 'active', 'reagendar',
       now() - interval '4 minutes',
       jsonb_build_object('is_demo', true, 'first_response_s', 4.1),
       now() - interval '4 minutes', now()
     )
     returning id`,
    [tenantId]
  );
  const convId = conversation.rows[0]?.id;

  if (convId) {
    const messages: Array<[string, string, string]> = [
      ["patient", "Hola, necesito reagendar mi cita de retina de este jueves", "4 minutes"],
      [
        "sofia",
        "Hola, Marta Lucia! Claro que si. Veo tu cita del jueves 8:40 a. m., Dra. Rueda, Sede Principal. Tengo disponibilidad el viernes a las 9:20 a. m. o el martes a las 8:00 a. m. Cual prefieres?",
        "3 minutes 40 seconds"
      ],
      ["patient", "El viernes a las 9:20 esta perfecto", "3 minutes"],
      [
        "sofia",
        "Listo! Tu cita quedo reagendada: viernes, 9:20 a. m., Dra. Rueda, Sede Principal Calle 48 No. 27-49. Te enviare recordatorio un dia antes.",
        "2 minutes 30 seconds"
      ],
      ["system", "Cita verificada en el sistema de agendamiento - RPA #4812 - 11,2 s", "2 minutes 20 seconds"]
    ];
    for (const [sender, body, ago] of messages) {
      await client.query(
        `insert into pulso_iris.messages (tenant_id, conversation_id, sender, body, metadata, created_at)
         values ($1, $2, $3, $4, '${DEMO}'::jsonb, now() - $5::interval)`,
        [tenantId, convId, sender, body, ago]
      );
    }

    await client.query(
      `insert into pulso_iris.rpa_actions
         (tenant_id, conversation_id, worker_id, action_type, status, priority, phase, duration_ms, executed_at, idempotency_key, payload, metadata, created_at, updated_at)
       values ($1, $2, (select id from pulso_iris.rpa_workers where tenant_id = $1 and name = 'WORKER-03'),
               'reschedule', 'succeeded', 15, 'verificada', 11200, now() - interval '2 minutes 20 seconds',
               'demo:mockup-thread', '{"simulated":true}'::jsonb, '${DEMO}'::jsonb, now() - interval '2 minutes 40 seconds', now())
       on conflict (tenant_id, idempotency_key) do nothing`,
      [tenantId, convId]
    );
  }

  // ----- Lista de espera (7 activos como el mockup) -----
  await client.query(
    `insert into pulso_iris.waitlist
       (tenant_id, patient_id, appointment_type_id, clinical_priority, status, metadata, created_at)
     select
       $1,
       (select id from pulso_iris.administrative_patients where tenant_id = $1 and full_name = n.name),
       (select id from pulso_iris.appointment_types where tenant_id = $1 and name = n.type_name),
       n.priority,
       'active',
       '${DEMO}'::jsonb,
       now() - (n.minutes_ago || ' minutes')::interval
     from (values
       ('Juliana Restrepo', 'Consulta oftalmologia primera vez', 20, '15'),
       ('Manuel Jose Castro', 'OCT macular', 30, '15'),
       ('Veronica Salazar', 'Consulta oftalmologia control', 40, '20'),
       ('Felipe Gomez', 'Consulta optometria', 45, '30'),
       ('Andrea Lopez', 'Control postoperatorio semana 1', 10, '20'),
       ('Martin Elias Rivas', 'Consulta oftalmologia primera vez', 50, '15'),
       ('Catalina Mejia', 'OCT macular', 35, '15')
     ) as n(name, type_name, priority, minutes_ago)`,
    [tenantId]
  );

  // ----- Campanas (4, como el mockup 5) -----
  await client.query(
    `insert into pulso_iris.campaigns
       (tenant_id, name, campaign_type, status, channels, segment, cadence, stats, metadata)
     values
       ($1, 'Recordatorio de citas T-24h', 'reminder', 'active', '["voice","whatsapp"]'::jsonb,
        '{"description":"Citas T-48/T-24/T-3, automatica permanente"}'::jsonb,
        '{"schedule":"Diaria 6:00 p.m."}'::jsonb,
        '{"contacted":412,"total":460,"confirmedPct":86,"rescheduledPct":7,"cancelledPct":3}'::jsonb,
        '${DEMO}'::jsonb),
       ($1, 'Reactivacion pacientes inactivos >12 meses', 'reactivation', 'active', '["voice"]'::jsonb,
        '{"description":"6.000 pacientes sin atencion en 12+ meses"}'::jsonb,
        '{"attempts":"max 2 voz + 1 WA","window":"L-V 8:00-18:00","retry":"voz -> WhatsApp"}'::jsonb,
        '{"contacted":2140,"total":6000,"interestPct":22,"appointments":214,"bestSlot":"10-12 a.m.","results":{"interested":22,"willCallBack":18,"notInterested":31,"noAnswer":29}}'::jsonb,
        '${DEMO}'::jsonb),
       ($1, 'Confirmacion quirurgica + preparacion', 'confirmation', 'active', '["whatsapp"]'::jsonb,
        '{"description":"Valoraciones prequirurgicas de la semana","priority":true}'::jsonb,
        '{"schedule":"T-48h"}'::jsonb,
        '{"contacted":38,"total":42,"confirmed":35,"pending":4}'::jsonb,
        '${DEMO}'::jsonb),
       ($1, 'Encuesta post-consulta NPS', 'survey', 'paused', '["whatsapp"]'::jsonb,
        '{"description":"Citas atendidas del dia"}'::jsonb,
        '{"schedule":"2-4h despues de la cita"}'::jsonb,
        '{"contacted":1870,"total":2000,"csat":4.6,"responsePct":58}'::jsonb,
        '${DEMO}'::jsonb)`,
    [tenantId]
  );

  logger.info("handoffs, waitlist and campaigns seeded");
}

await main();
