-- Expand/dual-write phase for durable PULSO -> SOFIA conversation ordering.
-- Existing rows remain readable while new rows receive positions atomically.
-- Migration 036 performs resumable backfill/validation and 037 builds indexes.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table pulso_iris.outbox_events
  add column if not exists stream_id uuid,
  add column if not exists stream_sequence bigint,
  add column if not exists source_stream_id uuid,
  add column if not exists source_stream_sequence bigint;

create table if not exists pulso_iris.outbox_stream_positions (
  tenant_id uuid not null,
  stream_id uuid not null,
  last_sequence bigint not null check (last_sequence >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, stream_id)
);

create table if not exists pulso_iris.outbox_event_positions (
  tenant_id uuid not null,
  event_id uuid not null,
  stream_id uuid not null,
  stream_sequence bigint not null check (stream_sequence > 0),
  source_stream_id uuid not null,
  source_stream_sequence bigint not null check (source_stream_sequence > 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, event_id),
  unique (tenant_id, stream_id, stream_sequence),
  unique (tenant_id, source_stream_id, source_stream_sequence)
);

revoke all privileges on table pulso_iris.outbox_stream_positions from public;
revoke all privileges on table pulso_iris.outbox_event_positions from public;
grant select, insert, update, delete on table pulso_iris.outbox_stream_positions to hyperion_pulso;
grant select, insert, update, delete on table pulso_iris.outbox_event_positions to hyperion_pulso;

create or replace function pulso_iris.prepare_ordered_message_outbox_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pulso_iris
as $$
declare
  existing_event pulso_iris.outbox_events%rowtype;
  resolved_stream_id uuid;
  resolved_source_stream_id uuid;
  resolved_source_sequence bigint;
  current_sequence bigint;
  allocated_sequence bigint;
begin
  if new.event_type not in ('pulso.message.received.v1', 'pulso.message.received.v2') then
    return new;
  end if;

  if new.payload ->> 'conversationId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or new.payload ->> 'inboundEventId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or new.payload ->> 'threadBindingId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '23514', message = 'PULSO message outbox contract is missing stable identifiers';
  end if;
  resolved_stream_id := (new.payload ->> 'conversationId')::uuid;

  select candidate.*
    into existing_event
    from pulso_iris.outbox_events candidate
   where candidate.tenant_id = new.tenant_id
     and candidate.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
     and candidate.aggregate_id = new.aggregate_id
   limit 1;
  if found then
    if existing_event.event_type <> new.event_type then
      raise exception using errcode = '23505', message = 'PULSO message aggregate already uses another contract version';
    end if;
    new.stream_id := existing_event.stream_id;
    new.stream_sequence := existing_event.stream_sequence;
    new.source_stream_id := existing_event.source_stream_id;
    new.source_stream_sequence := existing_event.source_stream_sequence;
    if new.event_type = 'pulso.message.received.v1' then
      new.payload := new.payload - 'sourceStreamId' - 'sourceStreamSequence';
    end if;
    return new;
  end if;

  if new.source_stream_id is not null and new.source_stream_sequence is not null then
    resolved_source_stream_id := new.source_stream_id;
    resolved_source_sequence := new.source_stream_sequence;
  elsif new.payload ->> 'sourceStreamId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and new.payload ->> 'sourceStreamSequence' ~ '^[1-9][0-9]*$' then
    resolved_source_stream_id := (new.payload ->> 'sourceStreamId')::uuid;
    resolved_source_sequence := (new.payload ->> 'sourceStreamSequence')::bigint;
  else
    raise exception using
      errcode = '23514',
      message = 'PULSO message outbox requires an owner-resolved Channel source position';
  end if;

  if resolved_source_stream_id <> (new.payload ->> 'threadBindingId')::uuid
     or resolved_source_sequence <= 0 then
    raise exception using errcode = '23514', message = 'PULSO message source position conflicts with its thread binding';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || resolved_stream_id::text, 0)
  );

  if exists (
    select 1
      from pulso_iris.outbox_event_positions position
     where position.tenant_id = new.tenant_id
       and position.source_stream_id = resolved_source_stream_id
       and position.source_stream_sequence = resolved_source_sequence
  ) then
    raise exception using errcode = '23505', message = 'PULSO source position is already mapped';
  end if;

  select position.last_sequence
    into current_sequence
    from pulso_iris.outbox_stream_positions position
   where position.tenant_id = new.tenant_id
     and position.stream_id = resolved_stream_id
   for update;
  if not found then
    select count(*)::bigint
      into current_sequence
      from pulso_iris.outbox_events candidate
     where candidate.tenant_id = new.tenant_id
       and candidate.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
       and case
             when candidate.stream_id is not null then candidate.stream_id
             when candidate.payload ->> 'conversationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               then (candidate.payload ->> 'conversationId')::uuid
           end = resolved_stream_id;
  end if;
  allocated_sequence := coalesce(current_sequence, 0) + 1;

  insert into pulso_iris.outbox_stream_positions (tenant_id, stream_id, last_sequence)
  values (new.tenant_id, resolved_stream_id, allocated_sequence)
  on conflict (tenant_id, stream_id) do update
  set last_sequence = excluded.last_sequence,
      updated_at = now();

  new.stream_id := resolved_stream_id;
  new.stream_sequence := allocated_sequence;
  new.source_stream_id := resolved_source_stream_id;
  new.source_stream_sequence := resolved_source_sequence;
  if new.event_type = 'pulso.message.received.v1' then
    new.payload := new.payload - 'sourceStreamId' - 'sourceStreamSequence';
  end if;

  insert into pulso_iris.outbox_event_positions (
    tenant_id, event_id, stream_id, stream_sequence,
    source_stream_id, source_stream_sequence
  ) values (
    new.tenant_id, new.id, new.stream_id, new.stream_sequence,
    new.source_stream_id, new.source_stream_sequence
  );

  if exists (
    select 1
      from pulso_iris.outbox_events predecessor
     where predecessor.tenant_id = new.tenant_id
       and case
             when predecessor.stream_id is not null then predecessor.stream_id
             when predecessor.payload ->> 'conversationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               then (predecessor.payload ->> 'conversationId')::uuid
           end = new.stream_id
       and predecessor.status <> 'published'
  ) then
    new.next_attempt_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;

