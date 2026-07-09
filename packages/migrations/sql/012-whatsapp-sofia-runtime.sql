-- Runtime durable para el canal WhatsApp de prueba y SOFIA.
-- El material de sesion y los QR viven fuera de PostgreSQL, en el volumen privado
-- del adaptador. Estas tablas solo conservan estado operativo e identificadores.

create schema if not exists channel_runtime;
create schema if not exists agent_runtime;

-- ----- Agente y prompt tenant-scoped -----

insert into platform.agents (
  tenant_id,
  product_id,
  code,
  name,
  channel,
  status,
  runtime_config
)
select
  s.tenant_id,
  p.id,
  'SOFIA',
  'Sofia',
  'voice_whatsapp',
  'active',
  jsonb_build_object(
    'product', 'PULSO_IRIS',
    'channel', 'whatsapp',
    'channelProvider', 'whatsapp_web_test',
    'agendaProvider', 'internal',
    'executionMode', 'tools'
  )
from pulso_iris.agenda_settings s
join platform.products p on p.code = 'PULSO_IRIS'
on conflict (tenant_id, code) do update set
  product_id = excluded.product_id,
  name = excluded.name,
  channel = excluded.channel,
  status = 'active',
  runtime_config = platform.agents.runtime_config || excluded.runtime_config,
  updated_at = now();

insert into platform.prompt_flows (
  tenant_id,
  agent_id,
  name,
  version,
  status,
  definition
)
select
  a.tenant_id,
  a.id,
  'SOFIA - agenda administrativa',
  coalesce((
    select max(existing.version) + 1
    from platform.prompt_flows existing
    where existing.tenant_id = a.tenant_id and existing.agent_id = a.id
  ), 1),
  'active',
  jsonb_build_object(
    'systemPrompt', concat(
      'Eres SOFIA, asistente virtual administrativa de CEDCO. Habla en espanol claro y cordial. ',
      'Informa sobre sedes, convenios, tipos de cita, preparaciones y disponibilidad usando ',
      'exclusivamente los datos y herramientas de Hyperion; nunca inventes disponibilidad ni datos. ',
      'No diagnostiques, no interpretes sintomas y no des recomendaciones clinicas. ',
      'Antes de reservar, cancelar o reagendar exige una confirmacion explicita de la persona. ',
      'Para agendar, primero consulta disponibilidad; despues de la confirmacion ejecuta ',
      'create_appointment_hold y luego book_appointment en el mismo turno. Solo informa que ',
      'la cita quedo agendada cuando book_appointment devuelve status verified. Para cancelar ',
      'o reagendar, lista primero las citas y confirma la cita exacta antes de ejecutar el cambio. ',
      'Si la persona menciona una urgencia o sintomas, detiene el agendamiento, comunica que no ',
      'puedes orientar clinicamente y solicita atencion por los canales de urgencias disponibles; ',
      'marca la conversacion como handoff_required. Si una herramienta o dato no esta disponible, ',
      'indicalo sin inventar. No reveles modelos, proveedores ni detalles internos de la plataforma.'
    ),
    'language', 'es-CO',
    'runtimeKey', 'sofia_whatsapp_internal_v1',
    'scope', 'administrative',
    'catalogSource', 'hyperion',
    'urgentMessage', concat(
      'Por seguridad, no puedo orientar sintomas ni urgencias. Busca atencion medica urgente ',
      'o comunicate con los servicios de emergencia de tu zona si corresponde.'
    ),
    'requiresExplicitConfirmation', jsonb_build_array(
      'book_appointment',
      'create_appointment_hold',
      'cancel_appointment',
      'reschedule_appointment'
    ),
    'urgencyAction', 'handoff_required'
  )
from platform.agents a
where a.tenant_id is not null
  and a.code = 'SOFIA'
  and not exists (
    select 1
    from platform.prompt_flows f
    where f.tenant_id = a.tenant_id
      and f.agent_id = a.id
      and f.status = 'active'
      and f.definition ->> 'runtimeKey' = 'sofia_whatsapp_internal_v1'
  );

-- ----- Vinculos administrativos de PULSO IRIS -----

alter table pulso_iris.professionals
  add column if not exists is_pilot boolean not null default false;

alter table pulso_iris.administrative_patients
  add column if not exists phone_e164_hash text
    check (phone_e164_hash is null or length(phone_e164_hash) = 64),
  add column if not exists phone_masked text;

