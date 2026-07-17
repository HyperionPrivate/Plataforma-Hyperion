-- hyperion:no-transaction
-- Online uniqueness phase for durable Channel delivery positions. Replaying
-- after an interrupted build removes either a valid or invalid remnant before
-- recreating it. The final catalog guard must pass before the runner records
-- this migration in its durable ledger.

-- hyperion:statement
drop index concurrently if exists pulso_iris.uq_pulso_channel_delivery_inbox_stream_sequence;

-- hyperion:statement
create unique index concurrently uq_pulso_channel_delivery_inbox_stream_sequence
  on pulso_iris.inbox_events(tenant_id, source_service, stream_id, stream_sequence)
  where source_service = 'whatsapp-channel-service'
    and event_type = 'channel.delivery.updated.v1';

-- hyperion:statement
do $migration$
begin
  if not exists (
    select 1
      from pg_catalog.pg_class index_class
      join pg_catalog.pg_namespace index_namespace
        on index_namespace.oid = index_class.relnamespace
      join pg_catalog.pg_index index_info
        on index_info.indexrelid = index_class.oid
     where index_namespace.nspname = 'pulso_iris'
       and index_class.relname = 'uq_pulso_channel_delivery_inbox_stream_sequence'
       and index_info.indisunique
       and index_info.indisvalid
       and index_info.indisready
       and pg_catalog.pg_get_indexdef(index_info.indexrelid) =
         'CREATE UNIQUE INDEX uq_pulso_channel_delivery_inbox_stream_sequence ON pulso_iris.inbox_events USING btree (tenant_id, source_service, stream_id, stream_sequence) WHERE ((source_service = ''whatsapp-channel-service''::text) AND (event_type = ''channel.delivery.updated.v1''::text))'
  ) then
    raise exception using
      errcode = '23514',
      message = 'PULSO Channel delivery inbox stream index is missing or invalid';
  end if;
end;
$migration$;