create or replace function pulso_iris.release_next_message_outbox_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pulso_iris
as $$
begin
  if new.status = 'published'
     and old.status <> 'published'
     and new.stream_id is not null
     and new.stream_sequence is not null then
    update pulso_iris.outbox_events successor
       set next_attempt_at = now(), updated_at = now()
     where successor.tenant_id = new.tenant_id
       and successor.stream_id = new.stream_id
       and successor.stream_sequence = new.stream_sequence + 1
       and successor.status in ('queued', 'retry_scheduled')
       and successor.next_attempt_at = 'infinity'::timestamptz
       and not exists (
         select 1
           from pulso_iris.outbox_events predecessor
          where predecessor.tenant_id = successor.tenant_id
            and predecessor.stream_id = successor.stream_id
            and predecessor.stream_sequence < successor.stream_sequence
            and predecessor.status <> 'published'
       );
  end if;
  return new;
end;
$$;

create or replace function pulso_iris.reject_unpositioned_message_claim()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pulso_iris
as $$
begin
  if new.event_type in ('pulso.message.received.v1', 'pulso.message.received.v2')
     and new.status = 'processing'
     and old.status <> 'processing'
     and (new.stream_id is null or new.stream_sequence is null
          or new.source_stream_id is null or new.source_stream_sequence is null) then
    raise exception using errcode = '55000', message = 'PULSO outbox backfill is incomplete';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pulso_outbox_prepare_ordered_message on pulso_iris.outbox_events;
create trigger trg_pulso_outbox_prepare_ordered_message
before insert on pulso_iris.outbox_events
for each row execute function pulso_iris.prepare_ordered_message_outbox_event();

drop trigger if exists trg_pulso_outbox_release_ordered_message on pulso_iris.outbox_events;
create trigger trg_pulso_outbox_release_ordered_message
after update of status on pulso_iris.outbox_events
for each row execute function pulso_iris.release_next_message_outbox_event();

drop trigger if exists trg_pulso_outbox_reject_unpositioned_claim on pulso_iris.outbox_events;
create trigger trg_pulso_outbox_reject_unpositioned_claim
before update of status on pulso_iris.outbox_events
for each row execute function pulso_iris.reject_unpositioned_message_claim();

