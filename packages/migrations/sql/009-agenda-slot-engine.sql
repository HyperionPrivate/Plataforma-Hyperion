-- Motor de disponibilidad y reserva para PULSO IRIS.
-- Los slots se calculan desde availability_rules; esta migracion agrega
-- bloqueos/excepciones y un token de capacidad para reservar sin duplicar cupos.

alter table pulso_iris.appointments
  add column if not exists slot_capacity_token integer check (slot_capacity_token is null or slot_capacity_token > 0);

create table if not exists pulso_iris.agenda_blocks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  site_id uuid,
  professional_id uuid,
  appointment_type_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at),
  constraint fk_agenda_blocks_site_tenant
    foreign key (tenant_id, site_id) references pulso_iris.sites(tenant_id, id),
  constraint fk_agenda_blocks_professional_tenant
    foreign key (tenant_id, professional_id) references pulso_iris.professionals(tenant_id, id),
  constraint fk_agenda_blocks_appointment_type_tenant
    foreign key (tenant_id, appointment_type_id) references pulso_iris.appointment_types(tenant_id, id)
);

create unique index if not exists uq_pulso_iris_agenda_blocks_tenant_id_id
  on pulso_iris.agenda_blocks(tenant_id, id);

create index if not exists idx_pulso_iris_agenda_blocks_tenant_range
  on pulso_iris.agenda_blocks(tenant_id, status, starts_at, ends_at);

create index if not exists idx_pulso_iris_agenda_blocks_professional_range
  on pulso_iris.agenda_blocks(tenant_id, professional_id, starts_at, ends_at);

create index if not exists idx_pulso_iris_appointments_slot_lookup
  on pulso_iris.appointments(
    tenant_id,
    site_id,
    professional_id,
    appointment_type_id,
    scheduled_at
  )
  where scheduled_at is not null
    and site_id is not null
    and professional_id is not null
    and appointment_type_id is not null
    and status not in ('cancelled', 'no_show');

create unique index if not exists uq_pulso_iris_appointments_slot_capacity_token
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
    and status not in ('cancelled', 'no_show');
