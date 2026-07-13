-- Repara eventos inbound creados antes de que 021 introdujera el outbox.
--
-- El payload se reconstruye exclusivamente desde el evento y su binding local,
-- con los mismos campos requeridos por channel.inbound.received.v1. No se crea
-- identidad sustituta ni se agregan datos sensibles al metadata operativo.

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

-- Un evento sin binding no puede producir un channel.inbound.received.v1
-- verificable. Se terminaliza de forma visible; no se inventa thread/telefono.
update channel_runtime.inbound_events event
set status = 'dead_letter',
    locked_at = null,
    locked_by = null,
    last_error_code = 'legacy_inbound_binding_missing',
    last_error_message = null,
    metadata = coalesce(event.metadata, '{}'::jsonb) || jsonb_build_object(
      'outboxBackfillStatus', 'dead_letter',
      'outboxBackfillMigration', '023-channel-inbound-outbox-backfill.sql',
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

-- Los bindings presentes pero incompatibles con el contrato vigente tampoco se
-- publican como eventos venenosos. Solo se persisten codigos de diagnostico.
update channel_runtime.inbound_events event
set status = 'dead_letter',
    locked_at = null,
    locked_by = null,
    last_error_code = 'legacy_inbound_contract_invalid',
    last_error_message = null,
    metadata = coalesce(event.metadata, '{}'::jsonb) || jsonb_build_object(
      'outboxBackfillStatus', 'dead_letter',
      'outboxBackfillMigration', '023-channel-inbound-outbox-backfill.sql',
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
