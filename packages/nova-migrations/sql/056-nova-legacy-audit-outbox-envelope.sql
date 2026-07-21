-- Drain-only N-1 repair: releases before the Audit provider contract stored
-- contact.imported and lead.qualified as raw domain envelopes. Preserve the
-- immutable event identity and domain payload while adopting the current,
-- source-scoped Audit wire contract. Delivery state is deliberately retained;
-- operators must redrive failed rows through the tenant admin API.

with legacy_audit_events as (
  select
    event_id,
    event_type as domain_event_type,
    tenant_id,
    correlation_id,
    business_idempotency_key,
    payload as domain_payload,
    case event_type
      when 'contact.imported' then 'contact'
      when 'lead.qualified' then 'lead'
    end as entity_type,
    case event_type
      when 'contact.imported' then payload ->> 'contact_id'
      when 'lead.qualified' then payload ->> 'lead_id'
    end as entity_id
  from nova.outbox_events
  where event_type in ('contact.imported', 'lead.qualified')
    and tenant_id is not null
    and destination like '%/internal/v1/events'
)
update nova.outbox_events as event
set event_type = 'nova.audit.event.record.v1',
    payload = jsonb_build_object(
      'tenantId', legacy.tenant_id,
      'actorId', 'nova-core-service',
      'eventType', legacy.domain_event_type,
      'entityType', legacy.entity_type,
      'entityId', legacy.entity_id,
      'metadata', jsonb_build_object(
        'correlationId', legacy.correlation_id,
        'businessIdempotencyKey', legacy.business_idempotency_key,
        'domainPayload', legacy.domain_payload
      )
    ),
    updated_at = now()
from legacy_audit_events as legacy
where event.event_id = legacy.event_id;

-- Keep the operator-visible DLQ snapshot aligned with the repaired event. The
-- redriven_at flag remains untouched so unresolved evidence cannot disappear.
update nova.outbox_dlq as dlq
set event_type = event.event_type,
    payload = event.payload
from nova.outbox_events as event
where dlq.event_id = event.event_id
  and event.event_type = 'nova.audit.event.record.v1'
  and dlq.event_type in ('contact.imported', 'lead.qualified');

insert into nova.service_migrations(version, name)
values (9, '056-nova-legacy-audit-outbox-envelope.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 9,
    migration_name = '056-nova-legacy-audit-outbox-envelope.sql',
    updated_at = now()
where service_name = 'nova';