create unique index if not exists uq_pulso_iris_patients_tenant_phone_hash
  on pulso_iris.administrative_patients(tenant_id, phone_e164_hash)
  where phone_e164_hash is not null;

alter table pulso_iris.messages
  add column if not exists provider text,
  add column if not exists external_message_id text,
  add column if not exists provider_message_id text,
  add column if not exists delivery_status text,
  add column if not exists delivered_at timestamptz;

alter table pulso_iris.messages
  drop constraint if exists ck_pulso_iris_messages_delivery_status;

alter table pulso_iris.messages
  add constraint ck_pulso_iris_messages_delivery_status
    check (
      delivery_status is null
      or delivery_status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'ignored')
    );

create unique index if not exists uq_pulso_iris_messages_tenant_id_id
  on pulso_iris.messages(tenant_id, id);

create unique index if not exists uq_pulso_iris_messages_inbound_external
  on pulso_iris.messages(tenant_id, provider, external_message_id)
  where provider is not null and external_message_id is not null;

create unique index if not exists uq_pulso_iris_messages_outbound_provider
  on pulso_iris.messages(tenant_id, provider, provider_message_id)
  where provider is not null and provider_message_id is not null;

create index if not exists idx_pulso_iris_messages_delivery
  on pulso_iris.messages(tenant_id, delivery_status, created_at desc);

-- ----- Canal WhatsApp -----

create table if not exists channel_runtime.connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  provider_mode text not null default 'whatsapp_web_test'
    check (provider_mode in ('whatsapp_web_test')),
  state text not null default 'disconnected'
    check (state in ('disconnected', 'qr_pending', 'connecting', 'ready', 'degraded')),
  phone_masked text,
  session_restorable boolean not null default false,
  qr_expires_at timestamptz,
  last_activity_at timestamptz,
  last_error_code text,
  last_error_message text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  reconnect_attempts integer not null default 0 check (reconnect_attempts >= 0),
  next_retry_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id)
);

create unique index if not exists uq_channel_runtime_connections_tenant_id_id
  on channel_runtime.connections(tenant_id, id);

create index if not exists idx_channel_runtime_connections_retry
  on channel_runtime.connections(state, next_retry_at)
  where state in ('degraded', 'connecting');

create table if not exists channel_runtime.thread_bindings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  connection_id uuid not null,
  provider text not null,
  external_thread_id text not null,
  phone_e164_hash text not null check (length(phone_e164_hash) = 64),
  phone_masked text not null,
  patient_id uuid,
  conversation_id uuid,
  status text not null default 'active' check (status in ('active', 'closed', 'blocked')),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_channel_thread_connection_tenant
    foreign key (tenant_id, connection_id)
      references channel_runtime.connections(tenant_id, id) on delete cascade,
  constraint fk_channel_thread_patient_tenant
    foreign key (tenant_id, patient_id)
      references pulso_iris.administrative_patients(tenant_id, id) on delete set null (patient_id),
  constraint fk_channel_thread_conversation_tenant
    foreign key (tenant_id, conversation_id)
      references pulso_iris.conversations(tenant_id, id) on delete set null (conversation_id),
  unique (tenant_id, provider, external_thread_id),
  unique (tenant_id, provider, phone_e164_hash)
);

create unique index if not exists uq_channel_runtime_thread_bindings_tenant_id_id
  on channel_runtime.thread_bindings(tenant_id, id);

create index if not exists idx_channel_runtime_thread_bindings_conversation
  on channel_runtime.thread_bindings(tenant_id, conversation_id)
  where conversation_id is not null;

create table if not exists channel_runtime.inbound_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  connection_id uuid not null,
  thread_binding_id uuid,
  message_id uuid,
  provider text not null,
  external_message_id text not null,
  body text not null check (length(body) between 1 and 4096),
  status text not null default 'received'
    check (status in (
      'received', 'queued', 'processing', 'processed', 'ignored',
      'retry_scheduled', 'failed', 'dead_letter'
    )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  occurred_at timestamptz not null,
  processed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_channel_inbound_connection_tenant
    foreign key (tenant_id, connection_id)
      references channel_runtime.connections(tenant_id, id) on delete cascade,
  constraint fk_channel_inbound_thread_tenant
    foreign key (tenant_id, thread_binding_id)
      references channel_runtime.thread_bindings(tenant_id, id) on delete set null (thread_binding_id),
  constraint fk_channel_inbound_message_tenant
    foreign key (tenant_id, message_id)
      references pulso_iris.messages(tenant_id, id) on delete set null (message_id),
  unique (tenant_id, provider, external_message_id)
);

