-- NOVA product autonomy (ADR-0003 / ADR-0004).
-- Coopfuturo is the first tenant; the product code is NOVA.
-- Schemas own their data. tenant_id is an opaque logical identifier (no FKs to platform.tenants).
-- Roles are created NOLOGIN; packages/migrations bootstrap activates LOGIN with secrets.

create schema if not exists nova;
create schema if not exists voice;
create schema if not exists liwa;
create schema if not exists documents;

do $roles$
declare
  required_roles constant text[] := array[
    'hyperion_nova',
    'hyperion_voice',
    'hyperion_liwa',
    'hyperion_documents'
  ];
  role_name text;
begin
  foreach role_name in array required_roles loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'create role %I with nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
        role_name
      );
    else
      execute format(
        'alter role %I with nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
        role_name
      );
    end if;
  end loop;
end
$roles$;

-- ----- NOVA core -----
create table if not exists nova.service_migrations (
  version integer primary key check (version > 0),
  name text not null unique check (length(btrim(name)) between 3 and 160),
  applied_at timestamptz not null default now()
);

create table if not exists nova.schema_version (
  service_name text primary key check (service_name = 'nova'),
  current_version integer not null check (current_version > 0),
  migration_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists nova.tenant_snapshots (
  tenant_id uuid primary key,
  status text not null check (status in ('active', 'paused', 'archived')),
  display_name text not null check (length(btrim(display_name)) between 1 and 160),
  source_event_id uuid,
  source_version bigint not null check (source_version > 0),
  source_updated_at timestamptz not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists nova.operator_grants (
  operator_id uuid not null,
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  role text not null check (role in ('admin', 'supervisor', 'asesor')),
  is_active boolean not null default true,
  agency_codes text[] not null default '{}',
  source_event_id uuid,
  source_version bigint not null check (source_version > 0),
  source_updated_at timestamptz not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (operator_id, tenant_id)
);

create table if not exists nova.agencies (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  code text not null check (length(btrim(code)) between 2 and 40),
  name text not null check (length(btrim(name)) between 2 and 120),
  city text not null check (length(btrim(city)) between 2 and 120),
  advisor_group text not null check (length(btrim(advisor_group)) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (tenant_id, code)
);

create table if not exists nova.contacts (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  contact_id uuid not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  full_name text,
  document_masked text,
  agency_code text,
  segment text,
  score numeric(8,4),
  opted_out boolean not null default false,
  eligibility text not null default 'unknown'
    check (eligibility in ('unknown', 'eligible', 'blocked_window', 'blocked_opt_out', 'blocked_policy')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, contact_id),
  unique (tenant_id, phone_e164)
);

create table if not exists nova.campaigns (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  campaign_id uuid not null,
  name text not null check (length(btrim(name)) between 2 and 160),
  channel text not null check (channel in ('voice', 'whatsapp', 'mixed')),
  product_flow text not null check (product_flow in ('renovacion', 'reactivacion')),
  status text not null check (status in ('draft', 'ready', 'running', 'paused', 'cancelled', 'completed')),
  dialer_campaign_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, campaign_id)
);

create table if not exists nova.campaign_enrollments (
  tenant_id uuid not null,
  campaign_id uuid not null,
  contact_id uuid not null,
  status text not null check (status in ('enrolled', 'attempted', 'reached', 'failed', 'converted', 'opted_out')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, campaign_id, contact_id),
  foreign key (tenant_id, campaign_id) references nova.campaigns(tenant_id, campaign_id) on delete cascade,
  foreign key (tenant_id, contact_id) references nova.contacts(tenant_id, contact_id) on delete cascade
);

create table if not exists nova.leads (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  lead_id uuid not null,
  contact_id uuid not null,
  stage text not null check (stage in ('new', 'contacted', 'prequalified', 'handoff', 'won', 'lost')),
  tipification text,
  agency_code text,
  owner_operator_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, lead_id),
  foreign key (tenant_id, contact_id) references nova.contacts(tenant_id, contact_id) on delete cascade
);

create table if not exists nova.handoffs (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  handoff_id uuid not null,
  contact_id uuid not null,
  agency_code text not null,
  status text not null check (status in ('queued', 'claimed', 'resolved', 'expired')),
  claimed_by uuid,
  claimed_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, handoff_id),
  foreign key (tenant_id, contact_id) references nova.contacts(tenant_id, contact_id) on delete cascade
);

create table if not exists nova.conversations (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  conversation_id uuid not null,
  contact_id uuid not null,
  channel text not null check (channel in ('whatsapp', 'voice')),
  agency_code text,
  status text not null check (status in ('open', 'claimed', 'closed')),
  claimed_by uuid,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, conversation_id),
  foreign key (tenant_id, contact_id) references nova.contacts(tenant_id, contact_id) on delete cascade
);

