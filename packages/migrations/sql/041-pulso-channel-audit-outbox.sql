-- Durable audit outbox for PULSO domain mutations and Channel message.sent.
-- Reuses each owner's outbox_events table with a nullable dedupe_key so audit
-- rows stay independent from ordered message/inbound stream positions.

alter table pulso_iris.outbox_events
  add column if not exists dedupe_key text;

alter table pulso_iris.outbox_events
  drop constraint if exists ck_pulso_outbox_dedupe_key;

alter table pulso_iris.outbox_events
  add constraint ck_pulso_outbox_dedupe_key
    check (dedupe_key is null or length(btrim(dedupe_key)) between 3 and 240);

create unique index if not exists uq_pulso_outbox_dedupe
  on pulso_iris.outbox_events (tenant_id, dedupe_key)
  where dedupe_key is not null;

alter table channel_runtime.outbox_events
  add column if not exists dedupe_key text;

alter table channel_runtime.outbox_events
  drop constraint if exists ck_channel_outbox_dedupe_key;

alter table channel_runtime.outbox_events
  add constraint ck_channel_outbox_dedupe_key
    check (dedupe_key is null or length(btrim(dedupe_key)) between 3 and 240);

create unique index if not exists uq_channel_outbox_dedupe
  on channel_runtime.outbox_events (tenant_id, dedupe_key)
  where dedupe_key is not null;

-- Expand the Audit inbox source contract for the new durable producers.
alter table audit_runtime.inbox_events
  drop constraint if exists ck_audit_inbox_source_contract;

alter table audit_runtime.inbox_events
  add constraint ck_audit_inbox_source_contract check (
    (source_service = 'sofia-automation' and event_type = 'sofia.audit.event.record.v1')
    or (source_service = 'lumen-service' and event_type = 'lumen.audit.event.record.v1')
    or (source_service = 'pulso-iris-service' and event_type = 'pulso.audit.event.record.v1')
    or (source_service = 'whatsapp-channel-service' and event_type = 'channel.audit.event.record.v1')
    or (source_service = 'legacy-unknown' and event_type = 'legacy.audit.event.record.v1')
  ) not valid;

alter table audit_runtime.inbox_events
  validate constraint ck_audit_inbox_source_contract;
