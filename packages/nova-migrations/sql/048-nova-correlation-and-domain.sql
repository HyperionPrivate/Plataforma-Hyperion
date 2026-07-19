-- NOVA correlation, post-call review, analytics and domain expansions (ADR-0003).

alter table voice.calls
  add column if not exists contact_id uuid,
  add column if not exists enrollment_id uuid,
  add column if not exists disposition text,
  add column if not exists amd_label text;

alter table voice.calls
  drop constraint if exists voice_calls_transport_check;

alter table voice.calls
  add constraint voice_calls_transport_check
  check (transport in ('dialer', 'elevenlabs_sip_direct'));

create index if not exists ix_voice_calls_contact
  on voice.calls(tenant_id, contact_id)
  where contact_id is not null;

create index if not exists ix_voice_calls_provider_conversation
  on voice.calls(provider_conversation_id)
  where provider_conversation_id is not null;

-- Post-call WhatsApp review queue
create table if not exists nova.whatsapp_reviews (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  review_id uuid not null,
  contact_id uuid not null,
  call_id uuid,
  status text not null check (status in ('pending_review', 'approved', 'skipped', 'sent', 'failed')),
  intent text,
  flow_id text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, review_id),
  foreign key (tenant_id, contact_id) references nova.contacts(tenant_id, contact_id) on delete cascade
);

create index if not exists ix_nova_whatsapp_reviews_pending
  on nova.whatsapp_reviews(tenant_id, created_at)
  where status = 'pending_review';

-- Agent / product flow configuration
create table if not exists nova.agent_configs (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  product_flow text not null check (product_flow ~ '^[a-z][a-z0-9_-]{1,79}$'),
  elevenlabs_agent_id text not null,
  elevenlabs_phone_number_id text not null,
  liwa_flow_id text,
  from_number_e164 text,
  lead_context_templates jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, product_flow)
);

alter table nova.agent_configs
  add column if not exists lead_context_templates jsonb not null default '{}'::jsonb;

-- Frequency eligibility used by decideEligibility
alter table nova.contacts drop constraint if exists contacts_eligibility_check;
alter table nova.contacts
  add constraint contacts_eligibility_check
  check (eligibility in (
    'unknown', 'eligible', 'blocked_window', 'blocked_opt_out', 'blocked_policy', 'blocked_frequency'
  ));

-- Compliance settings per tenant
create table if not exists nova.compliance_settings (
  tenant_id uuid primary key references nova.tenant_snapshots(tenant_id) on delete cascade,
  window_start_hour integer not null default 8 check (window_start_hour between 0 and 23),
  window_end_hour integer not null default 20 check (window_end_hour between 1 and 24),
  voice_enabled boolean not null default true,
  whatsapp_enabled boolean not null default true,
  max_attempts_per_contact integer not null default 3 check (max_attempts_per_contact between 1 and 20),
  min_hours_between_attempts integer not null default 24 check (min_hours_between_attempts >= 0),
  respect_holidays boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists nova.opt_outs (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  phone_e164 text not null,
  contact_id uuid,
  reason text,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  primary key (tenant_id, phone_e164)
);

-- Colombia holidays (subset + extensible)
create table if not exists nova.holidays (
  holiday_date date primary key,
  name text not null
);

insert into nova.holidays(holiday_date, name) values
  ('2026-01-01', 'Año Nuevo'),
  ('2026-01-12', 'Reyes Magos'),
  ('2026-03-23', 'San José'),
  ('2026-04-02', 'Jueves Santo'),
  ('2026-04-03', 'Viernes Santo'),
  ('2026-05-01', 'Día del Trabajo'),
  ('2026-05-18', 'Ascensión'),
  ('2026-06-08', 'Corpus Christi'),
  ('2026-06-15', 'Sagrado Corazón'),
  ('2026-06-29', 'San Pedro y San Pablo'),
  ('2026-07-20', 'Independencia'),
  ('2026-08-07', 'Batalla de Boyacá'),
  ('2026-08-17', 'Asunción'),
  ('2026-10-12', 'Día de la Raza'),
  ('2026-11-02', 'Todos los Santos'),
  ('2026-11-16', 'Independencia de Cartagena'),
  ('2026-12-08', 'Inmaculada Concepción'),
  ('2026-12-25', 'Navidad')
on conflict (holiday_date) do nothing;

-- Expand lead stages to CRM funnel
alter table nova.leads drop constraint if exists leads_stage_check;
alter table nova.leads
  add constraint leads_stage_check
  check (stage in (
    'pendiente', 'contactado', 'interesado', 'documento', 'transferido', 'renovado', 'no_interes',
    'new', 'contacted', 'prequalified', 'handoff', 'won', 'lost'
  ));

alter table nova.contacts
  add column if not exists propensity numeric(8,4),
  add column if not exists urgency numeric(8,4),
  add column if not exists wave text,
  add column if not exists cupo_preaprobado boolean,
  add column if not exists mora_actual numeric(14,2),
  add column if not exists saldo_total numeric(14,2),
  add column if not exists universidad text,
  add column if not exists documento text,
  add column if not exists email text,
  add column if not exists ciudad text;

-- Attempt ledger for frequency limits
create table if not exists nova.contact_attempts (
  tenant_id uuid not null,
  attempt_id uuid not null,
  contact_id uuid not null,
  channel text not null check (channel in ('voice', 'whatsapp')),
  campaign_id uuid,
  call_id uuid,
  status text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, attempt_id),
  foreign key (tenant_id, contact_id) references nova.contacts(tenant_id, contact_id) on delete cascade
);

