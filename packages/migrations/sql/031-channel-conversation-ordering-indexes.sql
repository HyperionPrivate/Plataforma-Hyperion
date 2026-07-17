-- hyperion:no-transaction
-- Online index phase for the stream metadata expanded/backfilled by 030.
-- Every DDL block autocommits independently. Replaying after a process death
-- removes valid or invalid remnants, recreates the expected definitions, and
-- validates PostgreSQL's catalog before the migration ledger can advance.

-- hyperion:statement
drop index concurrently if exists channel_runtime.uq_channel_outbox_stream_sequence;

-- hyperion:statement
create unique index concurrently uq_channel_outbox_stream_sequence
  on channel_runtime.outbox_events(tenant_id, stream_id, stream_sequence)
  where stream_id is not null and stream_sequence is not null;

-- hyperion:statement
drop index concurrently if exists channel_runtime.ix_channel_outbox_stream_head;

-- hyperion:statement
create index concurrently ix_channel_outbox_stream_head
  on channel_runtime.outbox_events(tenant_id, stream_id, stream_sequence, status)
  where event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2');

-- hyperion:statement
drop index concurrently if exists pulso_iris.uq_pulso_channel_inbox_stream_sequence;

-- hyperion:statement
create unique index concurrently uq_pulso_channel_inbox_stream_sequence
  on pulso_iris.inbox_events(tenant_id, source_service, stream_id, stream_sequence)
  where source_service = 'whatsapp-channel-service'
    and event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
    and stream_id is not null
    and stream_sequence is not null;

-- hyperion:statement
do $$
begin
  if exists (
    select 1
      from (
        values
          (
            'channel_runtime'::text,
            'uq_channel_outbox_stream_sequence'::text,
            true,
            'CREATE UNIQUE INDEX uq_channel_outbox_stream_sequence ON channel_runtime.outbox_events USING btree (tenant_id, stream_id, stream_sequence) WHERE ((stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL))'::text
          ),
          (
            'channel_runtime'::text,
            'ix_channel_outbox_stream_head'::text,
            false,
            'CREATE INDEX ix_channel_outbox_stream_head ON channel_runtime.outbox_events USING btree (tenant_id, stream_id, stream_sequence, status) WHERE (event_type = ANY (ARRAY[''channel.inbound.received.v1''::text, ''channel.inbound.received.v2''::text]))'::text
          ),
          (
            'pulso_iris'::text,
            'uq_pulso_channel_inbox_stream_sequence'::text,
            true,
            'CREATE UNIQUE INDEX uq_pulso_channel_inbox_stream_sequence ON pulso_iris.inbox_events USING btree (tenant_id, source_service, stream_id, stream_sequence) WHERE ((source_service = ''whatsapp-channel-service''::text) AND (event_type = ANY (ARRAY[''channel.inbound.received.v1''::text, ''channel.inbound.received.v2''::text])) AND (stream_id IS NOT NULL) AND (stream_sequence IS NOT NULL))'::text
          )
      ) as expected(schema_name, index_name, must_be_unique, index_definition)
      left join pg_catalog.pg_namespace index_namespace
        on index_namespace.nspname = expected.schema_name
      left join pg_catalog.pg_class index_class
        on index_class.relnamespace = index_namespace.oid
       and index_class.relname = expected.index_name
      left join pg_catalog.pg_index index_info
        on index_info.indexrelid = index_class.oid
     where index_info.indexrelid is null
        or not index_info.indisvalid
        or not index_info.indisready
        or index_info.indisunique <> expected.must_be_unique
        or pg_catalog.pg_get_indexdef(index_info.indexrelid) <> expected.index_definition
  ) then
    raise exception 'Channel conversation-ordering indexes are missing or invalid';
  end if;
end;
$$;
