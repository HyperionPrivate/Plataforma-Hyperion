-- Contract phase for the checks expanded as NOT VALID in 041.  PostgreSQL
-- validates historical rows without taking the ACCESS EXCLUSIVE lock required
-- to install a newly validated constraint in one step.

alter table pulso_iris.outbox_events
  validate constraint ck_pulso_outbox_dedupe_key;

alter table channel_runtime.outbox_events
  validate constraint ck_channel_outbox_dedupe_key;

alter table audit_runtime.inbox_events
  validate constraint ck_audit_inbox_source_contract;