alter table pulso_iris.outbox_events
  drop constraint if exists ck_pulso_outbox_message_stream_position,
  add constraint ck_pulso_outbox_message_stream_position check (
    event_type not in ('pulso.message.received.v1', 'pulso.message.received.v2')
    or (
      stream_id is not null and stream_sequence is not null and stream_sequence > 0
      and source_stream_id is not null
      and source_stream_sequence is not null and source_stream_sequence > 0
    )
  ) not valid;

alter table agent_runtime.inbox_events
  add column if not exists stream_id uuid,
  add column if not exists stream_sequence bigint,
  add column if not exists source_stream_id uuid,
  add column if not exists source_stream_sequence bigint;

create table if not exists agent_runtime.pulso_stream_positions (
  tenant_id uuid not null,
  stream_id uuid not null,
  last_sequence bigint not null check (last_sequence >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, stream_id)
);

revoke all privileges on table agent_runtime.pulso_stream_positions from public;
grant select, insert, update, delete on table agent_runtime.pulso_stream_positions to hyperion_sofia;

alter table agent_runtime.inbox_events
  drop constraint if exists ck_agent_pulso_inbox_stream_position,
  add constraint ck_agent_pulso_inbox_stream_position check (
    source_service not in ('pulso-core', 'pulso-iris-service')
    or event_type not in ('pulso.message.received.v1', 'pulso.message.received.v2')
    or (
      stream_id is not null and stream_sequence is not null and stream_sequence > 0
      and source_stream_id is not null
      and source_stream_sequence is not null and source_stream_sequence > 0
    )
  ) not valid;

alter table agent_runtime.jobs
  add column if not exists stream_id uuid,
  add column if not exists stream_sequence bigint,
  add column if not exists ordering_source text;

create table if not exists agent_runtime.job_stream_positions (
  tenant_id uuid not null,
  stream_id uuid not null,
  last_sequence bigint not null check (last_sequence >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, stream_id)
);

revoke all privileges on table agent_runtime.job_stream_positions from public;
grant select, insert, update, delete on table agent_runtime.job_stream_positions to hyperion_sofia;

create or replace function agent_runtime.prepare_ordered_job()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, agent_runtime
as $$
declare
  existing_job agent_runtime.jobs%rowtype;
  current_sequence bigint;
begin
  select candidate.*
    into existing_job
    from agent_runtime.jobs candidate
   where candidate.tenant_id = new.tenant_id
     and candidate.inbound_event_id = new.inbound_event_id;
  if found then
    new.stream_id := existing_job.stream_id;
    new.stream_sequence := existing_job.stream_sequence;
    new.ordering_source := existing_job.ordering_source;
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || new.conversation_id::text, 0)
  );
  select position.last_sequence
    into current_sequence
    from agent_runtime.job_stream_positions position
   where position.tenant_id = new.tenant_id
     and position.stream_id = new.conversation_id
   for update;
  if not found then
    select count(*)::bigint
      into current_sequence
      from agent_runtime.jobs candidate
     where candidate.tenant_id = new.tenant_id
       and candidate.conversation_id = new.conversation_id;
  end if;
  current_sequence := coalesce(current_sequence, 0);

  if new.stream_id is null and new.stream_sequence is null then
    new.stream_id := new.conversation_id;
    new.stream_sequence := current_sequence + 1;
    new.ordering_source := 'legacy_polling_allocator';
  elsif new.stream_id <> new.conversation_id
        or new.stream_sequence is null
        or new.stream_sequence <> current_sequence + 1
        or new.ordering_source <> 'pulso_durable' then
    raise exception using errcode = '23514', message = 'SOFIA job stream position is not the next durable position';
  end if;

  insert into agent_runtime.job_stream_positions (tenant_id, stream_id, last_sequence)
  values (new.tenant_id, new.stream_id, new.stream_sequence)
  on conflict (tenant_id, stream_id) do update
  set last_sequence = excluded.last_sequence,
      updated_at = now();

  if exists (
    select 1
      from agent_runtime.jobs predecessor
     where predecessor.tenant_id = new.tenant_id
       and predecessor.conversation_id = new.conversation_id
       and predecessor.status <> 'completed'
  ) then
    new.next_attempt_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;

