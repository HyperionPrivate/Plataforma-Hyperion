-- Reglas de agenda adicionales: festivos y exclusiones profesional x convenio.
-- Solo DDL: los datos se cargan por CRUD de configuracion o seed demo local/staging.

create table if not exists pulso_iris.holidays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  holiday_date date not null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_pulso_iris_holidays_tenant_id_id
  on pulso_iris.holidays(tenant_id, id);

create unique index if not exists uq_pulso_iris_holidays_tenant_date
  on pulso_iris.holidays(tenant_id, holiday_date);

create index if not exists idx_pulso_iris_holidays_tenant_status_date
  on pulso_iris.holidays(tenant_id, status, holiday_date);

create table if not exists pulso_iris.professional_payer_exclusions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  professional_id uuid not null,
  payer_id uuid not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_professional_payer_exclusions_professional_tenant
    foreign key (tenant_id, professional_id) references pulso_iris.professionals(tenant_id, id),
  constraint fk_professional_payer_exclusions_payer_tenant
    foreign key (tenant_id, payer_id) references pulso_iris.payers(tenant_id, id)
);

create unique index if not exists uq_pulso_iris_professional_payer_exclusions_tenant_id_id
  on pulso_iris.professional_payer_exclusions(tenant_id, id);

create unique index if not exists uq_pulso_iris_professional_payer_exclusions_unique
  on pulso_iris.professional_payer_exclusions(tenant_id, professional_id, payer_id);

create index if not exists idx_pulso_iris_professional_payer_exclusions_lookup
  on pulso_iris.professional_payer_exclusions(tenant_id, status, payer_id, professional_id);
