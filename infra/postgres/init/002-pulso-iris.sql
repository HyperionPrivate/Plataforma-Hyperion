create extension if not exists pgcrypto;

create schema if not exists pulso_iris;

insert into platform.products (code, name, status, owner_service, metadata)
values (
  'PULSO_IRIS',
  'PULSO IRIS',
  'building',
  'pulso-iris-service',
  '{"source":"req_pulso_iris.md","agent":"SOFIA"}'::jsonb
)
on conflict (code) do update set
  name = excluded.name,
  status = excluded.status,
  owner_service = excluded.owner_service,
  metadata = platform.products.metadata || excluded.metadata,
  updated_at = now();

insert into platform.agents (tenant_id, product_id, code, name, channel, status, runtime_config)
select
  null,
  p.id,
  'SOFIA',
  'Sofia',
  'voice_whatsapp',
  'draft',
  '{"product":"PULSO_IRIS","mode":"foundation","realProvidersEnabled":false}'::jsonb
from platform.products p
where p.code = 'PULSO_IRIS'
  and not exists (
    select 1
    from platform.agents a
    where a.tenant_id is null
      and a.code = 'SOFIA'
  );

create table if not exists pulso_iris.sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  name text not null,
  city text,
  status text not null default 'active' check (status in ('active', 'paused')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.professionals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  name text not null,
  professional_type text not null check (professional_type in ('ophthalmologist', 'optometrist')),
  status text not null default 'active' check (status in ('active', 'paused')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.payers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  name text not null,
  payer_group text not null check (payer_group in ('eps', 'private_prepaid', 'policy', 'particular', 'other')),
  requires_authorization boolean not null default false,
  status text not null default 'active' check (status in ('active', 'paused')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.administrative_patients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'inactive_12m', 'waiting_list', 'high_noshow_risk', 'partial_optout', 'total_optout', 'data_cleanup')),
  document_type text,
  document_number_hash text,
  document_number_masked text,
  full_name text,
  preferred_channel text check (preferred_channel in ('voice', 'whatsapp')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  patient_id uuid references pulso_iris.administrative_patients(id) on delete set null,
  channel text not null check (channel in ('voice', 'whatsapp')),
  direction text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  status text not null default 'active' check (status in ('active', 'resolved', 'handoff_required', 'closed')),
  primary_intent text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references pulso_iris.conversations(id) on delete cascade,
  sender text not null check (sender in ('sofia', 'patient', 'advisor', 'system')),
  body text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists pulso_iris.appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  patient_id uuid references pulso_iris.administrative_patients(id) on delete set null,
  conversation_id uuid references pulso_iris.conversations(id) on delete set null,
  site_id uuid references pulso_iris.sites(id) on delete set null,
  professional_id uuid references pulso_iris.professionals(id) on delete set null,
  payer_id uuid references pulso_iris.payers(id) on delete set null,
  appointment_type text,
  status text not null default 'offered' check (status in ('offered', 'registered', 'verified', 'confirmed', 'rescheduled', 'cancelled', 'no_show')),
  scheduled_at timestamptz,
  legacy_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.rpa_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  appointment_id uuid references pulso_iris.appointments(id) on delete set null,
  conversation_id uuid references pulso_iris.conversations(id) on delete set null,
  action_type text not null check (action_type in ('check_availability', 'register_appointment', 'cancel', 'reschedule', 'confirm', 'sweep', 'create_patient')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'verification_failed', 'deferred', 'failed')),
  priority integer not null default 50,
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table if not exists pulso_iris.handoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  patient_id uuid references pulso_iris.administrative_patients(id) on delete set null,
  conversation_id uuid references pulso_iris.conversations(id) on delete set null,
  trigger_code text not null,
  priority text not null default 'medium' check (priority in ('max', 'high', 'medium', 'low')),
  status text not null default 'open' check (status in ('open', 'assigned', 'in_progress', 'resolved', 'returned_to_sofia')),
  summary text,
  sla_due_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pulso_iris.operational_kpi_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  snapshot_at timestamptz not null default now(),
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_pulso_iris_sites_tenant on pulso_iris.sites(tenant_id);
create index if not exists idx_pulso_iris_professionals_tenant on pulso_iris.professionals(tenant_id);
create index if not exists idx_pulso_iris_payers_tenant on pulso_iris.payers(tenant_id);
create index if not exists idx_pulso_iris_patients_tenant on pulso_iris.administrative_patients(tenant_id);
create index if not exists idx_pulso_iris_conversations_tenant_started on pulso_iris.conversations(tenant_id, started_at desc);
create index if not exists idx_pulso_iris_appointments_tenant_scheduled on pulso_iris.appointments(tenant_id, scheduled_at desc);
create index if not exists idx_pulso_iris_rpa_actions_tenant_status on pulso_iris.rpa_actions(tenant_id, status, created_at desc);
create index if not exists idx_pulso_iris_handoffs_tenant_status on pulso_iris.handoffs(tenant_id, status, created_at desc);
create index if not exists idx_pulso_iris_kpis_tenant_snapshot on pulso_iris.operational_kpi_snapshots(tenant_id, snapshot_at desc);
