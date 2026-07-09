-- Configuracion operativa de agenda para PULSO IRIS.
-- Las reglas conectan sede, profesional y tipo de cita con horario/capacidad.

create table if not exists pulso_iris.availability_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  site_id uuid not null,
  professional_id uuid not null,
  appointment_type_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  starts_at time not null,
  ends_at time not null,
  slot_duration_min integer not null default 20 check (slot_duration_min > 0),
  capacity integer not null default 1 check (capacity > 0),
  timezone text not null default 'America/Bogota',
  effective_from date,
  effective_to date,
  status text not null default 'active' check (status in ('active', 'paused')),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at),
  check (effective_to is null or effective_from is null or effective_to >= effective_from),
  constraint fk_availability_rules_site_tenant
    foreign key (tenant_id, site_id) references pulso_iris.sites(tenant_id, id),
  constraint fk_availability_rules_professional_tenant
    foreign key (tenant_id, professional_id) references pulso_iris.professionals(tenant_id, id),
  constraint fk_availability_rules_appointment_type_tenant
    foreign key (tenant_id, appointment_type_id) references pulso_iris.appointment_types(tenant_id, id)
);

create unique index if not exists uq_pulso_iris_availability_rules_tenant_id_id
  on pulso_iris.availability_rules(tenant_id, id);

create unique index if not exists uq_pulso_iris_availability_rules_slot
  on pulso_iris.availability_rules(
    tenant_id,
    site_id,
    professional_id,
    appointment_type_id,
    weekday,
    starts_at,
    coalesce(effective_from, date '1900-01-01')
  );

create index if not exists idx_pulso_iris_availability_rules_tenant_status
  on pulso_iris.availability_rules(tenant_id, status, weekday, starts_at);

create index if not exists idx_pulso_iris_availability_rules_professional
  on pulso_iris.availability_rules(tenant_id, professional_id, weekday, starts_at);

create index if not exists idx_pulso_iris_availability_rules_site
  on pulso_iris.availability_rules(tenant_id, site_id, weekday, starts_at);
