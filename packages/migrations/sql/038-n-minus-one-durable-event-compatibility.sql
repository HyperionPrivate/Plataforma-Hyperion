-- Bounded database adapters for the supported N-1 durable-event writers.
-- Current binaries carry owner positions in v2. The supported N-1 binaries
-- cannot do that, so these triggers recover only an exact, already-persisted
-- producer-ledger position. Unknown or ambiguous history fails closed.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function pulso_iris.resolve_legacy_channel_inbox_position()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  producer_position record;
begin
  if new.source_service <> 'whatsapp-channel-service'
     or new.event_type <> 'channel.inbound.received.v1' then
    return new;
  end if;

  select position.stream_id, position.stream_sequence
    into producer_position
    from channel_runtime.outbox_events event
    join channel_runtime.outbox_event_positions position
      on position.tenant_id = event.tenant_id
     and position.event_id = event.aggregate_id
   where event.tenant_id = new.tenant_id
     and event.id = new.event_id
     and event.event_type = 'channel.inbound.received.v1'
     and event.event_version = 1
     and event.aggregate_type = 'channel_inbound_event'
     and event.stream_id = position.stream_id
     and event.stream_sequence = position.stream_sequence;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Legacy Channel event has no owner-ledger position';
  end if;

  if new.stream_id is not null or new.stream_sequence is not null then
    if new.stream_id is null or new.stream_sequence is null
       or new.stream_id <> producer_position.stream_id
       or new.stream_sequence <> producer_position.stream_sequence then
      raise exception using
        errcode = '23514',
        message = 'Legacy Channel inbox position conflicts with the owner ledger';
    end if;
  end if;

  new.stream_id := producer_position.stream_id;
  new.stream_sequence := producer_position.stream_sequence;
  return new;
end;
$$;

revoke all on function pulso_iris.resolve_legacy_channel_inbox_position() from public;
revoke all on function pulso_iris.resolve_legacy_channel_inbox_position() from hyperion_pulso;

drop trigger if exists trg_pulso_inbox_resolve_legacy_channel_position
  on pulso_iris.inbox_events;
create trigger trg_pulso_inbox_resolve_legacy_channel_position
before insert on pulso_iris.inbox_events
for each row execute function pulso_iris.resolve_legacy_channel_inbox_position();

create or replace function pulso_iris.prepare_legacy_message_source_position()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  existing_event pulso_iris.outbox_events%rowtype;
  source_inbox pulso_iris.inbox_events%rowtype;
  current_source_sequence bigint;
