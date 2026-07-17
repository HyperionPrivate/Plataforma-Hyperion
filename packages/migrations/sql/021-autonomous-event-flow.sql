-- hyperion:no-transaction
-- Primer flujo durable entre contextos autonomos:
-- Channel -> PULSO -> SOFIA -> Audit.
--
-- Cada bloque se confirma por separado. Asi, las esperas por DDL quedan
-- acotadas por el runner y los indices sobre tablas existentes se construyen
-- sin bloquear escrituras durante toda su duracion. El ultimo bloque valida
-- el contrato completo antes de que el runner escriba el ledger.

-- hyperion:statement
create schema if not exists audit_runtime;

-- hyperion:statement
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

-- hyperion:statement
drop index concurrently if exists channel_runtime.ix_channel_outbox_claim;

-- hyperion:statement
create index concurrently ix_channel_outbox_claim
  on channel_runtime.outbox_events(status, next_attempt_at, created_at)
  where status in ('queued', 'processing', 'retry_scheduled');

-- hyperion:statement
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

-- hyperion:statement
drop index concurrently if exists pulso_iris.ix_pulso_inbox_tenant_received;

-- hyperion:statement
create index concurrently ix_pulso_inbox_tenant_received
  on pulso_iris.inbox_events(tenant_id, received_at desc);

-- hyperion:statement
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

-- hyperion:statement
drop index concurrently if exists pulso_iris.ix_pulso_channel_threads_conversation;

-- hyperion:statement
create index concurrently ix_pulso_channel_threads_conversation
  on pulso_iris.channel_threads(tenant_id, conversation_id)
  where conversation_id is not null;

-- hyperion:statement
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

-- hyperion:statement
drop index concurrently if exists pulso_iris.ix_pulso_outbox_claim;

-- hyperion:statement
create index concurrently ix_pulso_outbox_claim
  on pulso_iris.outbox_events(status, next_attempt_at, created_at)
  where status in ('queued', 'processing', 'retry_scheduled');

-- hyperion:statement
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

-- hyperion:statement
drop index concurrently if exists agent_runtime.ix_agent_inbox_tenant_received;

-- hyperion:statement
create index concurrently ix_agent_inbox_tenant_received
  on agent_runtime.inbox_events(tenant_id, received_at desc);

-- hyperion:statement
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

-- hyperion:statement
drop index concurrently if exists agent_runtime.ix_agent_outbox_claim;

-- hyperion:statement
create index concurrently ix_agent_outbox_claim
  on agent_runtime.outbox_events(status, next_attempt_at, created_at)
  where status in ('queued', 'processing', 'retry_scheduled');

-- hyperion:statement
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

-- hyperion:statement
drop index concurrently if exists audit_runtime.ix_audit_inbox_tenant_received;

-- hyperion:statement
create index concurrently ix_audit_inbox_tenant_received
  on audit_runtime.inbox_events(tenant_id, received_at desc);

-- hyperion:statement
alter table platform.audit_events
  add column if not exists source_event_id uuid;

-- hyperion:statement
drop index concurrently if exists platform.uq_audit_events_source_event;

-- hyperion:statement
create unique index concurrently uq_audit_events_source_event
  on platform.audit_events(source_event_id)
  where source_event_id is not null;

-- Los nuevos consumidores conservan los UUID como referencias externas. Estas
-- restricciones antiguas impedian ejecutar el flujo con bases logicas separadas.
-- hyperion:statement
alter table channel_runtime.thread_bindings
  drop constraint if exists fk_channel_thread_patient_tenant,
  drop constraint if exists fk_channel_thread_conversation_tenant;

-- hyperion:statement
alter table channel_runtime.inbound_events
  drop constraint if exists fk_channel_inbound_message_tenant;

-- hyperion:statement
alter table channel_runtime.outbound_messages
  drop constraint if exists fk_channel_outbound_message_tenant;

-- hyperion:statement
alter table agent_runtime.jobs
  drop constraint if exists fk_agent_jobs_conversation_tenant,
  drop constraint if exists fk_agent_jobs_inbound_event_tenant;

