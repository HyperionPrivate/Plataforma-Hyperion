-- Additive cutover fence for Channel writers that predate the durable outbox.
--
-- The filename sorts after 021 (which owns outbox_events) and before the
-- historical 023 backfill. It is also safe on databases where 023 was already
-- recorded: installing the trigger first fences concurrent writers, then the
-- idempotent repair finds any rows created after that one-shot backfill.

create or replace function channel_runtime.mirror_inbound_event_to_outbox()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, channel_runtime
as $$
declare
  binding channel_runtime.thread_bindings%rowtype;
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

  insert into channel_runtime.outbox_events (
    tenant_id,
    event_type,
    event_version,
    aggregate_type,
    aggregate_id,
    payload,
    occurred_at
  ) values (
    new.tenant_id,
    'channel.inbound.received.v1',
    1,
    'channel_inbound_event',
    new.id,
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

-- CREATE TRIGGER takes the table lock that forms the writer fence. It waits
-- for prior INSERT transactions, then blocks newer writers until this
-- transaction has repaired all committed pre-fence rows and installed the
-- dual-write path they will execute when they resume.
drop trigger if exists trg_channel_inbound_outbox_compat
  on channel_runtime.inbound_events;

create trigger trg_channel_inbound_outbox_compat
after insert on channel_runtime.inbound_events
for each row execute function channel_runtime.mirror_inbound_event_to_outbox();

with eligible_legacy_inbound as (
  select
    event.id,
    event.tenant_id,
    event.provider,
    event.external_message_id,
    event.body,
    event.occurred_at,
    binding.id as thread_binding_id,
    binding.external_thread_id,
    binding.phone_e164_hash,
    binding.phone_masked
  from channel_runtime.inbound_events event
  join channel_runtime.thread_bindings binding
    on binding.tenant_id = event.tenant_id
   and binding.id = event.thread_binding_id
  where event.status in ('received', 'queued', 'processing', 'retry_scheduled')
    and event.provider = 'whatsapp_web_test'
    and char_length(event.external_message_id) between 1 and 512
    and char_length(binding.external_thread_id) between 1 and 512
    and binding.phone_e164_hash ~ '^[a-f0-9]{64}$'
    and char_length(binding.phone_masked) between 3 and 32
)
insert into channel_runtime.outbox_events (
  tenant_id,
  event_type,
  event_version,
  aggregate_type,
  aggregate_id,
  payload,
  occurred_at
)
select
  legacy.tenant_id,
  'channel.inbound.received.v1',
  1,
  'channel_inbound_event',
  legacy.id,
  jsonb_build_object(
    'inboundEventId', legacy.id,
    'threadBindingId', legacy.thread_binding_id,
    'provider', legacy.provider,
    'externalThreadId', legacy.external_thread_id,
    'externalMessageId', legacy.external_message_id,
    'phoneHash', legacy.phone_e164_hash,
    'phoneMasked', legacy.phone_masked,
    'body', legacy.body,
    'receivedAt', legacy.occurred_at
  ),
  legacy.occurred_at
from eligible_legacy_inbound legacy
on conflict (tenant_id, event_type, aggregate_id) do nothing;

-- Rows without a local binding cannot produce a verifiable envelope. Preserve
-- them as terminal evidence without inventing thread or phone identity.
update channel_runtime.inbound_events event
set status = 'dead_letter',
    locked_at = null,
    locked_by = null,
    last_error_code = 'legacy_inbound_binding_missing',
    last_error_message = null,
    metadata = coalesce(event.metadata, '{}'::jsonb) || jsonb_build_object(
      'outboxBackfillStatus', 'dead_letter',
      'outboxBackfillMigration', '022-channel-inbound-outbox-fence.sql',
      'outboxErrorCode', 'legacy_inbound_binding_missing'
    ),
    updated_at = now()
where event.status in ('received', 'queued', 'processing', 'retry_scheduled')
  and not exists (
    select 1
    from channel_runtime.outbox_events outbox
    where outbox.tenant_id = event.tenant_id
      and outbox.event_type = 'channel.inbound.received.v1'
      and outbox.aggregate_id = event.id
  )
  and not exists (
    select 1
    from channel_runtime.thread_bindings binding
    where binding.tenant_id = event.tenant_id
      and binding.id = event.thread_binding_id
  );

-- Bindings present but incompatible with the current event contract are also
-- terminalized with diagnostic codes only; no poison event is published.
update channel_runtime.inbound_events event
set status = 'dead_letter',
    locked_at = null,
    locked_by = null,
    last_error_code = 'legacy_inbound_contract_invalid',
    last_error_message = null,
    metadata = coalesce(event.metadata, '{}'::jsonb) || jsonb_build_object(
      'outboxBackfillStatus', 'dead_letter',
      'outboxBackfillMigration', '022-channel-inbound-outbox-fence.sql',
      'outboxErrorCode', 'legacy_inbound_contract_invalid'
    ),
    updated_at = now()
from channel_runtime.thread_bindings binding
where event.status in ('received', 'queued', 'processing', 'retry_scheduled')
  and binding.tenant_id = event.tenant_id
  and binding.id = event.thread_binding_id
  and not exists (
    select 1
    from channel_runtime.outbox_events outbox
    where outbox.tenant_id = event.tenant_id
      and outbox.event_type = 'channel.inbound.received.v1'
      and outbox.aggregate_id = event.id
  )
  and not (
    event.provider = 'whatsapp_web_test'
    and char_length(event.external_message_id) between 1 and 512
    and char_length(binding.external_thread_id) between 1 and 512
    and binding.phone_e164_hash ~ '^[a-f0-9]{64}$'
    and char_length(binding.phone_masked) between 3 and 32
  );
