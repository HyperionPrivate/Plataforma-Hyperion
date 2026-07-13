-- Primer flujo durable entre contextos autonomos:
-- Channel -> PULSO -> SOFIA -> Audit.
--
-- Los identificadores de tenant y agregados son referencias opacas. Las tablas
-- nuevas no crean FKs entre propietarios; la validez se comprueba en el borde
-- HTTP de cada consumidor.

create schema if not exists audit_runtime;

create table if not exists channel_runtime.outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_type text not null check (char_length(event_type) between 3 and 160),
  event_version integer not null default 1 check (event_version between 1 and 1000),
  aggregate_type text not null check (char_length(aggregate_type) between 1 and 80),
  aggregate_id uuid not null,
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
  unique (tenant_id, event_type, aggregate_id)
);

create index if not exists ix_channel_outbox_claim
  on channel_runtime.outbox_events(status, next_attempt_at, created_at)
  where status in ('queued', 'processing', 'retry_scheduled');

create table if not exists pulso_iris.inbox_events (
  event_id uuid primary key,
  tenant_id uuid not null,
  source_service text not null check (char_length(source_service) between 1 and 80),
  event_type text not null check (char_length(event_type) between 3 and 160),
  event_version integer not null check (event_version between 1 and 1000),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null,
  processed_at timestamptz,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  received_at timestamptz not null default now()
);

create index if not exists ix_pulso_inbox_tenant_received
  on pulso_iris.inbox_events(tenant_id, received_at desc);

create table if not exists pulso_iris.channel_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  provider text not null check (provider in ('whatsapp_web_test')),
  external_thread_id text not null check (char_length(external_thread_id) between 1 and 512),
  phone_e164_hash text not null check (phone_e164_hash ~ '^[a-f0-9]{64}$'),
  phone_masked text not null check (char_length(phone_masked) between 3 and 32),
  patient_id uuid,
  conversation_id uuid,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_pulso_channel_thread_patient
    foreign key (tenant_id, patient_id)
      references pulso_iris.administrative_patients(tenant_id, id) on delete set null (patient_id),
  constraint fk_pulso_channel_thread_conversation
    foreign key (tenant_id, conversation_id)
      references pulso_iris.conversations(tenant_id, id) on delete set null (conversation_id),
  unique (tenant_id, provider, external_thread_id)
);

create index if not exists ix_pulso_channel_threads_conversation
  on pulso_iris.channel_threads(tenant_id, conversation_id)
  where conversation_id is not null;

create table if not exists pulso_iris.outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_type text not null check (char_length(event_type) between 3 and 160),
  event_version integer not null default 1 check (event_version between 1 and 1000),
  aggregate_type text not null check (char_length(aggregate_type) between 1 and 80),
  aggregate_id uuid not null,
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
  unique (tenant_id, event_type, aggregate_id)
);

create index if not exists ix_pulso_outbox_claim
  on pulso_iris.outbox_events(status, next_attempt_at, created_at)
  where status in ('queued', 'processing', 'retry_scheduled');

create table if not exists agent_runtime.inbox_events (
  event_id uuid primary key,
  tenant_id uuid not null,
  source_service text not null check (char_length(source_service) between 1 and 80),
  event_type text not null check (char_length(event_type) between 3 and 160),
  event_version integer not null check (event_version between 1 and 1000),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null,
  processed_at timestamptz,
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  received_at timestamptz not null default now()
);

create index if not exists ix_agent_inbox_tenant_received
  on agent_runtime.inbox_events(tenant_id, received_at desc);

create table if not exists agent_runtime.outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_type text not null check (char_length(event_type) between 3 and 160),
  event_version integer not null default 1 check (event_version between 1 and 1000),
  aggregate_type text not null check (char_length(aggregate_type) between 1 and 80),
  aggregate_id uuid not null,
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
  unique (tenant_id, event_type, aggregate_id)
);

create index if not exists ix_agent_outbox_claim
  on agent_runtime.outbox_events(status, next_attempt_at, created_at)
  where status in ('queued', 'processing', 'retry_scheduled');

create table if not exists audit_runtime.inbox_events (
  event_id uuid primary key,
  tenant_id uuid,
  source_service text not null default 'sofia-automation'
    check (char_length(source_service) between 1 and 80),
  event_type text not null check (char_length(event_type) between 3 and 160),
  event_version integer not null check (event_version between 1 and 1000),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

create index if not exists ix_audit_inbox_tenant_received
  on audit_runtime.inbox_events(tenant_id, received_at desc);

alter table platform.audit_events
  add column if not exists source_event_id uuid;

create unique index if not exists uq_audit_events_source_event
  on platform.audit_events(source_event_id)
  where source_event_id is not null;

-- Los nuevos consumidores conservan los UUID como referencias externas. Estas
-- restricciones antiguas impedian ejecutar el flujo con bases logicas separadas.
alter table channel_runtime.thread_bindings
  drop constraint if exists fk_channel_thread_patient_tenant,
  drop constraint if exists fk_channel_thread_conversation_tenant;

alter table channel_runtime.inbound_events
  drop constraint if exists fk_channel_inbound_message_tenant;

alter table channel_runtime.outbound_messages
  drop constraint if exists fk_channel_outbound_message_tenant;

alter table agent_runtime.jobs
  drop constraint if exists fk_agent_jobs_conversation_tenant,
  drop constraint if exists fk_agent_jobs_inbound_event_tenant;
