-- hyperion:no-transaction
-- Contract phase for the Channel -> PULSO ordering expansion in 030. Each
-- validation autocommits independently and can be replayed after interruption.

-- hyperion:statement
alter table channel_runtime.outbox_events
  validate constraint ck_channel_outbox_ordered_stream_position;

-- hyperion:statement
alter table pulso_iris.channel_threads
  validate constraint ck_pulso_channel_thread_last_inbound_sequence;

-- hyperion:statement
do $migration$
begin
  if exists (
    select 1
      from pg_constraint
     where conrelid in (
             'channel_runtime.outbox_events'::regclass,
             'pulso_iris.channel_threads'::regclass
           )
       and conname in (
             'ck_channel_outbox_ordered_stream_position',
             'ck_pulso_channel_thread_last_inbound_sequence'
           )
       and not convalidated
  ) or (
    select count(*)
      from pg_constraint
     where conrelid in (
             'channel_runtime.outbox_events'::regclass,
             'pulso_iris.channel_threads'::regclass
           )
       and conname in (
             'ck_channel_outbox_ordered_stream_position',
             'ck_pulso_channel_thread_last_inbound_sequence'
           )
       and contype = 'c'
       and convalidated
  ) <> 2 then
    raise exception using
      errcode = '23514',
      message = 'Channel ordering constraints are missing or unvalidated';
  end if;
end;
$migration$;
