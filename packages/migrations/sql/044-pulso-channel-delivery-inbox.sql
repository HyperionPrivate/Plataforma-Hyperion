-- Expand phase for the durable Channel -> PULSO delivery projection. The
-- constraint is installed as NOT VALID so new delivery events are protected
-- immediately without scanning historical inbox rows while holding the DDL
-- lock. Historical validation is deferred to 046.

do $migration$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'pulso_iris'
       and table_name = 'inbox_events'
       and column_name = 'stream_id'
       and udt_schema = 'pg_catalog'
       and udt_name = 'uuid'
  ) or not exists (
    select 1
      from information_schema.columns
     where table_schema = 'pulso_iris'
       and table_name = 'inbox_events'
       and column_name = 'stream_sequence'
       and udt_schema = 'pg_catalog'
       and udt_name = 'int8'
  ) then
    raise exception using
      errcode = '23514',
      message = 'PULSO inbox stream columns are missing or have an incompatible type';
  end if;
end;
$migration$;

alter table pulso_iris.inbox_events
  drop constraint if exists ck_pulso_channel_delivery_inbox_stream_position;

alter table pulso_iris.inbox_events
  add constraint ck_pulso_channel_delivery_inbox_stream_position
    check (
      source_service <> 'whatsapp-channel-service'
      or event_type <> 'channel.delivery.updated.v1'
      or (stream_id is not null and stream_sequence is not null and stream_sequence > 0)
    ) not valid;
