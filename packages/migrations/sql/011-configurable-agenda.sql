-- Agenda configurable por tenant, reservas temporales y flujo hibrido manual.
-- No se cargan profesionales, horarios, pacientes ni citas: solo estructura y
-- valores de producto seguros para que cada tenant configure su operacion.

create extension if not exists btree_gist;

-- ----- Configuracion general -----

create table if not exists pulso_iris.agenda_settings (
  tenant_id uuid primary key references platform.tenants(id) on delete cascade,
  mode text not null default 'hybrid_manual'
    check (mode in ('internal', 'hybrid_manual', 'legacy_integrated')),
  timezone text not null default 'America/Bogota' check (length(trim(timezone)) > 0),
  booking_horizon_days integer not null default 90
    check (booking_horizon_days between 1 and 730),
  hold_duration_minutes integer not null default 10
    check (hold_duration_minutes between 1 and 1440),
  max_alternatives integer not null default 3
    check (max_alternatives between 1 and 20),
  max_reschedules integer not null default 3
    check (max_reschedules between 0 and 20),
  external_confirmation_sla_minutes integer not null default 240
    check (external_confirmation_sla_minutes between 1 and 10080),
  external_reference_required boolean not null default true,
  capacity_policy text not null default 'strict'
    check (capacity_policy in ('strict')),
  status text not null default 'active' check (status in ('active', 'paused')),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mode <> 'hybrid_manual' or external_reference_required),
  check (mode <> 'legacy_integrated' or status = 'paused')
);

insert into pulso_iris.agenda_settings (tenant_id, mode, external_reference_required)
select id, 'hybrid_manual', true
from platform.tenants
on conflict (tenant_id) do nothing;

create or replace function pulso_iris.initialize_agenda_settings()
returns trigger
language plpgsql
as $$
begin
  insert into pulso_iris.agenda_settings (tenant_id, mode, external_reference_required)
  values (new.id, 'hybrid_manual', true)
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_initialize_agenda_settings on platform.tenants;
create trigger trg_initialize_agenda_settings
after insert on platform.tenants
for each row execute function pulso_iris.initialize_agenda_settings();

-- ----- Relaciones normalizadas de profesionales -----

create unique index if not exists uq_pulso_iris_professionals_tenant_normalized_name
  on pulso_iris.professionals(tenant_id, lower(trim(name)));

create table if not exists pulso_iris.professional_sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  professional_id uuid not null,
  site_id uuid not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_professional_sites_professional_tenant
    foreign key (tenant_id, professional_id)
      references pulso_iris.professionals(tenant_id, id) on delete cascade,
  constraint fk_professional_sites_site_tenant
    foreign key (tenant_id, site_id)
      references pulso_iris.sites(tenant_id, id) on delete cascade,
  unique (tenant_id, professional_id, site_id)
);

create unique index if not exists uq_pulso_iris_professional_sites_tenant_id_id
  on pulso_iris.professional_sites(tenant_id, id);

create index if not exists idx_pulso_iris_professional_sites_lookup
  on pulso_iris.professional_sites(tenant_id, status, professional_id, site_id);

create table if not exists pulso_iris.professional_appointment_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  professional_id uuid not null,
  appointment_type_id uuid not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_professional_appointment_types_professional_tenant
    foreign key (tenant_id, professional_id)
      references pulso_iris.professionals(tenant_id, id) on delete cascade,
  constraint fk_professional_appointment_types_type_tenant
    foreign key (tenant_id, appointment_type_id)
      references pulso_iris.appointment_types(tenant_id, id) on delete cascade,
  unique (tenant_id, professional_id, appointment_type_id)
);

create unique index if not exists uq_pulso_iris_professional_appointment_types_tenant_id_id
  on pulso_iris.professional_appointment_types(tenant_id, id);

create index if not exists idx_pulso_iris_professional_appointment_types_lookup
  on pulso_iris.professional_appointment_types(tenant_id, status, professional_id, appointment_type_id);

-- Las reglas ya existentes representan relaciones validas y se preservan.
insert into pulso_iris.professional_sites (tenant_id, professional_id, site_id)
select distinct tenant_id, professional_id, site_id
from pulso_iris.availability_rules
on conflict (tenant_id, professional_id, site_id) do nothing;

