-- Frontera de datos autonoma para LUMEN.
--
-- El backfill de esta migracion es la unica lectura transicional de Access y
-- PULSO. Una vez creadas las proyecciones locales, las invariantes de LUMEN
-- dependen exclusivamente del esquema lumen y los identificadores externos se
-- conservan como referencias opacas, sin FKs entre propietarios.

create table if not exists lumen.service_migrations (
  version integer primary key check (version > 0),
  name text not null unique check (length(btrim(name)) between 3 and 160),
  applied_at timestamptz not null default now()
);

create table if not exists lumen.schema_version (
  service_name text primary key check (service_name = 'lumen'),
  current_version integer not null check (current_version > 0),
  migration_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists lumen.tenant_snapshots (
  tenant_id uuid primary key,
  status text not null check (status in ('active', 'paused', 'archived')),
  is_demo boolean not null,
  is_active boolean not null,
  source_event_id uuid,
  source_version bigint not null check (source_version > 0),
  source_updated_at timestamptz not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (is_active = (status = 'active'))
);

create table if not exists lumen.operator_grants (
  operator_id uuid not null,
  tenant_id uuid not null,
  role text not null check (length(btrim(role)) between 1 and 80),
  is_active boolean not null,
  can_review boolean not null,
  source_event_id uuid,
  source_version bigint not null check (source_version > 0),
  source_updated_at timestamptz not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (operator_id, tenant_id),
  constraint fk_lumen_operator_grant_tenant_snapshot
    foreign key (tenant_id) references lumen.tenant_snapshots(tenant_id) on delete cascade,
  check (not can_review or is_active)
);

create index if not exists ix_lumen_operator_grants_review
  on lumen.operator_grants(tenant_id, operator_id)
  where is_active and can_review;

create table if not exists lumen.encounter_reference_snapshots (
  tenant_id uuid not null,
  encounter_id uuid not null,
  patient_id uuid not null,
  site_id uuid not null,
  professional_id uuid not null,
  patient_display_name text not null check (length(btrim(patient_display_name)) between 1 and 240),
  patient_age integer check (patient_age between 0 and 130),
  payer text check (payer is null or length(btrim(payer)) between 1 and 240),
  document_masked text check (document_masked is null or length(btrim(document_masked)) between 1 and 80),
  professional_name text not null check (length(btrim(professional_name)) between 1 and 240),
  subspecialty text check (subspecialty is null or length(btrim(subspecialty)) between 1 and 240),
  site_name text not null check (length(btrim(site_name)) between 1 and 240),
  patient_is_demo boolean not null,
  professional_is_demo boolean not null,
  source_event_id uuid,
  source_version bigint not null check (source_version > 0),
  source_updated_at timestamptz not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, encounter_id),
  constraint fk_lumen_reference_tenant_snapshot
    foreign key (tenant_id) references lumen.tenant_snapshots(tenant_id) on delete restrict,
  check (patient_is_demo and professional_is_demo)
);

create index if not exists ix_lumen_reference_patient
  on lumen.encounter_reference_snapshots(tenant_id, patient_id);

create index if not exists ix_lumen_reference_professional
  on lumen.encounter_reference_snapshots(tenant_id, professional_id);

create table if not exists lumen.inbox_events (
  id uuid primary key,
  tenant_id uuid not null,
  source_service text not null check (length(btrim(source_service)) between 1 and 80),
  event_type text not null check (length(btrim(event_type)) between 3 and 160),
  event_version integer not null check (event_version between 1 and 1000),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  processed_at timestamptz,
  received_at timestamptz not null default now()
);

create index if not exists ix_lumen_inbox_tenant_received
  on lumen.inbox_events(tenant_id, received_at desc);

create table if not exists lumen.outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_type text not null check (length(btrim(event_type)) between 3 and 160),
  event_version integer not null default 1 check (event_version between 1 and 1000),
  aggregate_type text not null check (length(btrim(aggregate_type)) between 1 and 80),
  aggregate_id uuid not null,
  dedupe_key text not null check (length(btrim(dedupe_key)) between 3 and 240),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry_scheduled', 'published', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 12 check (max_attempts between 1 and 100),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  occurred_at timestamptz not null default now(),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_lumen_outbox_dedupe unique (tenant_id, dedupe_key)
);

