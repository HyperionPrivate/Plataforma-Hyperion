-- hyperion:no-transaction
-- Resumable backfill/contract phase for PULSO -> SOFIA ordering. Statements
-- commit independently; every data statement is idempotent so a failed run can
-- continue without reverting the expand/dual-write safety installed by 035.

-- hyperion:statement
set lock_timeout = '5s';

-- hyperion:statement
set statement_timeout = '5min';

-- hyperion:statement
do $$
begin
  if exists (
    select 1
      from pulso_iris.outbox_events event
      left join lateral (
        select case when count(*) = 1 then min(inbox.stream_id::text)::uuid end as stream_id,
               case when count(*) = 1 then min(inbox.stream_sequence) end as stream_sequence
          from pulso_iris.inbox_events inbox
         where inbox.tenant_id = event.tenant_id
           and inbox.source_service = 'whatsapp-channel-service'
           and inbox.processed_at is not null
           and inbox.result ->> 'messageId' = event.aggregate_id::text
           and inbox.result ->> 'conversationId' = event.payload ->> 'conversationId'
      ) source_inbox on true
     where event.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
       and (
         event.payload ->> 'conversationId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or event.payload ->> 'inboundEventId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or event.payload ->> 'threadBindingId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         or coalesce(
              case when event.payload ->> 'sourceStreamId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                then (event.payload ->> 'sourceStreamId')::uuid end,
              event.source_stream_id,
              source_inbox.stream_id
            ) is null
         or coalesce(
              case when event.payload ->> 'sourceStreamSequence' ~ '^[1-9][0-9]*$'
                then (event.payload ->> 'sourceStreamSequence')::bigint end,
              event.source_stream_sequence,
              source_inbox.stream_sequence
            ) is null
         or case
              when event.payload ->> 'threadBindingId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                then coalesce(
                  case when event.payload ->> 'sourceStreamId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                    then (event.payload ->> 'sourceStreamId')::uuid end,
                  event.source_stream_id,
                  source_inbox.stream_id
                ) <> (event.payload ->> 'threadBindingId')::uuid
              else true
            end
       )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot backfill PULSO ordering: an event has no local owner-resolved source position';
  end if;
end;
$$;

-- hyperion:statement
with resolved as materialized (
  select event.id,
         event.tenant_id,
         (event.payload ->> 'conversationId')::uuid as stream_id,
         coalesce(
           case when event.payload ->> 'sourceStreamId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             then (event.payload ->> 'sourceStreamId')::uuid end,
           event.source_stream_id,
           source_inbox.stream_id
         ) as source_stream_id,
         coalesce(
           case when event.payload ->> 'sourceStreamSequence' ~ '^[1-9][0-9]*$'
             then (event.payload ->> 'sourceStreamSequence')::bigint end,
           event.source_stream_sequence,
           source_inbox.stream_sequence
         ) as source_stream_sequence,
         event.created_at,
         event.occurred_at
    from pulso_iris.outbox_events event
    left join lateral (
      select case when count(*) = 1 then min(inbox.stream_id::text)::uuid end as stream_id,
             case when count(*) = 1 then min(inbox.stream_sequence) end as stream_sequence
        from pulso_iris.inbox_events inbox
       where inbox.tenant_id = event.tenant_id
         and inbox.source_service = 'whatsapp-channel-service'
         and inbox.processed_at is not null
         and inbox.result ->> 'messageId' = event.aggregate_id::text
         and inbox.result ->> 'conversationId' = event.payload ->> 'conversationId'
    ) source_inbox on true
   where event.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
     and event.stream_sequence is null
), ordered as materialized (
  select resolved.*,
         row_number() over (
           partition by resolved.tenant_id, resolved.stream_id
           order by resolved.source_stream_sequence, resolved.occurred_at, resolved.created_at, resolved.id
         )::bigint as stream_sequence
    from resolved
)
update pulso_iris.outbox_events event
   set stream_id = ordered.stream_id,
       stream_sequence = ordered.stream_sequence,
       source_stream_id = ordered.source_stream_id,
       source_stream_sequence = ordered.source_stream_sequence,
       updated_at = now()
  from ordered
 where event.id = ordered.id
   and event.stream_sequence is null;

-- hyperion:statement
update pulso_iris.outbox_events
   set payload = payload - 'sourceStreamId' - 'sourceStreamSequence',
       updated_at = now()
 where event_type = 'pulso.message.received.v1'
   and (payload ? 'sourceStreamId' or payload ? 'sourceStreamSequence');