insert into pulso_iris.professional_appointment_types (tenant_id, professional_id, appointment_type_id)
select distinct tenant_id, professional_id, appointment_type_id
from pulso_iris.availability_rules
on conflict (tenant_id, professional_id, appointment_type_id) do nothing;

-- Un profesional no puede atender ventanas activas superpuestas, incluso si
-- apuntan a sedes o tipos distintos. btree_gist combina UUID/dia con rangos.
alter table pulso_iris.availability_rules
  drop constraint if exists ex_pulso_iris_availability_rules_overlap;

alter table pulso_iris.availability_rules
  add constraint ex_pulso_iris_availability_rules_overlap
  exclude using gist (
    tenant_id with =,
    professional_id with =,
    weekday with =,
    (int4range(extract(epoch from starts_at)::integer, extract(epoch from ends_at)::integer, '[)')) with &&,
    (daterange(
      coalesce(effective_from, date '-infinity'),
      coalesce(effective_to, date 'infinity'),
      '[]'
    )) with &&
  ) where (status = 'active');

create or replace function pulso_iris.validate_availability_rule()
returns trigger
language plpgsql
as $$
declare
  appointment_duration integer;
begin
  select duration_min into appointment_duration
  from pulso_iris.appointment_types
  where tenant_id = new.tenant_id and id = new.appointment_type_id;

  if appointment_duration is null then
    raise exception using errcode = '23503', message = 'appointment type does not belong to tenant';
  end if;

  if new.slot_duration_min < appointment_duration then
    raise exception using errcode = '23514', message = 'slot duration cannot be shorter than appointment duration';
  end if;

  if not exists (
    select 1 from pulso_iris.professional_sites
    where tenant_id = new.tenant_id
      and professional_id = new.professional_id
      and site_id = new.site_id
      and status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'professional is not active at site';
  end if;

  if not exists (
    select 1 from pulso_iris.professional_appointment_types
    where tenant_id = new.tenant_id
      and professional_id = new.professional_id
      and appointment_type_id = new.appointment_type_id
      and status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'professional is not authorized for appointment type';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_availability_rule on pulso_iris.availability_rules;
create trigger trg_validate_availability_rule
before insert or update of tenant_id, site_id, professional_id, appointment_type_id, slot_duration_min
on pulso_iris.availability_rules
for each row execute function pulso_iris.validate_availability_rule();

-- Bloqueos importados no se pueden duplicar, incluso con referencias opcionales.
alter table pulso_iris.agenda_blocks
  add column if not exists block_type text not null default 'block'
    check (block_type in ('block', 'absence', 'vacation'));

create unique index if not exists uq_pulso_iris_agenda_blocks_natural
  on pulso_iris.agenda_blocks(
    tenant_id,
    coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(professional_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(appointment_type_id, '00000000-0000-0000-0000-000000000000'::uuid),
    starts_at,
    ends_at,
    block_type,
    lower(trim(reason))
  );

-- ----- Reserva temporal de capacidad -----

create table if not exists pulso_iris.appointment_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  patient_id uuid,
  conversation_id uuid,
  site_id uuid not null,
  professional_id uuid not null,
  payer_id uuid,
  appointment_type_id uuid not null,
  scheduled_at timestamptz not null,
  duration_min integer not null check (duration_min > 0),
  slot_capacity_token integer not null check (slot_capacity_token > 0),
  status text not null default 'active'
    check (status in ('active', 'consumed', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  idempotency_key text not null check (length(trim(idempotency_key)) >= 4),
  appointment_id uuid,
  created_by text,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (status <> 'consumed' or (appointment_id is not null and consumed_at is not null)),
  constraint fk_appointment_holds_patient_tenant
    foreign key (tenant_id, patient_id)
      references pulso_iris.administrative_patients(tenant_id, id),
  constraint fk_appointment_holds_conversation_tenant
    foreign key (tenant_id, conversation_id)
      references pulso_iris.conversations(tenant_id, id),
  constraint fk_appointment_holds_site_tenant
    foreign key (tenant_id, site_id)
      references pulso_iris.sites(tenant_id, id),
  constraint fk_appointment_holds_professional_tenant
    foreign key (tenant_id, professional_id)
      references pulso_iris.professionals(tenant_id, id),
  constraint fk_appointment_holds_payer_tenant
    foreign key (tenant_id, payer_id)
      references pulso_iris.payers(tenant_id, id),
  constraint fk_appointment_holds_type_tenant
    foreign key (tenant_id, appointment_type_id)
      references pulso_iris.appointment_types(tenant_id, id),
  constraint fk_appointment_holds_appointment_tenant
    foreign key (tenant_id, appointment_id)
      references pulso_iris.appointments(tenant_id, id)
);

create unique index if not exists uq_pulso_iris_appointment_holds_tenant_id_id
  on pulso_iris.appointment_holds(tenant_id, id);

create unique index if not exists uq_pulso_iris_appointment_holds_idempotency
  on pulso_iris.appointment_holds(tenant_id, idempotency_key);

create unique index if not exists uq_pulso_iris_appointment_holds_appointment
  on pulso_iris.appointment_holds(tenant_id, appointment_id)
  where appointment_id is not null;

create unique index if not exists uq_pulso_iris_appointment_holds_active_capacity
  on pulso_iris.appointment_holds(
    tenant_id,
    site_id,
    professional_id,
    appointment_type_id,
    scheduled_at,
    slot_capacity_token
  ) where status = 'active';

create index if not exists idx_pulso_iris_appointment_holds_expiry
  on pulso_iris.appointment_holds(tenant_id, status, expires_at);

-- ----- Ciclo de vida de la cita -----

alter table pulso_iris.appointments
  drop constraint if exists appointments_status_check;

alter table pulso_iris.appointments
  add constraint appointments_status_check check (status in (
    'offered',
    'registered',
    'pending_provider',
    'submitted',
    'pending_external_confirmation',
    'verified',
    'confirmed',
    'deferred',
    'verification_failed',
    'failed',
    'external_rejected',
    'expired',
    'rescheduled',
    'cancelled',
    'no_show'
  ));

alter table pulso_iris.appointments
  add column if not exists duration_min integer check (duration_min is null or duration_min > 0),
  add column if not exists idempotency_key text,
  add column if not exists hold_id uuid,
  add column if not exists verification_mode text
    check (verification_mode is null or verification_mode in ('internal', 'manual_external', 'legacy_provider', 'simulated')),
  add column if not exists external_system text,
  add column if not exists external_reference text,
  add column if not exists external_note text,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by text,
  add column if not exists external_sla_due_at timestamptz,
  add column if not exists reschedule_count integer not null default 0 check (reschedule_count >= 0),
  add column if not exists previous_appointment_id uuid,
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text,
  add column if not exists external_rejection_reason text,
  add column if not exists external_rejected_at timestamptz,
  add column if not exists external_rejected_by text,
  add column if not exists status_updated_at timestamptz not null default now();

update pulso_iris.appointments
set external_reference = legacy_reference
where external_reference is null and legacy_reference is not null;

update pulso_iris.appointments
set verification_mode = 'simulated',
    verified_at = coalesce(verified_at, updated_at)
where status in ('verified', 'confirmed')
  and verification_mode is null
  and coalesce((metadata ->> 'simulated')::boolean, false);

alter table pulso_iris.appointments
  add constraint fk_appointments_hold_tenant
    foreign key (tenant_id, hold_id)
      references pulso_iris.appointment_holds(tenant_id, id),
  add constraint fk_appointments_previous_tenant
    foreign key (tenant_id, previous_appointment_id)
      references pulso_iris.appointments(tenant_id, id),
  add constraint chk_appointments_manual_verification
    check (
      verification_mode is distinct from 'manual_external'
      or (
        length(trim(coalesce(external_reference, ''))) > 0
        and length(trim(coalesce(external_system, ''))) > 0
        and verified_by is not null
        and verified_at is not null
      )
    ) not valid,
  add constraint chk_appointments_verified_evidence
    check (
      status not in ('verified', 'confirmed')
      or (verification_mode is not null and verified_at is not null)
    ) not valid;

create unique index if not exists uq_pulso_iris_appointments_idempotency
  on pulso_iris.appointments(tenant_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists uq_pulso_iris_appointments_hold
  on pulso_iris.appointments(tenant_id, hold_id)
  where hold_id is not null;

create unique index if not exists uq_pulso_iris_appointments_external_reference
  on pulso_iris.appointments(tenant_id, lower(trim(external_system)), lower(trim(external_reference)))
  where external_reference is not null and length(trim(external_reference)) > 0;

create index if not exists idx_pulso_iris_appointments_external_queue
  on pulso_iris.appointments(tenant_id, status, external_sla_due_at, created_at)
  where status in ('pending_external_confirmation', 'deferred', 'verification_failed');

create index if not exists idx_pulso_iris_appointments_previous
  on pulso_iris.appointments(tenant_id, previous_appointment_id)
  where previous_appointment_id is not null;

-- Los estados terminales liberan el token. Reemplaza el predicado de 009.
drop index if exists pulso_iris.uq_pulso_iris_appointments_slot_capacity_token;
create unique index uq_pulso_iris_appointments_slot_capacity_token
  on pulso_iris.appointments(
    tenant_id,
    site_id,
    professional_id,
    appointment_type_id,
    scheduled_at,
    slot_capacity_token
  )
  where scheduled_at is not null
    and site_id is not null
    and professional_id is not null
    and appointment_type_id is not null
    and slot_capacity_token is not null
    and status not in ('cancelled', 'no_show', 'rescheduled', 'external_rejected', 'failed', 'expired');

-- Serializa reclamos entre holds y citas, ya que dos indices de tablas
-- distintas no pueden imponer por si solos una unicidad cruzada.
create or replace function pulso_iris.guard_slot_capacity_claim()
returns trigger
language plpgsql
as $$
declare
  claim_key bigint;
  is_occupying boolean;
begin
  if tg_table_name = 'appointment_holds' then
    is_occupying := new.status = 'active';
  else
    is_occupying := new.status not in (
      'cancelled', 'no_show', 'rescheduled', 'external_rejected', 'failed', 'expired'
    );
  end if;

  if not is_occupying
    or new.site_id is null
    or new.professional_id is null
    or new.appointment_type_id is null
    or new.scheduled_at is null
    or new.slot_capacity_token is null then
    return new;
  end if;

  claim_key := hashtextextended(concat_ws(
    '|',
    new.tenant_id::text,
    new.site_id::text,
    new.professional_id::text,
    new.appointment_type_id::text,
    new.scheduled_at::text,
    new.slot_capacity_token::text
  ), 0);
  perform pg_advisory_xact_lock(claim_key);

  if tg_table_name = 'appointment_holds' then
    if exists (
      select 1 from pulso_iris.appointments a
      where a.tenant_id = new.tenant_id
        and a.site_id = new.site_id
        and a.professional_id = new.professional_id
        and a.appointment_type_id = new.appointment_type_id
        and a.scheduled_at = new.scheduled_at
        and a.slot_capacity_token = new.slot_capacity_token
        and a.status not in ('cancelled', 'no_show', 'rescheduled', 'external_rejected', 'failed', 'expired')
        and (new.appointment_id is null or a.id <> new.appointment_id)
    ) then
      raise exception using errcode = '23505', message = 'slot capacity token is already occupied';
    end if;
  else
    if exists (
      select 1 from pulso_iris.appointment_holds h
      where h.tenant_id = new.tenant_id
        and h.site_id = new.site_id
        and h.professional_id = new.professional_id
        and h.appointment_type_id = new.appointment_type_id
        and h.scheduled_at = new.scheduled_at
        and h.slot_capacity_token = new.slot_capacity_token
        and h.status = 'active'
        and h.expires_at > now()
        and (new.hold_id is null or h.id <> new.hold_id)
    ) then
      raise exception using errcode = '23505', message = 'slot capacity token has an active hold';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_hold_capacity_claim on pulso_iris.appointment_holds;
create trigger trg_guard_hold_capacity_claim
before insert or update of tenant_id, site_id, professional_id, appointment_type_id,
  scheduled_at, slot_capacity_token, status, appointment_id
on pulso_iris.appointment_holds
for each row execute function pulso_iris.guard_slot_capacity_claim();

drop trigger if exists trg_guard_appointment_capacity_claim on pulso_iris.appointments;
create trigger trg_guard_appointment_capacity_claim
before insert or update of tenant_id, site_id, professional_id, appointment_type_id,
  scheduled_at, slot_capacity_token, status, hold_id
on pulso_iris.appointments
for each row execute function pulso_iris.guard_slot_capacity_claim();

-- ----- Historial de transiciones -----

create table if not exists pulso_iris.appointment_status_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  appointment_id uuid not null,
  from_status text,
  to_status text not null,
  actor_id text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint fk_appointment_status_history_appointment_tenant
    foreign key (tenant_id, appointment_id)
      references pulso_iris.appointments(tenant_id, id) on delete cascade
);

create unique index if not exists uq_pulso_iris_appointment_status_history_tenant_id_id
  on pulso_iris.appointment_status_history(tenant_id, id);

create index if not exists idx_pulso_iris_appointment_status_history_lookup
  on pulso_iris.appointment_status_history(tenant_id, appointment_id, created_at desc);

insert into pulso_iris.appointment_status_history (
  tenant_id,
  appointment_id,
  from_status,
  to_status,
  metadata
)
select
  a.tenant_id,
  a.id,
  null,
  a.status,
  '{"source":"migration-011"}'::jsonb
from pulso_iris.appointments a
where not exists (
  select 1
  from pulso_iris.appointment_status_history h
  where h.tenant_id = a.tenant_id and h.appointment_id = a.id
);

create or replace function pulso_iris.record_appointment_status_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    insert into pulso_iris.appointment_status_history (
      tenant_id,
      appointment_id,
      from_status,
      to_status,
      actor_id,
      reason,
      created_at
    ) values (
      new.tenant_id,
      new.id,
      case when tg_op = 'INSERT' then null else old.status end,
      new.status,
      case
        when new.metadata ->> 'status_actor' is not null then new.metadata ->> 'status_actor'
        when new.status in ('verified', 'confirmed') then new.verified_by
        when new.status = 'external_rejected' then new.external_rejected_by
        when new.status in ('cancelled', 'rescheduled') then new.cancelled_by
        else new.metadata ->> 'created_by'
      end,
      case
        when new.status = 'external_rejected' then new.external_rejection_reason
        when new.status in ('cancelled', 'rescheduled') then new.cancellation_reason
        else null
      end,
      clock_timestamp()
    );
  end if;
  return new;
end;
$$;

create or replace function pulso_iris.touch_appointment_status_updated_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    new.status_updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_touch_appointment_status_updated_at on pulso_iris.appointments;
create trigger trg_touch_appointment_status_updated_at
before insert or update of status on pulso_iris.appointments
for each row execute function pulso_iris.touch_appointment_status_updated_at();

drop trigger if exists trg_record_appointment_status_transition on pulso_iris.appointments;
create trigger trg_record_appointment_status_transition
after insert or update of status on pulso_iris.appointments
for each row execute function pulso_iris.record_appointment_status_transition();

-- ----- Importacion CSV con preview y aplicacion idempotente -----

create table if not exists pulso_iris.configuration_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  kind text not null check (kind in (
    'professionals',
    'professional_sites',
    'professional_appointment_types',
    'availability_rules',
    'payer_exclusions',
    'agenda_blocks'
  )),
  idempotency_key text not null check (length(trim(idempotency_key)) >= 8),
  content_hash text not null check (length(content_hash) >= 32),
  status text not null default 'previewed'
    check (status in ('previewed', 'applying', 'applied', 'failed')),
  row_count integer not null default 0 check (row_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  preview jsonb not null default '[]'::jsonb,
  error_summary jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  updated_at timestamptz not null default now(),
  check (accepted_count + rejected_count <= row_count),
  check (status <> 'applied' or applied_at is not null)
);

create unique index if not exists uq_pulso_iris_configuration_imports_tenant_id_id
  on pulso_iris.configuration_imports(tenant_id, id);

create unique index if not exists uq_pulso_iris_configuration_imports_idempotency
  on pulso_iris.configuration_imports(tenant_id, idempotency_key);

create index if not exists idx_pulso_iris_configuration_imports_created
  on pulso_iris.configuration_imports(tenant_id, created_at desc);
