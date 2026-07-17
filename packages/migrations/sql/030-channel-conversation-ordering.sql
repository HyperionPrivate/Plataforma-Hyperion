-- hyperion:no-transaction
-- Durable per-conversation ordering for Channel -> PULSO.
--
-- stream_id is the Channel-owned thread binding UUID. stream_sequence is
-- allocated while holding a transaction-scoped advisory lock for that tenant
-- and stream. Legacy v1 envelopes remain strict and omit the position; v2
-- envelopes carry it and consumers enforce contiguous delivery.

-- Each block is idempotent and autocommitted. Roles are held at NOLOGIN by the
-- earlier migration fence, so a partial run can be replayed without exposing a
-- half-migrated contract to service workloads.
-- hyperion:statement
alter table channel_runtime.outbox_events
  add column if not exists stream_id uuid,
  add column if not exists stream_sequence bigint;

-- hyperion:statement
do $$
begin
  if exists (
    select 1
    from channel_runtime.outbox_events
    where event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
      and (
        not (payload ? 'threadBindingId')
        or jsonb_typeof(payload -> 'threadBindingId') <> 'string'
        or (payload ->> 'threadBindingId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot establish Channel stream ordering: an inbound outbox row has no valid threadBindingId';
  end if;
end;
$$;

-- hyperion:statement
with ordered as materialized (
  select
    id,
    (payload ->> 'threadBindingId')::uuid as stream_id,
    row_number() over (
      partition by tenant_id, payload ->> 'threadBindingId'
      order by occurred_at, created_at, id
    )::bigint as stream_sequence
  from channel_runtime.outbox_events
  where event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
)
update channel_runtime.outbox_events event
set stream_id = ordered.stream_id,
    stream_sequence = ordered.stream_sequence,
    updated_at = now()
from ordered
where event.id = ordered.id
  and (event.stream_id is null or event.stream_sequence is null);

-- hyperion:statement
alter table channel_runtime.outbox_events
  drop constraint if exists ck_channel_outbox_ordered_stream_position;

-- hyperion:statement
alter table channel_runtime.outbox_events
  add constraint ck_channel_outbox_ordered_stream_position
    check (
      event_type not in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
      or (stream_id is not null and stream_sequence is not null and stream_sequence > 0)
    ) not valid;

-- hyperion:statement
create table if not exists channel_runtime.outbox_stream_positions (
  tenant_id uuid not null,
  stream_id uuid not null,
  last_sequence bigint not null check (last_sequence > 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, stream_id)
);

-- hyperion:statement
create table if not exists channel_runtime.outbox_event_positions (
  tenant_id uuid not null,
  event_id uuid not null,
  stream_id uuid not null,
  stream_sequence bigint not null check (stream_sequence > 0),
  created_at timestamptz not null default now(),
  primary key (tenant_id, event_id),
  unique (tenant_id, stream_id, stream_sequence)
);

-- hyperion:statement
insert into channel_runtime.outbox_event_positions (
  tenant_id,
  event_id,
  stream_id,
  stream_sequence
)
select tenant_id, aggregate_id, stream_id, stream_sequence
from channel_runtime.outbox_events
where event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
  and stream_id is not null
  and stream_sequence is not null
on conflict (tenant_id, event_id) do update
set stream_id = excluded.stream_id,
    stream_sequence = excluded.stream_sequence;

-- hyperion:statement
insert into channel_runtime.outbox_stream_positions (tenant_id, stream_id, last_sequence)
select tenant_id, stream_id, max(stream_sequence)
from channel_runtime.outbox_events
where event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
  and stream_id is not null
  and stream_sequence is not null
group by tenant_id, stream_id
on conflict (tenant_id, stream_id) do update
set last_sequence = greatest(
      channel_runtime.outbox_stream_positions.last_sequence,
      excluded.last_sequence
    ),
    updated_at = now();

-- hyperion:statement
revoke all privileges on table channel_runtime.outbox_stream_positions from public;
-- hyperion:statement
revoke all privileges on table channel_runtime.outbox_event_positions from public;
-- hyperion:statement
grant select, insert, update, delete on table channel_runtime.outbox_stream_positions to hyperion_channel;
-- hyperion:statement
grant select, insert, update, delete on table channel_runtime.outbox_event_positions to hyperion_channel;

-- Upgrade the N-1 compatibility trigger installed by migration 023. It keeps
-- producing strict v1 rows; the current writer promotes its own row to v2 in
-- the same transaction, while an N-1 writer leaves v1 for the compatibility
-- consumer. The
-- position row is the atomic allocator; ON CONFLICT observes the committed row
-- even when two legacy INSERT statements began with the same MVCC snapshot.
-- hyperion:statement
create or replace function channel_runtime.mirror_inbound_event_to_outbox()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, channel_runtime
as $$
declare
  binding channel_runtime.thread_bindings%rowtype;
  allocated_sequence bigint;
begin
  if new.status not in ('received', 'queued', 'processing', 'retry_scheduled') then
    return new;
  end if;

  select candidate.*
    into binding
    from channel_runtime.thread_bindings candidate
   where candidate.tenant_id = new.tenant_id
     and candidate.id = new.thread_binding_id;

  if not found then
    raise exception using
      errcode = '23514',
      message = 'channel inbound event requires a local thread binding for durable publication';
  end if;

  if new.provider <> 'whatsapp_web_test'
     or char_length(new.external_message_id) not between 1 and 512
     or char_length(binding.external_thread_id) not between 1 and 512
     or binding.phone_e164_hash !~ '^[a-f0-9]{64}$'
     or char_length(binding.phone_masked) not between 3 and 32 then
    raise exception using
      errcode = '23514',
      message = 'channel inbound event does not satisfy the durable publication contract';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.tenant_id::text || ':' || binding.id::text, 0)
  );

  select position.stream_sequence
    into allocated_sequence
    from channel_runtime.outbox_event_positions position
   where position.tenant_id = new.tenant_id
     and position.event_id = new.id;

  if allocated_sequence is null then
    insert into channel_runtime.outbox_stream_positions (tenant_id, stream_id, last_sequence)
    values (new.tenant_id, binding.id, 1)
    on conflict (tenant_id, stream_id) do update
    set last_sequence = channel_runtime.outbox_stream_positions.last_sequence + 1,
        updated_at = now()
    returning last_sequence into allocated_sequence;

    insert into channel_runtime.outbox_event_positions (
      tenant_id, event_id, stream_id, stream_sequence
    ) values (
      new.tenant_id, new.id, binding.id, allocated_sequence
    );
  end if;

  insert into channel_runtime.outbox_events (
    tenant_id,
    event_type,
    event_version,
    aggregate_type,
    aggregate_id,
    stream_id,
    stream_sequence,
    payload,
    occurred_at
  ) values (
    new.tenant_id,
    'channel.inbound.received.v1',
    1,
    'channel_inbound_event',
    new.id,
    binding.id,
    allocated_sequence,
    jsonb_build_object(
      'inboundEventId', new.id,
      'threadBindingId', binding.id,
      'provider', new.provider,
      'externalThreadId', binding.external_thread_id,
      'externalMessageId', new.external_message_id,
      'phoneHash', binding.phone_e164_hash,
      'phoneMasked', binding.phone_masked,
      'body', new.body,
      'receivedAt', new.occurred_at
    ),
    new.occurred_at
  )
  on conflict (tenant_id, event_type, aggregate_id) do nothing;

  return new;
end;
$$;

-- Database-level head-of-line scheduling protects a rolled-back N-1 dispatcher
-- whose claim query does not understand stream_sequence. Successors remain at
-- infinity until every lower position has published; retry backoff on the head
-- is preserved.
-- hyperion:statement
create or replace function channel_runtime.defer_non_head_outbox_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, channel_runtime
as $$
begin
  if new.event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
     and new.stream_id is not null
     and new.stream_sequence is not null
     and exists (
       select 1
       from channel_runtime.outbox_events predecessor
       where predecessor.tenant_id = new.tenant_id
         and predecessor.stream_id = new.stream_id
         and predecessor.stream_sequence < new.stream_sequence
         and predecessor.status <> 'published'
     ) then
    new.next_attempt_at := 'infinity'::timestamptz;
  end if;
  return new;
end;
$$;

-- hyperion:statement
create or replace function channel_runtime.release_next_outbox_event()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, channel_runtime
as $$
begin
  if new.status = 'published'
     and old.status <> 'published'
     and new.stream_id is not null
     and new.stream_sequence is not null then
    update channel_runtime.outbox_events successor
    set next_attempt_at = now(),
        updated_at = now()
    where successor.tenant_id = new.tenant_id
      and successor.stream_id = new.stream_id
      and successor.stream_sequence = new.stream_sequence + 1
      and successor.status in ('queued', 'retry_scheduled')
      and successor.next_attempt_at = 'infinity'::timestamptz
      and not exists (
        select 1
        from channel_runtime.outbox_events predecessor
        where predecessor.tenant_id = successor.tenant_id
          and predecessor.stream_id = successor.stream_id
          and predecessor.stream_sequence < successor.stream_sequence
          and predecessor.status <> 'published'
      );
  end if;
  return new;
end;
$$;

-- hyperion:statement
drop trigger if exists trg_channel_outbox_defer_non_head
  on channel_runtime.outbox_events;
-- hyperion:statement
create trigger trg_channel_outbox_defer_non_head
before insert on channel_runtime.outbox_events
for each row execute function channel_runtime.defer_non_head_outbox_event();

-- hyperion:statement
drop trigger if exists trg_channel_outbox_release_successor
  on channel_runtime.outbox_events;
-- hyperion:statement
create trigger trg_channel_outbox_release_successor
after update of status on channel_runtime.outbox_events
for each row execute function channel_runtime.release_next_outbox_event();

-- hyperion:statement
update channel_runtime.outbox_events candidate
set next_attempt_at = 'infinity'::timestamptz,
    updated_at = now()
where candidate.event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
  and candidate.status in ('queued', 'retry_scheduled')
  and exists (
    select 1
    from channel_runtime.outbox_events predecessor
    where predecessor.tenant_id = candidate.tenant_id
      and predecessor.stream_id = candidate.stream_id
      and predecessor.stream_sequence < candidate.stream_sequence
      and predecessor.status <> 'published'
  );

-- hyperion:statement
alter table pulso_iris.inbox_events
  add column if not exists stream_id uuid,
  add column if not exists stream_sequence bigint;

-- Existing processed inbox rows are correlated by the durable event id. This
-- lets the consumer continue at the next position after the upgrade instead of
-- treating established history as a gap.
-- hyperion:statement
update pulso_iris.inbox_events inbox
set stream_id = event.stream_id,
    stream_sequence = event.stream_sequence
from channel_runtime.outbox_events event
where inbox.event_id = event.id
  and inbox.source_service = 'whatsapp-channel-service'
  and inbox.event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
  and event.stream_id is not null
  and event.stream_sequence is not null
  and (inbox.stream_id is null or inbox.stream_sequence is null);

-- A processed successor above a missing predecessor cannot be replayed later:
-- its durable inbox row would be treated as complete while the checkpoint is
-- still behind it. Stop the cutover instead of blessing an irrecoverable gap.
-- hyperion:statement
do $$
begin
  if exists (
    select 1
      from pulso_iris.inbox_events
     where source_service = 'whatsapp-channel-service'
       and event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
       and processed_at is not null
       and (stream_id is null or stream_sequence is null)
  ) or exists (
    select 1
      from (
        select stream_sequence,
               row_number() over (
                 partition by tenant_id, stream_id
                 order by stream_sequence
               ) as contiguous_rank
          from pulso_iris.inbox_events
         where source_service = 'whatsapp-channel-service'
           and event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
           and processed_at is not null
           and stream_id is not null
           and stream_sequence is not null
      ) processed
     where processed.stream_sequence <> processed.contiguous_rank
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot establish Channel ordering: processed PULSO history contains a sequence gap';
  end if;
end;
$$;

-- hyperion:statement
alter table pulso_iris.channel_threads
  add column if not exists last_inbound_sequence bigint not null default 0;

-- hyperion:statement
alter table pulso_iris.channel_threads
  drop constraint if exists ck_pulso_channel_thread_last_inbound_sequence;

-- hyperion:statement
alter table pulso_iris.channel_threads
  add constraint ck_pulso_channel_thread_last_inbound_sequence
    check (last_inbound_sequence >= 0) not valid;

-- Never advance across a historical hole. Before v2, separate workers could
-- finish later events while an earlier event remained unprocessed; MAX alone
-- would silently bless that gap. Only the one-based contiguous prefix becomes
-- the consumer checkpoint.
-- hyperion:statement
with ranked_processed_positions as (
  select tenant_id,
         stream_id,
         stream_sequence,
         row_number() over (
           partition by tenant_id, stream_id
           order by stream_sequence
         ) as contiguous_rank
  from pulso_iris.inbox_events
  where source_service = 'whatsapp-channel-service'
    and event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
    and processed_at is not null
    and stream_id is not null
    and stream_sequence is not null
), processed_positions as (
  select tenant_id, stream_id, max(stream_sequence) as last_inbound_sequence
  from ranked_processed_positions
  where stream_sequence = contiguous_rank
  group by tenant_id, stream_id
)
update pulso_iris.channel_threads thread
set last_inbound_sequence = greatest(thread.last_inbound_sequence, position.last_inbound_sequence),
    updated_at = now()
from processed_positions position
where thread.tenant_id = position.tenant_id
  and thread.id = position.stream_id;

-- hyperion:statement
comment on column channel_runtime.outbox_events.stream_id is
  'Ordered aggregate identifier carried in the durable event envelope';
-- hyperion:statement
comment on column channel_runtime.outbox_events.stream_sequence is
  'One-based monotonic position within tenant_id + stream_id';
-- hyperion:statement
comment on column pulso_iris.channel_threads.last_inbound_sequence is
  'Last contiguous Channel stream position committed by PULSO';

-- hyperion:statement
do $migration$
begin
  if to_regclass('channel_runtime.outbox_stream_positions') is null
     or to_regclass('channel_runtime.outbox_event_positions') is null
     or to_regprocedure('channel_runtime.mirror_inbound_event_to_outbox()') is null
     or to_regprocedure('channel_runtime.defer_non_head_outbox_event()') is null
     or to_regprocedure('channel_runtime.release_next_outbox_event()') is null then
    raise exception using
      errcode = '23514',
      message = 'Channel ordering expansion is incomplete';
  end if;

  if exists (
    select 1
      from channel_runtime.outbox_events
     where event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
       and (stream_id is null or stream_sequence is null or stream_sequence <= 0)
  ) then
    raise exception using
      errcode = '23514',
      message = 'Channel ordering backfill is incomplete';
  end if;

  if exists (
    select 1
      from (
        select stream_sequence,
               row_number() over (
                 partition by tenant_id, stream_id
                 order by stream_sequence
               ) as contiguous_rank
          from pulso_iris.inbox_events
         where source_service = 'whatsapp-channel-service'
           and event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
           and processed_at is not null
      ) processed
     where processed.stream_sequence is null
        or processed.stream_sequence <> processed.contiguous_rank
  ) then
    raise exception using
      errcode = '23514',
      message = 'Processed PULSO history contains a Channel sequence gap';
  end if;

  if (select count(*) from pg_trigger
       where tgrelid = 'channel_runtime.outbox_events'::regclass
         and not tgisinternal
         and tgname in ('trg_channel_outbox_defer_non_head', 'trg_channel_outbox_release_successor')) <> 2 then
    raise exception using
      errcode = '23514',
      message = 'Channel ordering triggers are incomplete';
  end if;
end;
$migration$;