create index if not exists ix_lumen_outbox_claim
  on lumen.outbox_events(status, next_attempt_at, created_at)
  where status in ('queued', 'processing', 'retry_scheduled');

-- Backfill transicional de tenants que ya poseen datos LUMEN. No se copia la
-- metadata del tenant; solo el estado minimo requerido por los guards locales.
insert into lumen.tenant_snapshots (
  tenant_id, status, is_demo, is_active, source_version, source_updated_at, payload_hash
)
select tenant.id,
       tenant.status,
       coalesce(tenant.metadata->>'is_demo', 'false') = 'true'
         or exists (
           select 1 from lumen.encounters encounter
           where encounter.tenant_id = tenant.id and encounter.is_demo
         ),
       tenant.status = 'active',
       greatest(1, floor(extract(epoch from tenant.updated_at) * 1000)::bigint),
       tenant.updated_at,
       encode(
         digest(
           concat_ws('|', tenant.id::text, tenant.status,
             (tenant.status = 'active')::text,
             ((coalesce(tenant.metadata->>'is_demo', 'false') = 'true')
               or exists (
                 select 1 from lumen.encounters encounter
                 where encounter.tenant_id = tenant.id and encounter.is_demo
               ))::text),
           'sha256'
         ),
         'hex'
       )
from platform.tenants tenant
where exists (select 1 from lumen.encounters encounter where encounter.tenant_id = tenant.id)
   or exists (select 1 from lumen.preconsultation_summaries summary where summary.tenant_id = tenant.id)
   or exists (select 1 from lumen.dictations dictation where dictation.tenant_id = tenant.id)
   or exists (select 1 from lumen.clinical_records record where record.tenant_id = tenant.id)
   or exists (select 1 from lumen.processing_attempts attempt where attempt.tenant_id = tenant.id)
on conflict (tenant_id) do update set
  status = excluded.status,
  is_demo = excluded.is_demo,
  is_active = excluded.is_active,
  source_version = excluded.source_version,
  source_updated_at = excluded.source_updated_at,
  payload_hash = excluded.payload_hash,
  updated_at = now();

-- Replica local del permiso efectivo que aplicaban 019/020: administradores
-- activos para todos los tenants LUMEN y coordinadores/asesores activos con
-- membresia. Tambien se preservan grants inactivos para actores historicos.
insert into lumen.operator_grants (
  operator_id, tenant_id, role, is_active, can_review,
  source_version, source_updated_at, payload_hash
)
select operator.id,
       tenant.tenant_id,
       operator.role,
       operator.status = 'active',
       operator.status = 'active'
         and (
           operator.role = 'admin'
           or (
             operator.role in ('coordinator', 'advisor')
             and exists (
               select 1 from platform.operator_tenants membership
               where membership.operator_id = operator.id
                 and membership.tenant_id = tenant.tenant_id
             )
           )
         ),
       greatest(1, floor(extract(epoch from operator.updated_at) * 1000)::bigint),
       operator.updated_at,
       encode(
         digest(
           concat_ws('|', operator.id::text, tenant.tenant_id::text, operator.role,
             (operator.status = 'active')::text,
             (operator.status = 'active'
               and (
                 operator.role = 'admin'
                 or (
                   operator.role in ('coordinator', 'advisor')
                   and exists (
                     select 1 from platform.operator_tenants membership
                     where membership.operator_id = operator.id
                       and membership.tenant_id = tenant.tenant_id
                   )
                 )
               ))::text),
           'sha256'
         ),
         'hex'
       )
from platform.operators operator
cross join lumen.tenant_snapshots tenant
where operator.role = 'admin'
   or exists (
     select 1 from platform.operator_tenants membership
     where membership.operator_id = operator.id
       and membership.tenant_id = tenant.tenant_id
   )
   or exists (
     select 1 from lumen.clinical_records record
     where record.tenant_id = tenant.tenant_id and record.approved_by = operator.id
   )
   or exists (
     select 1 from lumen.dictations dictation
     where dictation.tenant_id = tenant.tenant_id and dictation.reviewed_by = operator.id
   )