create index if not exists ix_nova_contact_attempts_recent
  on nova.contact_attempts(tenant_id, contact_id, created_at desc);

-- Analytics read-model (no PII)
create table if not exists nova.analytics_daily (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  day date not null,
  channel text not null check (channel in ('voice', 'whatsapp', 'all')),
  contacts_imported integer not null default 0,
  calls_requested integer not null default 0,
  calls_completed integer not null default 0,
  calls_failed integer not null default 0,
  wa_sent integer not null default 0,
  leads_contacted integer not null default 0,
  leads_interested integer not null default 0,
  leads_won integer not null default 0,
  leads_lost integer not null default 0,
  handoffs_queued integer not null default 0,
  csat_sum numeric(12,2) not null default 0,
  csat_count integer not null default 0,
  primary key (tenant_id, day, channel)
);

create table if not exists nova.csat_scores (
  tenant_id uuid not null references nova.tenant_snapshots(tenant_id) on delete cascade,
  csat_id uuid not null,
  contact_id uuid,
  score integer not null check (score between 1 and 5),
  channel text,
  note text,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, csat_id)
);

-- Outbox DLQ
create table if not exists nova.outbox_dlq (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  payload jsonb not null,
  destination text not null,
  last_error text,
  failed_at timestamptz not null default now(),
  redriven_at timestamptz
);

create table if not exists voice.outbox_dlq (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  payload jsonb not null,
  destination text not null,
  last_error text,
  failed_at timestamptz not null default now(),
  redriven_at timestamptz
);

create table if not exists liwa.outbox_dlq (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  payload jsonb not null,
  destination text not null,
  last_error text,
  failed_at timestamptz not null default now(),
  redriven_at timestamptz
);

create table if not exists documents.outbox_dlq (
  event_id uuid primary key,
  event_type text not null,
  tenant_id uuid,
  payload jsonb not null,
  destination text not null,
  last_error text,
  failed_at timestamptz not null default now(),
  redriven_at timestamptz
);

-- Tenant binding for LIWA webhook resolution
create table if not exists liwa.tenant_bindings (
  liwa_account_id text primary key,
  tenant_id uuid not null,
  default_agency_code text,
  created_at timestamptz not null default now()
);

create table if not exists liwa.contact_bindings (
  tenant_id uuid not null,
  contact_ref text not null,
  contact_id uuid,
  phone_e164 text,
  agency_tag text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, contact_ref)
);

grant select, insert, update, delete on all tables in schema nova to hyperion_nova;
grant select, insert, update, delete on all tables in schema voice to hyperion_voice;
grant select, insert, update, delete on all tables in schema liwa to hyperion_liwa;
grant select, insert, update, delete on all tables in schema documents to hyperion_documents;

insert into nova.service_migrations(version, name)
values (2, '048-nova-correlation-and-domain.sql')
on conflict (version) do update set name = excluded.name;
insert into voice.service_migrations(version, name)
values (2, '048-nova-correlation-and-domain.sql')
on conflict (version) do update set name = excluded.name;
insert into liwa.service_migrations(version, name)
values (2, '048-nova-correlation-and-domain.sql')
on conflict (version) do update set name = excluded.name;
insert into documents.service_migrations(version, name)
values (2, '048-nova-correlation-and-domain.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 2, migration_name = '048-nova-correlation-and-domain.sql', updated_at = now()
where service_name = 'nova';
update voice.schema_version
set current_version = 2, migration_name = '048-nova-correlation-and-domain.sql', updated_at = now()
where service_name = 'voice';
update liwa.schema_version
set current_version = 2, migration_name = '048-nova-correlation-and-domain.sql', updated_at = now()
where service_name = 'liwa';
update documents.schema_version
set current_version = 2, migration_name = '048-nova-correlation-and-domain.sql', updated_at = now()
where service_name = 'documents';