-- Esta validacion tambien es la puerta de compatibilidad para el checksum
-- atomico historico de 021. Los hashes cubren todas las columnas y restricciones
-- originales; se permiten solamente columnas/constraints aditivos posteriores.
-- hyperion:statement
do $migration$
declare
  target record;
  index_target record;
  actual_count integer;
  actual_hash text;
  expected_column_hash text;
  actual_index record;
begin
  for target in
    select *
      from (values
        ('agent_runtime', 'inbox_events', 10,
         '6da0d0b1fa6909344fafeb8ce8e41b5eea266e8f46c6767535de81e68d504796', null::text,
         array['inbox_events_event_type_check','inbox_events_event_version_check','inbox_events_payload_hash_check','inbox_events_pkey','inbox_events_result_check','inbox_events_source_service_check'],
         '5d40077d59726ba7ff965870cb22d23e2ad7f3a75e933a1b5f82160f640ed15f'),
        ('agent_runtime', 'outbox_events', 18,
         '58d1da777a2bc83e8c493a2b4b9339eb3b08400fd9d44a831f7922a3354483b0', null::text,
         array['outbox_events_aggregate_type_check','outbox_events_attempt_count_check','outbox_events_event_type_check','outbox_events_event_version_check','outbox_events_max_attempts_check','outbox_events_payload_check','outbox_events_pkey','outbox_events_status_check','outbox_events_tenant_id_event_type_aggregate_id_key'],
         '4256389a68d230459ece09947d6d6481bef813995d0a552af2ba61c909d241ea'),
        ('audit_runtime', 'inbox_events', 8,
         '77c04941a7fa210e10443b9c3f9c7c5c6ac1f69887c59f8d7d0d4c6d921c44da',
         'eac11e8b280bbb25920186f725ce21b82ba11f63316203b74235cd5b2bdb76fc',
         array['inbox_events_event_type_check','inbox_events_event_version_check','inbox_events_payload_hash_check','inbox_events_pkey','inbox_events_source_service_check'],
         'fbcd55cf6b1aa04cc7fcad7e9245d7dea037bf1ab56d0292e2eed61d91703c50'),
        ('channel_runtime', 'outbox_events', 18,
         '58d1da777a2bc83e8c493a2b4b9339eb3b08400fd9d44a831f7922a3354483b0', null::text,
         array['outbox_events_aggregate_type_check','outbox_events_attempt_count_check','outbox_events_event_type_check','outbox_events_event_version_check','outbox_events_max_attempts_check','outbox_events_payload_check','outbox_events_pkey','outbox_events_status_check','outbox_events_tenant_id_event_type_aggregate_id_key'],
         '4256389a68d230459ece09947d6d6481bef813995d0a552af2ba61c909d241ea'),
        ('pulso_iris', 'channel_threads', 11,
         'f2a6e8ad3b22c99398a8f79b9ba43e2468c84ae3d4bd0a9d81cd588fa4ae1b58', null::text,
         array['channel_threads_external_thread_id_check','channel_threads_phone_e164_hash_check','channel_threads_phone_masked_check','channel_threads_pkey','channel_threads_provider_check','channel_threads_tenant_id_provider_external_thread_id_key','fk_pulso_channel_thread_conversation','fk_pulso_channel_thread_patient'],
         '134bc51da3758e81824712f40d719292d3d9af9a0a933a3cf04200f7463c79a0'),
        ('pulso_iris', 'inbox_events', 10,
         '6da0d0b1fa6909344fafeb8ce8e41b5eea266e8f46c6767535de81e68d504796', null::text,
         array['inbox_events_event_type_check','inbox_events_event_version_check','inbox_events_payload_hash_check','inbox_events_pkey','inbox_events_result_check','inbox_events_source_service_check'],
         '5d40077d59726ba7ff965870cb22d23e2ad7f3a75e933a1b5f82160f640ed15f'),
        ('pulso_iris', 'outbox_events', 18,
         '58d1da777a2bc83e8c493a2b4b9339eb3b08400fd9d44a831f7922a3354483b0', null::text,
         array['outbox_events_aggregate_type_check','outbox_events_attempt_count_check','outbox_events_event_type_check','outbox_events_event_version_check','outbox_events_max_attempts_check','outbox_events_payload_check','outbox_events_pkey','outbox_events_status_check','outbox_events_tenant_id_event_type_aggregate_id_key'],
         '4256389a68d230459ece09947d6d6481bef813995d0a552af2ba61c909d241ea')
      ) as expected(
        schema_name, table_name, original_columns, column_hash,
        post_audit_provenance_column_hash, constraint_names, constraint_hash
      )
  loop
    select count(*)::integer,
           encode(digest(string_agg(
             format('%s|%s|%s|%s|%s|%s|%s|%s', attribute.attnum, attribute.attname,
                    format_type(attribute.atttypid, attribute.atttypmod),
                    attribute.attnotnull, attribute.attidentity, attribute.attgenerated,
                    case when attribute.attcollation = 0 then '<none>'
                         else attribute.attcollation::regcollation::text end,
                    coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '<null>')),
             E'\n' order by attribute.attnum
           ), 'sha256'), 'hex')
      into actual_count, actual_hash
      from pg_catalog.pg_attribute attribute
      join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      left join pg_catalog.pg_attrdef default_value
        on default_value.adrelid = attribute.attrelid
       and default_value.adnum = attribute.attnum
     where namespace.nspname = target.schema_name
       and relation.relname = target.table_name
       and relation.relkind = 'r'
       and attribute.attnum between 1 and target.original_columns
       and not attribute.attisdropped;

    expected_column_hash := target.column_hash;
    if target.post_audit_provenance_column_hash is not null
       and exists (
         select 1 from platform.schema_migrations
          where name = '026-audit-source-provenance.sql'
       ) then
      expected_column_hash := target.post_audit_provenance_column_hash;
    end if;

    if actual_count <> target.original_columns or actual_hash is distinct from expected_column_hash then
      raise exception '021 column contract is incomplete for %.%', target.schema_name, target.table_name;
    end if;

    select count(*)::integer,
           encode(digest(string_agg(
             format('%s|%s|%s|%s', constraint_info.conname, constraint_info.contype,
                    constraint_info.convalidated,
                    pg_get_constraintdef(constraint_info.oid, true)),
             E'\n' order by constraint_info.conname
           ), 'sha256'), 'hex')
      into actual_count, actual_hash
      from pg_catalog.pg_constraint constraint_info
      join pg_catalog.pg_class relation on relation.oid = constraint_info.conrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = target.schema_name
       and relation.relname = target.table_name
       and constraint_info.conname = any(target.constraint_names);

    if actual_count <> cardinality(target.constraint_names)
       or actual_hash is distinct from target.constraint_hash then
      raise exception '021 constraint contract is incomplete for %.%', target.schema_name, target.table_name;
    end if;

    if exists (
      select 1
        from pg_catalog.pg_constraint constraint_info
        left join pg_catalog.pg_index supporting_index
          on supporting_index.indexrelid = constraint_info.conindid
       where constraint_info.conrelid = format('%I.%I', target.schema_name, target.table_name)::regclass
         and constraint_info.conname = any(target.constraint_names)
         and constraint_info.conindid <> 0
         and (supporting_index.indexrelid is null
              or not supporting_index.indisvalid
              or not supporting_index.indisready)
    ) then
      raise exception '021 supporting constraint index is incomplete for %.%',
        target.schema_name, target.table_name;
    end if;
  end loop;

  for index_target in
    select *
      from (values
        ('agent_runtime', 'ix_agent_inbox_tenant_received', false,
         'CREATE INDEX ix_agent_inbox_tenant_received ON agent_runtime.inbox_events USING btree (tenant_id, received_at DESC)'),
        ('agent_runtime', 'ix_agent_outbox_claim', false,
         'CREATE INDEX ix_agent_outbox_claim ON agent_runtime.outbox_events USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY[''queued''::text, ''processing''::text, ''retry_scheduled''::text]))'),
        ('audit_runtime', 'ix_audit_inbox_tenant_received', false,
         'CREATE INDEX ix_audit_inbox_tenant_received ON audit_runtime.inbox_events USING btree (tenant_id, received_at DESC)'),
        ('channel_runtime', 'ix_channel_outbox_claim', false,
         'CREATE INDEX ix_channel_outbox_claim ON channel_runtime.outbox_events USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY[''queued''::text, ''processing''::text, ''retry_scheduled''::text]))'),
        ('platform', 'uq_audit_events_source_event', true,
         'CREATE UNIQUE INDEX uq_audit_events_source_event ON platform.audit_events USING btree (source_event_id) WHERE (source_event_id IS NOT NULL)'),
        ('pulso_iris', 'ix_pulso_channel_threads_conversation', false,
         'CREATE INDEX ix_pulso_channel_threads_conversation ON pulso_iris.channel_threads USING btree (tenant_id, conversation_id) WHERE (conversation_id IS NOT NULL)'),
        ('pulso_iris', 'ix_pulso_inbox_tenant_received', false,
         'CREATE INDEX ix_pulso_inbox_tenant_received ON pulso_iris.inbox_events USING btree (tenant_id, received_at DESC)'),
        ('pulso_iris', 'ix_pulso_outbox_claim', false,
         'CREATE INDEX ix_pulso_outbox_claim ON pulso_iris.outbox_events USING btree (status, next_attempt_at, created_at) WHERE (status = ANY (ARRAY[''queued''::text, ''processing''::text, ''retry_scheduled''::text]))')
      ) as expected(schema_name, index_name, is_unique, definition)
  loop
    select index_info.indisunique as is_unique,
           index_info.indisvalid as is_valid,
           index_info.indisready as is_ready,
           pg_get_indexdef(index_info.indexrelid) as definition
      into actual_index
      from pg_catalog.pg_class index_class
      join pg_catalog.pg_namespace namespace on namespace.oid = index_class.relnamespace
      join pg_catalog.pg_index index_info on index_info.indexrelid = index_class.oid
     where namespace.nspname = index_target.schema_name
       and index_class.relname = index_target.index_name;

    if not found
       or actual_index.is_unique is distinct from index_target.is_unique
       or not actual_index.is_valid
       or not actual_index.is_ready
       or actual_index.definition is distinct from index_target.definition then
      raise exception '021 index contract is incomplete for %.%',
        index_target.schema_name, index_target.index_name;
    end if;
  end loop;

  if not exists (
    select 1
      from pg_catalog.pg_attribute attribute
     where attribute.attrelid = 'platform.audit_events'::regclass
       and attribute.attname = 'source_event_id'
       and not attribute.attisdropped
       and format_type(attribute.atttypid, attribute.atttypmod) = 'uuid'
       and not attribute.attnotnull
       and not exists (
         select 1
           from pg_catalog.pg_attrdef default_value
          where default_value.adrelid = attribute.attrelid
            and default_value.adnum = attribute.attnum
       )
  ) then
    raise exception '021 audit source_event_id column contract is incomplete';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_constraint constraint_info
     where constraint_info.conname in (
       'fk_channel_thread_patient_tenant',
       'fk_channel_thread_conversation_tenant',
       'fk_channel_inbound_message_tenant',
       'fk_channel_outbound_message_tenant',
       'fk_agent_jobs_conversation_tenant',
       'fk_agent_jobs_inbound_event_tenant'
     )
       and constraint_info.conrelid in (
         'channel_runtime.thread_bindings'::regclass,
         'channel_runtime.inbound_events'::regclass,
         'channel_runtime.outbound_messages'::regclass,
         'agent_runtime.jobs'::regclass
       )
  ) then
    raise exception '021 cross-service foreign-key fence is incomplete';
  end if;
end;
$migration$;