create or replace function agent_runtime.release_next_ordered_job()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, agent_runtime
as $$
begin
  if new.status = 'completed'
     and old.status <> 'completed'
     and new.stream_id is not null
     and new.stream_sequence is not null then
    update agent_runtime.jobs successor
       set next_attempt_at = now(), updated_at = now()
     where successor.tenant_id = new.tenant_id
       and successor.stream_id = new.stream_id
       and successor.stream_sequence = new.stream_sequence + 1
       and successor.status in ('queued', 'retry_scheduled')
       and successor.next_attempt_at = 'infinity'::timestamptz
       and not exists (
         select 1
           from agent_runtime.jobs predecessor
          where predecessor.tenant_id = successor.tenant_id
            and predecessor.stream_id = successor.stream_id
            and predecessor.stream_sequence < successor.stream_sequence
            and predecessor.status <> 'completed'
       );
  end if;
  return new;
end;
$$;

create or replace function agent_runtime.reject_unpositioned_job_claim()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, agent_runtime
as $$
begin
  if new.status = 'running'
     and old.status <> 'running'
     and (new.stream_id is null or new.stream_sequence is null or new.ordering_source is null) then
    raise exception using errcode = '55000', message = 'SOFIA job ordering backfill is incomplete';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_agent_jobs_prepare_ordered on agent_runtime.jobs;
create trigger trg_agent_jobs_prepare_ordered
before insert on agent_runtime.jobs
for each row execute function agent_runtime.prepare_ordered_job();

drop trigger if exists trg_agent_jobs_release_ordered on agent_runtime.jobs;
create trigger trg_agent_jobs_release_ordered
after update of status on agent_runtime.jobs
for each row execute function agent_runtime.release_next_ordered_job();

drop trigger if exists trg_agent_jobs_reject_unpositioned_claim on agent_runtime.jobs;
create trigger trg_agent_jobs_reject_unpositioned_claim
before update of status on agent_runtime.jobs
for each row execute function agent_runtime.reject_unpositioned_job_claim();

alter table agent_runtime.jobs
  drop constraint if exists ck_agent_jobs_ordered_stream,
  add constraint ck_agent_jobs_ordered_stream check (
    stream_id = conversation_id
    and stream_sequence > 0
    and ordering_source in ('pulso_durable', 'legacy_polling_allocator')
  ) not valid;

create or replace function agent_runtime.claim_next_job(p_worker_id text)
returns setof agent_runtime.jobs
language sql
volatile
as $$
  with terminalized as (
    update agent_runtime.jobs
       set status = 'dead_letter', locked_at = null, locked_by = null, updated_at = now()
     where status = 'running'
       and locked_at < now() - interval '2 minutes'
       and attempt_count >= max_attempts
    returning id
  ), candidate as (
    select candidate.id
      from agent_runtime.jobs candidate
     where (
         candidate.status in ('queued', 'retry_scheduled')
         or (candidate.status = 'running' and candidate.locked_at < now() - interval '2 minutes')
       )
       and candidate.stream_id is not null
       and candidate.stream_sequence is not null
       and candidate.next_attempt_at <= now()
       and candidate.attempt_count < candidate.max_attempts
       and not exists (
         select 1
           from agent_runtime.jobs predecessor
          where predecessor.tenant_id = candidate.tenant_id
            and predecessor.stream_id = candidate.stream_id
            and predecessor.stream_sequence < candidate.stream_sequence
            and predecessor.status <> 'completed'
       )
     order by candidate.priority desc, candidate.next_attempt_at, candidate.created_at
     for update of candidate skip locked
     limit 1
  )
  update agent_runtime.jobs job
     set status = 'running',
         attempt_count = job.attempt_count + 1,
         locked_at = now(), locked_by = p_worker_id, updated_at = now()
    from candidate
   where job.id = candidate.id
  returning job.*;
$$;

grant execute on function agent_runtime.claim_next_job(text) to hyperion_sofia;

comment on column pulso_iris.outbox_events.stream_id is
  'PULSO conversation UUID emitted as the ordered v2 streamId';
comment on column pulso_iris.outbox_events.stream_sequence is
  'One-based position derived while consuming the ordered Channel source';
comment on column agent_runtime.jobs.stream_sequence is
  'SOFIA execution position; successors remain blocked until predecessors complete';
