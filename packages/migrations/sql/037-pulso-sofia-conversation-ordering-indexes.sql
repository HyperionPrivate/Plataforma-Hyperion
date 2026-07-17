-- hyperion:no-transaction
-- Online indexes for the metadata expanded/backfilled by 035 and 036.
-- Each statement autocommits so a failed concurrent build can be removed and
-- rebuilt safely before the migration ledger advances.

-- hyperion:statement
drop index concurrently if exists pulso_iris.uq_pulso_message_outbox_stream_sequence;

-- hyperion:statement
create unique index concurrently uq_pulso_message_outbox_stream_sequence
  on pulso_iris.outbox_events(tenant_id, stream_id, stream_sequence)
  where event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
    and stream_id is not null
    and stream_sequence is not null;

-- hyperion:statement
drop index concurrently if exists pulso_iris.uq_pulso_message_outbox_source_sequence;

-- hyperion:statement
create unique index concurrently uq_pulso_message_outbox_source_sequence
  on pulso_iris.outbox_events(tenant_id, source_stream_id, source_stream_sequence)
  where event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
    and source_stream_id is not null
    and source_stream_sequence is not null;

-- hyperion:statement
drop index concurrently if exists pulso_iris.ix_pulso_message_outbox_stream_head;

-- hyperion:statement
create index concurrently ix_pulso_message_outbox_stream_head
  on pulso_iris.outbox_events(tenant_id, stream_id, stream_sequence, status, next_attempt_at)
  where event_type in ('pulso.message.received.v1', 'pulso.message.received.v2');

-- hyperion:statement
drop index concurrently if exists agent_runtime.uq_agent_pulso_inbox_stream_sequence;

-- hyperion:statement
create unique index concurrently uq_agent_pulso_inbox_stream_sequence
  on agent_runtime.inbox_events(tenant_id, stream_id, stream_sequence)
  where source_service in ('pulso-core', 'pulso-iris-service')
    and event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
    and stream_id is not null
    and stream_sequence is not null;

-- hyperion:statement
drop index concurrently if exists agent_runtime.uq_agent_pulso_inbox_source_sequence;

-- hyperion:statement
create unique index concurrently uq_agent_pulso_inbox_source_sequence
  on agent_runtime.inbox_events(tenant_id, source_stream_id, source_stream_sequence)
  where source_service in ('pulso-core', 'pulso-iris-service')
    and event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
    and source_stream_id is not null
    and source_stream_sequence is not null;

-- hyperion:statement
drop index concurrently if exists agent_runtime.uq_agent_job_stream_sequence;

-- hyperion:statement
create unique index concurrently uq_agent_job_stream_sequence
  on agent_runtime.jobs(tenant_id, stream_id, stream_sequence);

-- hyperion:statement
drop index concurrently if exists agent_runtime.ix_agent_job_stream_head;

-- hyperion:statement
create index concurrently ix_agent_job_stream_head
  on agent_runtime.jobs(tenant_id, stream_id, stream_sequence, status, next_attempt_at);

-- hyperion:statement
do $$
begin
  if (
    select count(*)
      from (
        values
          ('pulso_iris'::text, 'uq_pulso_message_outbox_stream_sequence'::text, true),
          ('pulso_iris'::text, 'uq_pulso_message_outbox_source_sequence'::text, true),
          ('pulso_iris'::text, 'ix_pulso_message_outbox_stream_head'::text, false),
          ('agent_runtime'::text, 'uq_agent_pulso_inbox_stream_sequence'::text, true),
          ('agent_runtime'::text, 'uq_agent_pulso_inbox_source_sequence'::text, true),
          ('agent_runtime'::text, 'uq_agent_job_stream_sequence'::text, true),
          ('agent_runtime'::text, 'ix_agent_job_stream_head'::text, false)
      ) expected(schema_name, index_name, must_be_unique)
      join pg_catalog.pg_namespace index_namespace
        on index_namespace.nspname = expected.schema_name
      join pg_catalog.pg_class index_class
        on index_class.relnamespace = index_namespace.oid
       and index_class.relname = expected.index_name
      join pg_catalog.pg_index index_info
        on index_info.indexrelid = index_class.oid
       and index_info.indisvalid
       and index_info.indisready
       and index_info.indisunique = expected.must_be_unique
  ) <> 7 then
    raise exception 'PULSO to SOFIA conversation-ordering indexes are missing or invalid';
  end if;
end;
$$;