create unique index if not exists uq_channel_runtime_inbound_events_tenant_id_id
  on channel_runtime.inbound_events(tenant_id, id);

create index if not exists idx_channel_runtime_inbound_events_claim
  on channel_runtime.inbound_events(status, next_attempt_at, created_at)
  where status in ('received', 'queued', 'retry_scheduled', 'processing');

create table if not exists channel_runtime.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  connection_id uuid not null,
  thread_binding_id uuid not null,
  message_id uuid not null,
  provider text not null,
  idempotency_key text not null check (length(trim(idempotency_key)) >= 8),
  body text not null check (length(body) between 1 and 4096),
  provider_message_id text,
  status text not null default 'queued'
    check (status in (
      'queued', 'processing', 'sending', 'retry_scheduled', 'sent', 'delivered',
      'failed', 'cancelled', 'dead_letter', 'reconciliation_required'
    )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_channel_outbound_connection_tenant
    foreign key (tenant_id, connection_id)
      references channel_runtime.connections(tenant_id, id) on delete cascade,
  constraint fk_channel_outbound_thread_tenant
    foreign key (tenant_id, thread_binding_id)
      references channel_runtime.thread_bindings(tenant_id, id),
  constraint fk_channel_outbound_message_tenant
    foreign key (tenant_id, message_id)
      references pulso_iris.messages(tenant_id, id) on delete cascade,
  unique (tenant_id, provider, idempotency_key)
);

create unique index if not exists uq_channel_runtime_outbound_messages_tenant_id_id
  on channel_runtime.outbound_messages(tenant_id, id);

create unique index if not exists uq_channel_runtime_outbound_provider_message
  on channel_runtime.outbound_messages(tenant_id, provider, provider_message_id)
  where provider_message_id is not null;

create index if not exists idx_channel_runtime_outbound_messages_claim
  on channel_runtime.outbound_messages(status, next_attempt_at, created_at)
  where status in ('queued', 'retry_scheduled', 'processing', 'sending');

create index if not exists idx_channel_runtime_outbound_messages_lease
  on channel_runtime.outbound_messages(status, locked_at)
  where status in ('processing', 'sending');

-- ----- Ejecucion durable de SOFIA -----

create table if not exists agent_runtime.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  conversation_id uuid not null,
  inbound_event_id uuid not null,
  job_type text not null default 'sofia_message' check (job_type in ('sofia_message')),
  idempotency_key text not null check (length(trim(idempotency_key)) >= 8),
  status text not null default 'queued'
    check (status in (
      'queued', 'running', 'retry_scheduled', 'completed',
      'failed', 'cancelled', 'dead_letter'
    )),
  priority integer not null default 50 check (priority between 0 and 100),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 2 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  input jsonb not null default '{}'::jsonb check (jsonb_typeof(input) = 'object'),
  last_error_code text,
  last_error_message text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_agent_jobs_conversation_tenant
    foreign key (tenant_id, conversation_id)
      references pulso_iris.conversations(tenant_id, id) on delete cascade,
  constraint fk_agent_jobs_inbound_event_tenant
    foreign key (tenant_id, inbound_event_id)
      references channel_runtime.inbound_events(tenant_id, id) on delete cascade,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, inbound_event_id)
);

create unique index if not exists uq_agent_runtime_jobs_tenant_id_id
  on agent_runtime.jobs(tenant_id, id);

create index if not exists idx_agent_runtime_jobs_claim
  on agent_runtime.jobs(status, priority desc, next_attempt_at, created_at)
  where status in ('queued', 'retry_scheduled', 'running');

create table if not exists agent_runtime.executions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  job_id uuid not null,
  agent_code text not null default 'SOFIA' check (agent_code = 'SOFIA'),
  provider text not null,
  model text not null,
  status text not null check (status in ('running', 'completed', 'failed', 'fallback')),
  attempt_number integer not null default 1 check (attempt_number >= 1),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  tool_names jsonb not null default '[]'::jsonb check (jsonb_typeof(tool_names) = 'array'),
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint fk_agent_executions_job_tenant
    foreign key (tenant_id, job_id)
      references agent_runtime.jobs(tenant_id, id) on delete cascade,
  unique (tenant_id, job_id, attempt_number)
);

