-- Contract phase for the durable Channel delivery inbox position expanded in
-- 044. The runner applies finite lock/statement budgets to both the validation
-- scan and the catalog assertion in this transaction.

alter table pulso_iris.inbox_events
  validate constraint ck_pulso_channel_delivery_inbox_stream_position;

do $migration$
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint constraint_info
     where constraint_info.conrelid = 'pulso_iris.inbox_events'::regclass
       and constraint_info.conname = 'ck_pulso_channel_delivery_inbox_stream_position'
       and constraint_info.contype = 'c'
       and constraint_info.convalidated
  ) or not exists (
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
      message = 'PULSO Channel delivery inbox contract is missing or unvalidated';
  end if;
end;
$migration$;