on conflict (operator_id, tenant_id) do update set
  role = excluded.role,
  is_active = excluded.is_active,
  can_review = excluded.can_review,
  source_version = excluded.source_version,
  source_updated_at = excluded.source_updated_at,
  payload_hash = excluded.payload_hash,
  updated_at = now();

-- Snapshot minimo del contrato de worklist. No contiene audio ni transcript y
-- nunca copia el numero de documento sin enmascarar.
insert into lumen.encounter_reference_snapshots (
  tenant_id, encounter_id, patient_id, site_id, professional_id,
  patient_display_name, patient_age, payer, document_masked,
  professional_name, subspecialty, site_name,
  patient_is_demo, professional_is_demo,
  source_version, source_updated_at, payload_hash, frozen_at
)
select encounter.tenant_id,
       encounter.id,
       patient.id,
       site.id,
       professional.id,
       coalesce(nullif(btrim(patient.full_name), ''), 'Paciente sin nombre'),
       case
         when (patient.metadata->>'demoAge') ~ '^[0-9]{1,3}$'
           and (patient.metadata->>'demoAge')::integer between 0 and 130
         then (patient.metadata->>'demoAge')::integer
         else null
       end,
       nullif(btrim(patient.metadata->>'payer'), ''),
       coalesce(
         nullif(btrim(patient.document_number_masked), ''),
         nullif(btrim(patient.metadata->>'documentMasked'), '')
       ),
       professional.name,
       coalesce(
         nullif(btrim(professional.metadata->>'subspecialty'), ''),
         nullif(btrim(professional.subspecialty), '')
       ),
       coalesce(
         nullif(btrim(encounter.metadata->>'siteDisplayName'), ''),
         nullif(btrim(site.metadata->>'lumenDisplayName'), ''),
         site.name
       ),
       coalesce(patient.metadata->>'is_demo', 'false') = 'true',
       coalesce(professional.metadata->>'is_demo', 'false') = 'true',
       greatest(
         1,
         floor(extract(epoch from greatest(patient.updated_at, professional.updated_at, site.updated_at)) * 1000)::bigint
       ),
       greatest(patient.updated_at, professional.updated_at, site.updated_at),
       encode(
         digest(
           concat_ws('|', encounter.tenant_id::text, encounter.id::text,
             patient.id::text, site.id::text, professional.id::text,
             coalesce(patient.full_name, ''), coalesce(patient.metadata->>'demoAge', ''),
             coalesce(patient.metadata->>'payer', ''),
             coalesce(patient.document_number_masked, patient.metadata->>'documentMasked', ''),
             professional.name,
             coalesce(professional.metadata->>'subspecialty', professional.subspecialty, ''),
             coalesce(encounter.metadata->>'siteDisplayName', site.metadata->>'lumenDisplayName', site.name),
             coalesce(patient.metadata->>'is_demo', 'false'),
             coalesce(professional.metadata->>'is_demo', 'false')),
           'sha256'
         ),
         'hex'
       ),
       case when encounter.status = 'approved' then coalesce(encounter.updated_at, now()) else null end
from lumen.encounters encounter
join pulso_iris.administrative_patients patient
  on patient.tenant_id = encounter.tenant_id and patient.id = encounter.patient_id
join pulso_iris.professionals professional
  on professional.tenant_id = encounter.tenant_id and professional.id = encounter.professional_id
join pulso_iris.sites site
  on site.tenant_id = encounter.tenant_id and site.id = encounter.site_id
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
  patient_is_demo = excluded.patient_is_demo,
  professional_is_demo = excluded.professional_is_demo,
  source_version = excluded.source_version,
  source_updated_at = excluded.source_updated_at,
  payload_hash = excluded.payload_hash,
  frozen_at = coalesce(lumen.encounter_reference_snapshots.frozen_at, excluded.frozen_at),
  updated_at = now();

