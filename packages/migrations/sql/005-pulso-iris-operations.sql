-- Operacion de PULSO IRIS: sede en conversaciones, origen y tipo FK en citas,
-- workers RPA simulados con telemetria, campanas outbound y lista de espera.

alter table pulso_iris.conversations
  add column if not exists site_id uuid references pulso_iris.sites(id) on delete set null;

alter table pulso_iris.appointments
  add column if not exists appointment_type_id uuid references pulso_iris.appointment_types(id) on delete set null,
  add column if not exists origin text not null default 'sofia_wa';

create table if not exists pulso_iris.rpa_workers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  name text not null,
  vps_host text,
  status text not null default 'active' check (status in ('active', 'standby', 'quarantine', 'maintenance', 'inactive')),
  session_started_at timestamptz,
  last_keepalive_at timestamptz,
  current_action text,
  cpu_pct integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table pulso_iris.rpa_actions
  add column if not exists worker_id uuid references pulso_iris.rpa_workers(id) on delete set null,
  add column if not exists phase text,
  add column if not exists duration_ms integer,
  add column if not exists executed_at timestamptz;

create table if not exists pulso_iris.rpa_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  worker_id uuid references pulso_iris.rpa_workers(id) on delete set null,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists pulso_iris.campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  name text not null,
  campaign_type text not null check (campaign_type in ('reminder', 'reactivation', 'confirmation', 'survey', 'reschedule')),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'finished')),
  channels jsonb not null default '[]'::jsonb,
  segment jsonb not null default '{}'::jsonb,
  cadence jsonb not null default '{}'::jsonb,
  budget_cop numeric,
  stats jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references pulso_iris.campaigns(id) on delete cascade,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  patient_id uuid references pulso_iris.administrative_patients(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'contacted', 'interested', 'not_interested', 'no_answer', 'appointment')),
  attempts jsonb not null default '[]'::jsonb,
  result text,
  appointment_id uuid references pulso_iris.appointments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.waitlist (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  patient_id uuid references pulso_iris.administrative_patients(id) on delete set null,
  appointment_type_id uuid references pulso_iris.appointment_types(id) on delete set null,
  sites jsonb not null default '[]'::jsonb,
  time_slots jsonb not null default '[]'::jsonb,
  clinical_priority integer not null default 50,
  deadline date,
  status text not null default 'active' check (status in ('active', 'offered', 'fulfilled', 'expired')),
  offers jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_pulso_iris_conversations_tenant_site on pulso_iris.conversations(tenant_id, site_id);
create index if not exists idx_pulso_iris_rpa_workers_tenant on pulso_iris.rpa_workers(tenant_id, status);
create index if not exists idx_pulso_iris_rpa_events_tenant_created on pulso_iris.rpa_events(tenant_id, created_at desc);
create index if not exists idx_pulso_iris_campaigns_tenant on pulso_iris.campaigns(tenant_id, status);
create index if not exists idx_pulso_iris_campaign_contacts_campaign on pulso_iris.campaign_contacts(campaign_id, status);
create index if not exists idx_pulso_iris_waitlist_tenant_status on pulso_iris.waitlist(tenant_id, status, clinical_priority);
create index if not exists idx_pulso_iris_appointments_tenant_type on pulso_iris.appointments(tenant_id, appointment_type_id);