begin
  if new.event_type <> 'pulso.message.received.v1' then
    return new;
  end if;

  if new.event_version <> 1
     or new.payload ? 'sourceStreamId'
     or new.payload ? 'sourceStreamSequence' then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event does not match the strict v1 contract';
  end if;

  select candidate.*
    into existing_event
    from pulso_iris.outbox_events candidate
   where candidate.tenant_id = new.tenant_id
     and candidate.event_type = 'pulso.message.received.v1'
     and candidate.event_version = 1
     and candidate.aggregate_id = new.aggregate_id
   limit 1;
  if found then
    if existing_event.source_stream_id is null
       or existing_event.source_stream_sequence is null then
      raise exception using
        errcode = '23514',
        message = 'Existing legacy PULSO event has no source position';
    end if;
    if new.source_stream_id is not null or new.source_stream_sequence is not null then
      if new.source_stream_id is null or new.source_stream_sequence is null
         or new.source_stream_id <> existing_event.source_stream_id
         or new.source_stream_sequence <> existing_event.source_stream_sequence then
        raise exception using
          errcode = '23514',
          message = 'Legacy PULSO event source position conflicts with the persisted event';
      end if;
    end if;
    new.source_stream_id := existing_event.source_stream_id;
    new.source_stream_sequence := existing_event.source_stream_sequence;
    return new;
  end if;

  if new.payload ->> 'inboundEventId' !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or new.payload ->> 'threadBindingId' !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event has no valid Channel stream identifier';
  end if;

  select inbox.*
    into source_inbox
    from pulso_iris.inbox_events inbox
    join channel_runtime.outbox_events producer
      on producer.tenant_id = inbox.tenant_id
     and producer.id = inbox.event_id
     and producer.event_type = 'channel.inbound.received.v1'
     and producer.event_version = 1
     and producer.aggregate_type = 'channel_inbound_event'
     and producer.aggregate_id = (new.payload ->> 'inboundEventId')::uuid
     and producer.occurred_at = new.occurred_at
    join channel_runtime.outbox_event_positions position
      on position.tenant_id = producer.tenant_id
     and position.event_id = producer.aggregate_id
     and position.stream_id = producer.stream_id
     and position.stream_sequence = producer.stream_sequence
   where inbox.tenant_id = new.tenant_id
     and inbox.source_service = 'whatsapp-channel-service'
     and inbox.event_type = 'channel.inbound.received.v1'
     and inbox.event_version = 1
     and inbox.processed_at is null
     and inbox.stream_id = position.stream_id
     and inbox.stream_sequence = position.stream_sequence
     and inbox.stream_id = (new.payload ->> 'threadBindingId')::uuid
     and inbox.occurred_at = producer.occurred_at;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event has no exact local Channel owner position';
  end if;

  if new.source_stream_id is not null or new.source_stream_sequence is not null then
    if new.source_stream_id is null or new.source_stream_sequence is null
       or new.source_stream_id <> source_inbox.stream_id
       or new.source_stream_sequence <> source_inbox.stream_sequence then
      raise exception using
        errcode = '23514',
        message = 'Legacy PULSO event source position conflicts with the Channel owner ledger';
    end if;
  end if;

  select thread.last_inbound_sequence
    into current_source_sequence
    from pulso_iris.channel_threads thread
   where thread.tenant_id = new.tenant_id
     and thread.id = source_inbox.stream_id
   for update;
  if not found or source_inbox.stream_sequence <> current_source_sequence + 1 then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event is not the next Channel stream position';
  end if;

  update pulso_iris.channel_threads
     set last_inbound_sequence = source_inbox.stream_sequence,
         updated_at = now()
   where tenant_id = new.tenant_id
     and id = source_inbox.stream_id
     and last_inbound_sequence = current_source_sequence;
  if not found then
    raise exception using
      errcode = '40001',
      message = 'Legacy PULSO Channel checkpoint changed concurrently';
  end if;

  new.source_stream_id := source_inbox.stream_id;
  new.source_stream_sequence := source_inbox.stream_sequence;
  return new;
end;
$$;

revoke all on function pulso_iris.prepare_legacy_message_source_position() from public;
revoke all on function pulso_iris.prepare_legacy_message_source_position() from hyperion_pulso;

drop trigger if exists trg_pulso_outbox_legacy_source_position
  on pulso_iris.outbox_events;
create trigger trg_pulso_outbox_legacy_source_position
before insert on pulso_iris.outbox_events
for each row execute function pulso_iris.prepare_legacy_message_source_position();