create unique index if not exists uq_agent_runtime_executions_tenant_id_id
  on agent_runtime.executions(tenant_id, id);

create index if not exists idx_agent_runtime_executions_job
  on agent_runtime.executions(tenant_id, job_id, attempt_number desc);

-- Claims atomicos. Los workers pueden ejecutar estas funciones en paralelo sin
-- procesar dos veces la misma unidad de trabajo.

create or replace function channel_runtime.claim_next_inbound_event(p_worker_id text)
returns setof channel_runtime.inbound_events
language sql
volatile
as $$
  with terminalized as (
    update channel_runtime.inbound_events
    set status = 'dead_letter',
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where status = 'processing'
      and locked_at < now() - interval '2 minutes'
      and attempt_count >= max_attempts
    returning id
  ), candidate as (
    select id, status
    from channel_runtime.inbound_events
    where (
        status in ('received', 'queued', 'retry_scheduled')
        or (status = 'processing' and locked_at < now() - interval '2 minutes')
      )
      and next_attempt_at <= now()
      and attempt_count < max_attempts
    order by next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update channel_runtime.inbound_events e
  set status = 'processing',
      attempt_count = e.attempt_count + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      updated_at = now()
  from candidate
  where e.id = candidate.id
  returning e.*;
$$;

create or replace function channel_runtime.claim_next_outbound_message(p_worker_id text)
returns setof channel_runtime.outbound_messages
language sql
volatile
as $$
  with uncertain as (
    update channel_runtime.outbound_messages
    set status = 'reconciliation_required',
        locked_at = null,
        locked_by = null,
        last_error_code = 'delivery_outcome_unknown',
        last_error_message = null,
        updated_at = now()
    where status = 'sending'
      and locked_at < now() - interval '2 minutes'
    returning tenant_id, message_id
  ), project_uncertain as (
    update pulso_iris.messages m
    set delivery_status = 'failed',
        metadata = coalesce(m.metadata, '{}'::jsonb)
          || '{"deliveryReconciliationRequired":true}'::jsonb
    from uncertain u
    where m.tenant_id = u.tenant_id and m.id = u.message_id
    returning m.id
  ), terminalized as (
    update channel_runtime.outbound_messages
    set status = 'dead_letter',
        locked_at = null,
        locked_by = null,
        last_error_code = 'claim_attempts_exhausted',
        last_error_message = null,
        updated_at = now()
    where status = 'processing'
      and locked_at < now() - interval '2 minutes'
      and attempt_count >= max_attempts
    returning tenant_id, message_id
  ), project_terminalized as (
    update pulso_iris.messages m
    set delivery_status = 'failed'
    from terminalized t
    where m.tenant_id = t.tenant_id and m.id = t.message_id
    returning m.id
  ), candidate as (
    select id, status
    from channel_runtime.outbound_messages
    where (
        status in ('queued', 'retry_scheduled')
        or (status = 'processing' and locked_at < now() - interval '2 minutes')
      )
      and next_attempt_at <= now()
      and attempt_count < max_attempts
    order by next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update channel_runtime.outbound_messages m
  set status = 'processing',
      attempt_count = m.attempt_count + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      updated_at = now()
  from candidate
  where m.id = candidate.id
  returning m.*;
$$;

create or replace function agent_runtime.claim_next_job(p_worker_id text)
returns setof agent_runtime.jobs
language sql
volatile
as $$
  with terminalized as (
    update agent_runtime.jobs
    set status = 'dead_letter',
        locked_at = null,
        locked_by = null,
        updated_at = now()
    where status = 'running'
      and locked_at < now() - interval '2 minutes'
      and attempt_count >= max_attempts
    returning id
  ), candidate as (
    select id, status
    from agent_runtime.jobs
    where (
        status in ('queued', 'retry_scheduled')
        or (status = 'running' and locked_at < now() - interval '2 minutes')
      )
      and next_attempt_at <= now()
      and attempt_count < max_attempts
    order by priority desc, next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update agent_runtime.jobs j
  set status = 'running',
      attempt_count = j.attempt_count + 1,
      locked_at = now(),
      locked_by = p_worker_id,
      updated_at = now()
  from candidate
  where j.id = candidate.id
  returning j.*;
$$;