-- hyperion:statement
insert into pulso_iris.outbox_event_positions (
  tenant_id, event_id, stream_id, stream_sequence,
  source_stream_id, source_stream_sequence
)
select tenant_id, id, stream_id, stream_sequence,
       source_stream_id, source_stream_sequence
  from pulso_iris.outbox_events
 where event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
on conflict (tenant_id, event_id) do update
set stream_id = excluded.stream_id,
    stream_sequence = excluded.stream_sequence,
    source_stream_id = excluded.source_stream_id,
    source_stream_sequence = excluded.source_stream_sequence;

-- hyperion:statement
insert into pulso_iris.outbox_stream_positions (tenant_id, stream_id, last_sequence)
select tenant_id, stream_id, max(stream_sequence)
  from pulso_iris.outbox_event_positions
 group by tenant_id, stream_id
on conflict (tenant_id, stream_id) do update
set last_sequence = greatest(pulso_iris.outbox_stream_positions.last_sequence, excluded.last_sequence),
    updated_at = now();

-- hyperion:statement
do $$
begin
  if exists (
    select 1
      from pulso_iris.outbox_events event
     where event.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
       and (event.stream_id is null or event.stream_sequence is null
            or event.source_stream_id is null or event.source_stream_sequence is null)
  ) then
    raise exception 'PULSO outbox ordering backfill is incomplete';
  end if;

  if exists (
    select 1
      from pulso_iris.outbox_events published
     where published.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
       and published.status = 'published'
       and exists (
         select 1
           from pulso_iris.outbox_events predecessor
          where predecessor.tenant_id = published.tenant_id
            and predecessor.stream_id = published.stream_id
            and predecessor.stream_sequence < published.stream_sequence
            and predecessor.status <> 'published'
       )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot establish PULSO ordering: published history is not a contiguous prefix';
  end if;
end;
$$;

-- hyperion:statement
update pulso_iris.outbox_events candidate
   set next_attempt_at = 'infinity'::timestamptz, updated_at = now()
 where candidate.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
   and candidate.status in ('queued', 'retry_scheduled')
   and exists (
     select 1
       from pulso_iris.outbox_events predecessor
      where predecessor.tenant_id = candidate.tenant_id
        and predecessor.stream_id = candidate.stream_id
        and predecessor.stream_sequence < candidate.stream_sequence
        and predecessor.status <> 'published'
   );

-- hyperion:statement
update pulso_iris.outbox_events candidate
   set next_attempt_at = now(), updated_at = now()
 where candidate.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
   and candidate.status in ('queued', 'retry_scheduled')
   and candidate.next_attempt_at = 'infinity'::timestamptz
   and not exists (
     select 1
       from pulso_iris.outbox_events predecessor
      where predecessor.tenant_id = candidate.tenant_id
        and predecessor.stream_id = candidate.stream_id
        and predecessor.stream_sequence < candidate.stream_sequence
        and predecessor.status <> 'published'
   );

-- hyperion:statement
update agent_runtime.inbox_events inbox
   set stream_id = position.stream_id,
       stream_sequence = position.stream_sequence,
       source_stream_id = position.source_stream_id,
       source_stream_sequence = position.source_stream_sequence
  from pulso_iris.outbox_event_positions position
 where position.tenant_id = inbox.tenant_id
   and position.event_id = inbox.event_id
   and inbox.source_service in ('pulso-core', 'pulso-iris-service')
   and inbox.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
   and inbox.stream_sequence is null;

-- hyperion:statement
do $$
begin
  if exists (
    select 1
      from agent_runtime.inbox_events inbox
     where inbox.source_service in ('pulso-core', 'pulso-iris-service')
       and inbox.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
       and (inbox.stream_id is null or inbox.stream_sequence is null
            or inbox.source_stream_id is null or inbox.source_stream_sequence is null)
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot backfill SOFIA inbox ordering: an event has no producer ledger position';
  end if;

  if exists (
    select 1
      from (
        select inbox.tenant_id, inbox.stream_id, inbox.stream_sequence,
               row_number() over (
                 partition by inbox.tenant_id, inbox.stream_id
                 order by inbox.stream_sequence
               ) as contiguous_rank
          from agent_runtime.inbox_events inbox
         where inbox.source_service in ('pulso-core', 'pulso-iris-service')
           and inbox.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
           and inbox.processed_at is not null
      ) processed
     where processed.stream_sequence <> processed.contiguous_rank
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot establish SOFIA checkpoint: processed inbox history is not a contiguous prefix';
  end if;
end;
$$;

-- hyperion:statement
insert into agent_runtime.pulso_stream_positions (tenant_id, stream_id, last_sequence)
select tenant_id, stream_id, max(stream_sequence)
  from agent_runtime.inbox_events
 where source_service in ('pulso-core', 'pulso-iris-service')
   and event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
   and processed_at is not null
 group by tenant_id, stream_id
on conflict (tenant_id, stream_id) do update
set last_sequence = greatest(agent_runtime.pulso_stream_positions.last_sequence, excluded.last_sequence),
    updated_at = now();

-- hyperion:statement
update agent_runtime.jobs job
   set stream_id = inbox.stream_id,
       stream_sequence = inbox.stream_sequence,
       ordering_source = 'pulso_durable'
  from agent_runtime.inbox_events inbox
 where inbox.tenant_id = job.tenant_id
   and inbox.result ->> 'jobId' = job.id::text
   and inbox.stream_id = job.conversation_id
   and job.stream_sequence is null;

-- hyperion:statement
with unmapped as materialized (
  select job.id,
         row_number() over (
           partition by job.tenant_id, job.conversation_id
           order by job.created_at, job.id
         )::bigint as allocated_sequence
    from agent_runtime.jobs job
   where job.stream_sequence is null
)
update agent_runtime.jobs job
   set stream_id = job.conversation_id,
       stream_sequence = unmapped.allocated_sequence,
       ordering_source = 'legacy_polling_allocator'
  from unmapped
 where job.id = unmapped.id
   and job.stream_sequence is null;

-- hyperion:statement
do $$
begin
  if exists (
    select 1
      from agent_runtime.jobs job
     where job.stream_id is null or job.stream_sequence is null or job.ordering_source is null
  ) then
    raise exception 'SOFIA job ordering backfill is incomplete';
  end if;

  if exists (
    select 1
      from (
        select job.tenant_id, job.stream_id, job.stream_sequence,
               row_number() over (
                 partition by job.tenant_id, job.stream_id
                 order by job.stream_sequence
               ) as contiguous_rank
          from agent_runtime.jobs job
      ) positioned
     where positioned.stream_sequence <> positioned.contiguous_rank
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot establish SOFIA job ordering: stream positions are duplicated or non-contiguous';
  end if;

  if exists (
    select 1
      from agent_runtime.jobs completed
     where completed.status = 'completed'
       and exists (
         select 1
           from agent_runtime.jobs predecessor
          where predecessor.tenant_id = completed.tenant_id
            and predecessor.stream_id = completed.stream_id
            and predecessor.stream_sequence < completed.stream_sequence
            and predecessor.status <> 'completed'
       )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot establish SOFIA job ordering: completed history is not a contiguous prefix';
  end if;
end;
$$;

-- hyperion:statement
insert into agent_runtime.job_stream_positions (tenant_id, stream_id, last_sequence)
select tenant_id, stream_id, max(stream_sequence)
  from agent_runtime.jobs
 group by tenant_id, stream_id
on conflict (tenant_id, stream_id) do update
set last_sequence = greatest(agent_runtime.job_stream_positions.last_sequence, excluded.last_sequence),
    updated_at = now();

-- hyperion:statement
update agent_runtime.jobs candidate
   set next_attempt_at = 'infinity'::timestamptz, updated_at = now()
 where candidate.status in ('queued', 'retry_scheduled')
   and exists (
     select 1
       from agent_runtime.jobs predecessor
      where predecessor.tenant_id = candidate.tenant_id
        and predecessor.stream_id = candidate.stream_id
        and predecessor.stream_sequence < candidate.stream_sequence
        and predecessor.status <> 'completed'
   );

-- hyperion:statement
update agent_runtime.jobs candidate
   set next_attempt_at = now(), updated_at = now()
 where candidate.status in ('queued', 'retry_scheduled')
   and candidate.next_attempt_at = 'infinity'::timestamptz
   and not exists (
     select 1
       from agent_runtime.jobs predecessor
      where predecessor.tenant_id = candidate.tenant_id
        and predecessor.stream_id = candidate.stream_id
        and predecessor.stream_sequence < candidate.stream_sequence
        and predecessor.status <> 'completed'
   );

-- hyperion:statement
alter table pulso_iris.outbox_events
  validate constraint ck_pulso_outbox_message_stream_position;

-- hyperion:statement
alter table agent_runtime.inbox_events
  validate constraint ck_agent_pulso_inbox_stream_position;

-- hyperion:statement
alter table agent_runtime.jobs
  validate constraint ck_agent_jobs_ordered_stream;

-- hyperion:statement
alter table agent_runtime.jobs
  alter column stream_id set not null,
  alter column stream_sequence set not null,
  alter column ordering_source set not null;

-- hyperion:statement
reset statement_timeout;

-- hyperion:statement
reset lock_timeout;