do $$
begin
  if exists (
    select 1
    from lumen.encounters encounter
    left join lumen.tenant_snapshots tenant on tenant.tenant_id = encounter.tenant_id
    left join lumen.encounter_reference_snapshots reference
      on reference.tenant_id = encounter.tenant_id and reference.encounter_id = encounter.id
    where tenant.tenant_id is null
       or reference.encounter_id is null
       or reference.patient_id <> encounter.patient_id
       or reference.professional_id <> encounter.professional_id
       or reference.site_id <> encounter.site_id
       or not reference.patient_is_demo
       or not reference.professional_is_demo
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN autonomy backfill is incomplete or contains non-synthetic references';
  end if;

  if exists (
    select 1
    from lumen.clinical_records record
    left join lumen.operator_grants grant_snapshot
      on grant_snapshot.operator_id = record.approved_by
     and grant_snapshot.tenant_id = record.tenant_id
    where record.approved_by is not null and grant_snapshot.operator_id is null
  ) or exists (
    select 1
    from lumen.dictations dictation
    left join lumen.operator_grants grant_snapshot
      on grant_snapshot.operator_id = dictation.reviewed_by
     and grant_snapshot.tenant_id = dictation.tenant_id
    where dictation.reviewed_by is not null and grant_snapshot.operator_id is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN operator grant backfill is incomplete';
  end if;
end;
$$;

-- Retira objetos de LUMEN instalados sobre tablas ajenas antes de redefinir los
-- guards. La funcion queda sin llamadores y se elimina para evitar uso futuro.
drop trigger if exists trg_guard_lumen_patient_reference on pulso_iris.administrative_patients;
drop trigger if exists trg_guard_lumen_professional_reference on pulso_iris.professionals;
drop index if exists pulso_iris.uq_lumen_demo_patient_key;
drop index if exists pulso_iris.uq_lumen_demo_professional_key;
drop function if exists lumen.guard_synthetic_reference();

-- Diez FKs externas: cinco a tenant, tres a PULSO y dos a operadores.
-- Todas las FKs internas de lumen se conservan intactas.
alter table lumen.encounters
  drop constraint if exists encounters_tenant_id_fkey,
  drop constraint if exists fk_lumen_encounter_patient_tenant,
  drop constraint if exists fk_lumen_encounter_professional_tenant,
  drop constraint if exists fk_lumen_encounter_site_tenant;

alter table lumen.preconsultation_summaries
  drop constraint if exists preconsultation_summaries_tenant_id_fkey;

alter table lumen.dictations
  drop constraint if exists dictations_tenant_id_fkey,
  drop constraint if exists fk_lumen_dictation_reviewer;

alter table lumen.clinical_records
  drop constraint if exists clinical_records_tenant_id_fkey,
  drop constraint if exists fk_lumen_record_approver;

alter table lumen.processing_attempts
  drop constraint if exists processing_attempts_tenant_id_fkey;

create or replace function lumen.guard_encounter_reference_snapshot()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1 from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id and encounter.id = old.encounter_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'referenced LUMEN encounter snapshots cannot be deleted';
    end if;
    return old;
  end if;

  if not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id
  ) then
    raise exception using errcode = '23514', message = 'LUMEN tenant snapshot is required';
  end if;

  if not new.patient_is_demo or not new.professional_is_demo then
    raise exception using errcode = '23514', message = 'LUMEN references must remain synthetic';
  end if;

  if tg_op = 'UPDATE' then
    if old.tenant_id is distinct from new.tenant_id
      or old.encounter_id is distinct from new.encounter_id then
      raise exception using errcode = '23514', message = 'LUMEN snapshot identity is immutable';
    end if;

    if old.frozen_at is not null or exists (
      select 1 from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id
        and encounter.id = old.encounter_id
        and encounter.status = 'approved'
    ) then
      raise exception using errcode = '23514', message = 'approved LUMEN reference snapshots are immutable';
    end if;

    if new.source_version < old.source_version then
      raise exception using errcode = '23514', message = 'stale LUMEN reference snapshot version';
    end if;

    if new.frozen_at is not null and old.frozen_at is null and not exists (
      select 1 from lumen.clinical_records record
      where record.tenant_id = new.tenant_id
        and record.encounter_id = new.encounter_id
        and record.status = 'approved'
    ) then
      raise exception using errcode = '23514', message = 'LUMEN snapshots freeze only during record approval';
    end if;
  elsif new.frozen_at is not null and not exists (
    select 1 from lumen.encounters encounter
    where encounter.tenant_id = new.tenant_id
      and encounter.id = new.encounter_id
      and encounter.status = 'approved'
  ) then
    raise exception using errcode = '23514', message = 'new LUMEN snapshots cannot start frozen';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_encounter_reference_snapshot on lumen.encounter_reference_snapshots;
create trigger trg_guard_encounter_reference_snapshot
before insert or update or delete on lumen.encounter_reference_snapshots
for each row execute function lumen.guard_encounter_reference_snapshot();

create or replace function lumen.guard_synthetic_encounter()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' then
      raise exception using errcode = '23514', message = 'approved LUMEN encounters are immutable';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.status = 'approved' then
    raise exception using errcode = '23514', message = 'approved LUMEN encounters are immutable';
  end if;

  if not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id and tenant.is_active
  ) then
    raise exception using errcode = '23514', message = 'active LUMEN tenant snapshot is required';
  end if;

  if new.status = 'approved' and (
    tg_op = 'INSERT'
    or not exists (
      select 1 from lumen.clinical_records record
      where record.tenant_id = new.tenant_id
        and record.encounter_id = new.id
        and record.status = 'approved'
    )
  ) then
    raise exception using errcode = '23514', message = 'LUMEN encounter approval requires an approved record';
  end if;

  if not new.is_demo
    or new.demo_key is null
    or coalesce(new.metadata->>'synthetic', 'false') <> 'true' then
    raise exception using errcode = '23514', message = 'LUMEN encounters must be explicitly synthetic';
  end if;

  if not exists (
    select 1
    from lumen.encounter_reference_snapshots reference
    where reference.tenant_id = new.tenant_id
      and reference.encounter_id = new.id
      and reference.patient_id = new.patient_id
      and reference.professional_id = new.professional_id
      and reference.site_id = new.site_id
      and reference.patient_is_demo
      and reference.professional_is_demo
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN encounter requires a matching synthetic reference snapshot';
  end if;

  return new;
end;
$$;

create or replace function lumen.guard_clinical_record()
returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'DELETE' and not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id and tenant.is_active
  ) then
    raise exception using errcode = '23514', message = 'active LUMEN tenant snapshot is required';
  end if;

  if tg_op <> 'DELETE' and not exists (
    select 1
    from lumen.dictations dictation
    where dictation.tenant_id = new.tenant_id
      and dictation.encounter_id = new.encounter_id
      and dictation.id = new.dictation_id
      and dictation.status = 'transcribed'
      and btrim(dictation.transcript) <> ''
  ) then
    raise exception using errcode = '23514', message = 'LUMEN record requires a completed dictation from the same encounter';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'approved' or new.approved_by is not null or new.approved_at is not null then
      raise exception using errcode = '23514', message = 'LUMEN records must be approved by transition';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'approved' then
      raise exception using errcode = '23514', message = 'approved LUMEN records are immutable';
    end if;
    return old;
  end if;

  if old.status = 'approved' then
    raise exception using errcode = '23514', message = 'approved LUMEN records are immutable';
  end if;

  if new.status = 'approved' then
    if old.status <> 'draft' then
      raise exception using errcode = '23514', message = 'invalid LUMEN approval transition';
    end if;

    perform 1
    from lumen.encounters encounter
    where encounter.tenant_id = new.tenant_id
      and encounter.id = new.encounter_id
      and encounter.status = 'review'
    for update;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN encounter is not ready for approval';
    end if;

    if not exists (
      select 1 from lumen.operator_grants grant_snapshot
      where grant_snapshot.operator_id = new.approved_by
        and grant_snapshot.tenant_id = new.tenant_id
        and grant_snapshot.is_active
        and grant_snapshot.can_review
    ) then
      raise exception using errcode = '23514', message = 'LUMEN approver grant is missing or inactive';
    end if;
  end if;

  return new;