create table if not exists nova.outcomes (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  outcome_id uuid not null,
  contact_id uuid not null,
  kind text not null check (kind in ('csat', 'core_financial', 'campaign')),
  payload jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, outcome_id)
);

create table if not exists nova.inbox_events (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  correlation_id uuid,
  business_idempotency_key text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists ux_nova_inbox_business_key
  on nova.inbox_events(business_idempotency_key)
  where business_idempotency_key is not null;

create table if not exists nova.outbox_events (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  correlation_id uuid,
  business_idempotency_key text,
  data_classification text not null default 'internal'
    check (data_classification in ('public', 'internal', 'confidential', 'restricted')),
  payload jsonb not null,
  destination text not null,
  status text not null default 'pending'
    check (status in ('pending', 'dispatching', 'completed', 'failed')),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_nova_outbox_pending
  on nova.outbox_events(available_at, created_at)
  where status = 'pending';

-- ----- VOICE -----
create table if not exists voice.service_migrations (
  version integer primary key check (version > 0),
  name text not null unique,
  applied_at timestamptz not null default now()
);

create table if not exists voice.schema_version (
  service_name text primary key check (service_name = 'voice'),
  current_version integer not null check (current_version > 0),
  migration_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists voice.calls (
  tenant_id uuid not null,
  call_id uuid not null,
  contact_phone_e164 text not null,
  campaign_ref text,
  transport text not null check (transport in ('dialer', 'elevenlabs_sip_direct', 'mock')),
  status text not null check (status in (
    'requested', 'dispatched', 'ringing', 'answered', 'completed', 'failed', 'needs_reconciliation'
  )),
  dialer_call_ref text,
  provider_conversation_id text,
  result_code text,
  intent text,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (tenant_id, call_id)
);

create table if not exists voice.campaigns (
  tenant_id uuid not null,
  campaign_id uuid not null,
  name text not null,
  dialer_campaign_ref text,
  status text not null check (status in ('draft', 'ready', 'running', 'paused', 'cancelled', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, campaign_id)
);

create table if not exists voice.inbox_events (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  business_idempotency_key text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists ux_voice_inbox_business_key
  on voice.inbox_events(business_idempotency_key)
  where business_idempotency_key is not null;

create table if not exists voice.outbox_events (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  correlation_id uuid,
  business_idempotency_key text,
  data_classification text not null default 'internal',
  payload jsonb not null,
  destination text not null,
  status text not null default 'pending'
    check (status in ('pending', 'dispatching', 'completed', 'failed')),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_voice_outbox_pending
  on voice.outbox_events(available_at, created_at)
  where status = 'pending';

create table if not exists voice.webhook_receipts (
  receipt_id uuid primary key,
  source text not null check (source in ('dialer', 'elevenlabs')),
  external_id text not null,
  signature_valid boolean not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (source, external_id)
);

-- ----- LIWA -----
create table if not exists liwa.service_migrations (
  version integer primary key check (version > 0),
  name text not null unique,
  applied_at timestamptz not null default now()
);

create table if not exists liwa.schema_version (
  service_name text primary key check (service_name = 'liwa'),
  current_version integer not null check (current_version > 0),
  migration_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists liwa.messages (
  tenant_id uuid not null,
  message_id uuid not null,
  contact_ref text not null,
  direction text not null check (direction in ('outbound', 'inbound')),
  kind text not null check (kind in ('flow', 'text', 'webhook_event')),
  status text not null check (status in ('requested', 'sent', 'delivered', 'failed', 'received')),
  flow_id text,
  agency_tag text,
  payload jsonb not null default '{}'::jsonb,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, message_id)
);

create table if not exists liwa.inbox_events (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  business_idempotency_key text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists ux_liwa_inbox_business_key
  on liwa.inbox_events(business_idempotency_key)
  where business_idempotency_key is not null;

create table if not exists liwa.outbox_events (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  correlation_id uuid,
  business_idempotency_key text,
  data_classification text not null default 'internal',
  payload jsonb not null,
  destination text not null,
  status text not null default 'pending'
    check (status in ('pending', 'dispatching', 'completed', 'failed')),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_liwa_outbox_pending
  on liwa.outbox_events(available_at, created_at)
  where status = 'pending';

create table if not exists liwa.webhook_receipts (
  receipt_id uuid primary key,
  external_id text not null unique,
  event_name text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

-- ----- DOCUMENTS -----
create table if not exists documents.service_migrations (
  version integer primary key check (version > 0),
  name text not null unique,
  applied_at timestamptz not null default now()
);

create table if not exists documents.schema_version (
  service_name text primary key check (service_name = 'documents'),
  current_version integer not null check (current_version > 0),
  migration_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists documents.objects (
  tenant_id uuid not null,
  document_id uuid not null,
  storage_key text not null,
  content_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 20971520),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('received', 'validated', 'rejected')),
  rejection_reason text,
  contact_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, document_id),
  unique (tenant_id, storage_key)
);

create table if not exists documents.inbox_events (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  business_idempotency_key text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists documents.outbox_events (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  correlation_id uuid,
  business_idempotency_key text,
  data_classification text not null default 'confidential',
  payload jsonb not null,
  destination text not null,
  status text not null default 'pending'
    check (status in ('pending', 'dispatching', 'completed', 'failed')),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_documents_outbox_pending
  on documents.outbox_events(available_at, created_at)
  where status = 'pending';

-- Privileges (bootstrap also re-grants after replaying 024)
grant usage on schema nova to hyperion_nova;
grant usage on schema voice to hyperion_voice;
grant usage on schema liwa to hyperion_liwa;
grant usage on schema documents to hyperion_documents;

grant select, insert, update, delete on all tables in schema nova to hyperion_nova;
grant select, insert, update, delete on all tables in schema voice to hyperion_voice;
grant select, insert, update, delete on all tables in schema liwa to hyperion_liwa;
grant select, insert, update, delete on all tables in schema documents to hyperion_documents;

do $dbgrant$
begin
  execute format(
    'grant connect on database %I to hyperion_nova, hyperion_voice, hyperion_liwa, hyperion_documents',
    current_database()
  );
end
$dbgrant$;

alter default privileges for role current_user in schema nova
  grant select, insert, update, delete on tables to hyperion_nova;
alter default privileges for role current_user in schema voice
  grant select, insert, update, delete on tables to hyperion_voice;
alter default privileges for role current_user in schema liwa
  grant select, insert, update, delete on tables to hyperion_liwa;
alter default privileges for role current_user in schema documents
  grant select, insert, update, delete on tables to hyperion_documents;

insert into platform.products (code, name, status, owner_service, metadata)
values (
  'NOVA',
  'NOVA',
  'building',
  'nova-core-service',
  '{"first_tenant":"coopfuturo","channels":["voice","whatsapp"]}'::jsonb
)
on conflict (code) do update
set name = excluded.name,
    status = excluded.status,
    owner_service = excluded.owner_service,
    metadata = excluded.metadata,
    updated_at = now();

insert into nova.service_migrations(version, name)
values (1, '047-nova-autonomy.sql')
on conflict (version) do update set name = excluded.name;
insert into voice.service_migrations(version, name)
values (1, '047-nova-autonomy.sql')
on conflict (version) do update set name = excluded.name;
insert into liwa.service_migrations(version, name)
values (1, '047-nova-autonomy.sql')
on conflict (version) do update set name = excluded.name;
insert into documents.service_migrations(version, name)
values (1, '047-nova-autonomy.sql')
on conflict (version) do update set name = excluded.name;

insert into nova.schema_version(service_name, current_version, migration_name)
values ('nova', 1, '047-nova-autonomy.sql')
on conflict (service_name) do update
set current_version = greatest(nova.schema_version.current_version, excluded.current_version),
    migration_name = case
      when excluded.current_version >= nova.schema_version.current_version then excluded.migration_name
      else nova.schema_version.migration_name
    end,
    updated_at = now();

insert into voice.schema_version(service_name, current_version, migration_name)
values ('voice', 1, '047-nova-autonomy.sql')
on conflict (service_name) do update
set current_version = greatest(voice.schema_version.current_version, excluded.current_version),
    migration_name = case
      when excluded.current_version >= voice.schema_version.current_version then excluded.migration_name
      else voice.schema_version.migration_name
    end,
    updated_at = now();

insert into liwa.schema_version(service_name, current_version, migration_name)
values ('liwa', 1, '047-nova-autonomy.sql')
on conflict (service_name) do update
set current_version = greatest(liwa.schema_version.current_version, excluded.current_version),
    migration_name = case
      when excluded.current_version >= liwa.schema_version.current_version then excluded.migration_name
      else liwa.schema_version.migration_name
    end,
    updated_at = now();

insert into documents.schema_version(service_name, current_version, migration_name)
values ('documents', 1, '047-nova-autonomy.sql')
on conflict (service_name) do update
set current_version = greatest(documents.schema_version.current_version, excluded.current_version),
    migration_name = case
      when excluded.current_version >= documents.schema_version.current_version then excluded.migration_name
      else documents.schema_version.migration_name
    end,
    updated_at = now();