create or replace function agent_runtime.resolve_legacy_pulso_inbox_position()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  producer_position record;
begin
  if new.source_service not in ('pulso-core', 'pulso-iris-service')
     or new.event_type <> 'pulso.message.received.v1' then
    return new;
  end if;

  select position.stream_id, position.stream_sequence,
         position.source_stream_id, position.source_stream_sequence
    into producer_position
    from pulso_iris.outbox_events event
    join pulso_iris.outbox_event_positions position
      on position.tenant_id = event.tenant_id
     and position.event_id = event.id
     and position.stream_id = event.stream_id
     and position.stream_sequence = event.stream_sequence
     and position.source_stream_id = event.source_stream_id
     and position.source_stream_sequence = event.source_stream_sequence
   where event.tenant_id = new.tenant_id
     and event.id = new.event_id
     and event.event_type = 'pulso.message.received.v1'
     and event.event_version = 1;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'Legacy PULSO event has no owner-ledger position';
  end if;

  if new.stream_id is not null or new.stream_sequence is not null
     or new.source_stream_id is not null or new.source_stream_sequence is not null then
    if new.stream_id is null or new.stream_sequence is null
       or new.source_stream_id is null or new.source_stream_sequence is null
       or new.stream_id <> producer_position.stream_id
       or new.stream_sequence <> producer_position.stream_sequence
       or new.source_stream_id <> producer_position.source_stream_id
       or new.source_stream_sequence <> producer_position.source_stream_sequence then
      raise exception using
        errcode = '23514',
        message = 'Legacy PULSO inbox position conflicts with the owner ledger';
    end if;
  end if;

  new.stream_id := producer_position.stream_id;
  new.stream_sequence := producer_position.stream_sequence;
  new.source_stream_id := producer_position.source_stream_id;
  new.source_stream_sequence := producer_position.source_stream_sequence;
  return new;
end;
$$;

revoke all on function agent_runtime.resolve_legacy_pulso_inbox_position() from public;
revoke all on function agent_runtime.resolve_legacy_pulso_inbox_position() from hyperion_sofia;

drop trigger if exists trg_agent_inbox_resolve_legacy_pulso_position
  on agent_runtime.inbox_events;
create trigger trg_agent_inbox_resolve_legacy_pulso_position
before insert on agent_runtime.inbox_events
for each row execute function agent_runtime.resolve_legacy_pulso_inbox_position();

alter table pulso_iris.inbox_events
  drop constraint if exists ck_pulso_channel_inbox_contract_version,
  add constraint ck_pulso_channel_inbox_contract_version check (
    source_service <> 'whatsapp-channel-service'
    or event_type not in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
    or (event_type = 'channel.inbound.received.v1' and event_version = 1)
    or (event_type = 'channel.inbound.received.v2' and event_version = 2)
  ) not valid;

alter table pulso_iris.outbox_events
  drop constraint if exists ck_pulso_message_outbox_contract_version,
  add constraint ck_pulso_message_outbox_contract_version check (
    event_type not in ('pulso.message.received.v1', 'pulso.message.received.v2')
    or (event_type = 'pulso.message.received.v1' and event_version = 1)
    or (event_type = 'pulso.message.received.v2' and event_version = 2)
  ) not valid;

alter table agent_runtime.inbox_events
  drop constraint if exists ck_agent_pulso_inbox_contract_version,
  add constraint ck_agent_pulso_inbox_contract_version check (
    source_service not in ('pulso-core', 'pulso-iris-service')
    or event_type not in ('pulso.message.received.v1', 'pulso.message.received.v2')
    or (event_type = 'pulso.message.received.v1' and event_version = 1)
    or (event_type = 'pulso.message.received.v2' and event_version = 2)
  ) not valid;

alter table pulso_iris.inbox_events
  validate constraint ck_pulso_channel_inbox_contract_version;

alter table pulso_iris.outbox_events
  validate constraint ck_pulso_message_outbox_contract_version;

alter table agent_runtime.inbox_events
  validate constraint ck_agent_pulso_inbox_contract_version;

comment on function pulso_iris.resolve_legacy_channel_inbox_position() is
  'N-1 rollback adapter: resolves a v1 Channel inbox position from the exact Channel owner ledger row.';
comment on function pulso_iris.prepare_legacy_message_source_position() is
  'N-1 rollback adapter: carries the locally resolved Channel position into a strict PULSO v1 outbox row.';
comment on function agent_runtime.resolve_legacy_pulso_inbox_position() is
  'N-1 rollback adapter: resolves a v1 SOFIA inbox position from the exact PULSO owner ledger row.';

reset statement_timeout;
reset lock_timeout;