end;
$$;

create or replace function lumen.finalize_clinical_record_approval()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'draft' and new.status = 'approved' then
    update lumen.encounter_reference_snapshots
    set frozen_at = coalesce(frozen_at, new.approved_at, now()), updated_at = now()
    where tenant_id = new.tenant_id and encounter_id = new.encounter_id;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN approval requires a reference snapshot';
    end if;

    update lumen.encounters
    set status = 'approved', updated_at = now()
    where tenant_id = new.tenant_id and id = new.encounter_id;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN approval encounter is missing';
    end if;

    insert into lumen.outbox_events (
      tenant_id, event_type, event_version, aggregate_type, aggregate_id,
      dedupe_key, payload, occurred_at
    )
    values (
      new.tenant_id,
      'audit.event.record.v1',
      1,
      'lumen_clinical_record',
      new.id,
      'clinical-record:' || new.id::text || ':draft-approved',
      jsonb_build_object(
        'tenantId', new.tenant_id::text,
        'actorId', new.approved_by::text,
        'eventType', 'lumen.record.approved',
        'entityType', 'lumen_clinical_record',
        'entityId', new.id::text,
        'metadata', jsonb_build_object(
          'source', 'lumen-service',
          'encounterId', new.encounter_id::text,
          'schemaVersion', new.schema_version
        )
      ),
      coalesce(new.approved_at, now())
    )
    on conflict (tenant_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

create or replace function lumen.guard_approved_dictation()
returns trigger
language plpgsql
as $$
declare
  locked_encounter record;
begin
  if tg_op = 'UPDATE' then
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where (encounter.tenant_id = old.tenant_id and encounter.id = old.encounter_id)
         or (encounter.tenant_id = new.tenant_id and encounter.id = new.encounter_id)
      order by encounter.tenant_id, encounter.id
      for update
    loop
      if locked_encounter.status = 'approved' then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  elsif tg_op = 'INSERT' then
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where encounter.tenant_id = new.tenant_id and encounter.id = new.encounter_id
      for update
    loop
      if locked_encounter.status = 'approved' then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  else
    for locked_encounter in
      select encounter.tenant_id, encounter.id, encounter.status
      from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id and encounter.id = old.encounter_id
      for update
    loop
      if locked_encounter.status = 'approved' then
        raise exception using errcode = '23514', message = 'approved LUMEN encounter dictations are immutable';
      end if;
    end loop;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function lumen.guard_dictation_real_audio_lineage()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id and tenant.is_active
  ) then
    raise exception using errcode = '23514', message = 'active LUMEN tenant snapshot is required';
  end if;

  if tg_op = 'UPDATE'
    and new.provider_transcript is distinct from old.provider_transcript then
    raise exception using
      errcode = '23514',
      message = 'LUMEN provider transcript is immutable after dictation creation';
  end if;

  if tg_op = 'UPDATE'
    and old.processing_attempt_id is not null
    and new.processing_attempt_id is distinct from old.processing_attempt_id then
    raise exception using
      errcode = '23514',
      message = 'LUMEN dictation processing lineage is immutable once assigned';
  end if;

  if tg_op = 'INSERT'
    and new.status = 'transcribed'
    and coalesce(new.metadata->>'source', '') in ('browser_microphone', 'authorized_upload')
    and (new.provider_transcript is null or new.processing_attempt_id is null) then
    raise exception using
      errcode = '23514',
      message = 'real LUMEN audio dictations require immutable provider output and processing lineage';
  end if;

  if new.processing_attempt_id is not null and not exists (
    select 1
    from lumen.processing_attempts attempt
    where attempt.tenant_id = new.tenant_id
      and attempt.encounter_id = new.encounter_id
      and attempt.id = new.processing_attempt_id
      and attempt.operation = 'transcription'
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN dictation requires a transcription attempt from the same tenant and encounter';
  end if;

  if new.reviewed_by is not null and not exists (
    select 1 from lumen.operator_grants grant_snapshot
    where grant_snapshot.operator_id = new.reviewed_by
      and grant_snapshot.tenant_id = new.tenant_id
      and grant_snapshot.is_active
      and grant_snapshot.can_review
  ) then
    raise exception using
      errcode = '23514',
      message = 'LUMEN transcript reviewer grant is missing or inactive';
  end if;

  return new;
end;
$$;

create or replace function lumen.guard_processing_attempt_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1
      from lumen.encounters encounter
      where encounter.tenant_id = old.tenant_id
        and encounter.id = old.encounter_id
    ) then
      raise exception using
        errcode = '23514',
        message = 'LUMEN processing attempts can only be deleted with their encounter';
    end if;
    return old;
  end if;

  if not exists (
    select 1 from lumen.tenant_snapshots tenant
    where tenant.tenant_id = new.tenant_id and tenant.is_active
  ) then
    raise exception using errcode = '23514', message = 'active LUMEN tenant snapshot is required';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'processing'
      or new.result_entity_id is not null
      or new.completed_at is not null
      or new.failed_at is not null
      or new.cancelled_at is not null then
      raise exception using
        errcode = '23514',
        message = 'LUMEN processing attempts must begin in processing state';
    end if;
    return new;
  end if;

  if old.status <> 'processing' then
    raise exception using
      errcode = '23514',
      message = 'terminal LUMEN processing attempts are immutable';
  end if;

  if new.status = 'processing' then
    raise exception using
      errcode = '23514',
      message = 'LUMEN processing attempt update requires one terminal transition';
  end if;

  if new.tenant_id is distinct from old.tenant_id
    or new.encounter_id is distinct from old.encounter_id
    or new.operation is distinct from old.operation
    or new.idempotency_key is distinct from old.idempotency_key
    or new.input_sha256 is distinct from old.input_sha256
    or new.mime_type is distinct from old.mime_type
    or new.source is distinct from old.source
    or new.duration_seconds is distinct from old.duration_seconds
    or new.started_at is distinct from old.started_at
    or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      message = 'LUMEN processing attempt identity and input metadata are immutable';
  end if;

  if new.status = 'completed' and new.operation = 'transcription' and not exists (
    select 1
    from lumen.dictations dictation
    where dictation.tenant_id = new.tenant_id
      and dictation.encounter_id = new.encounter_id
      and dictation.id = new.result_entity_id
      and dictation.processing_attempt_id = new.id
  ) then
    raise exception using
      errcode = '23514',
      message = 'completed LUMEN transcription requires a dictation from the same attempt and encounter';
  end if;

  if new.status = 'completed' and new.operation = 'structuring' and not exists (
    select 1
    from lumen.clinical_records record
    join lumen.dictations dictation
      on dictation.tenant_id = record.tenant_id
      and dictation.encounter_id = record.encounter_id
      and dictation.id = record.dictation_id
    where record.tenant_id = new.tenant_id
      and record.encounter_id = new.encounter_id
      and record.id = new.result_entity_id
      and record.status = 'draft'
      and date_trunc('milliseconds', record.updated_at) = new.result_version
      and new.result_snapshot->>'id' = record.id::text
      and new.result_snapshot->>'tenantId' = record.tenant_id::text
      and new.result_snapshot->>'encounterId' = record.encounter_id::text
      and new.result_snapshot->>'dictationId' = record.dictation_id::text
      and new.result_snapshot->>'status' = record.status
      and new.result_snapshot->>'schemaVersion' = record.schema_version
      and new.result_snapshot->'content' = record.content
      and (new.result_snapshot->>'provider') is not distinct from record.provider
      and (new.result_snapshot->>'model') is not distinct from record.model
      and (new.result_snapshot->>'updatedAt')::timestamptz = new.result_version
      and dictation.reviewed_at is not null
      and dictation.reviewed_by is not null
  ) then
    raise exception using
      errcode = '23514',
      message = 'completed LUMEN structuring requires an exact versioned draft snapshot from the same tenant and encounter';
  end if;

  return new;
end;
$$;

insert into lumen.service_migrations (version, name)
values (22, '022-lumen-autonomy.sql')
on conflict (version) do update set name = excluded.name;

insert into lumen.schema_version (service_name, current_version, migration_name)
values ('lumen', 22, '022-lumen-autonomy.sql')
on conflict (service_name) do update set
  current_version = greatest(lumen.schema_version.current_version, excluded.current_version),
  migration_name = case
    when excluded.current_version >= lumen.schema_version.current_version then excluded.migration_name
    else lumen.schema_version.migration_name
  end,
  updated_at = now();
