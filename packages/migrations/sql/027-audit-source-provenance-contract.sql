-- Contract phase for the provenance data expanded and backfilled by 026.
-- NOT VALID keeps constraint installation short; validation scans without the
-- ACCESS EXCLUSIVE lock required by a direct add-and-validate operation.

alter table audit_runtime.inbox_events
  drop constraint if exists ck_audit_inbox_contract_hash_not_null,
  add constraint ck_audit_inbox_contract_hash_not_null
    check (contract_hash is not null) not valid,
  drop constraint if exists ck_audit_inbox_contract_hash,
  add constraint ck_audit_inbox_contract_hash
    check (contract_hash ~ '^[a-f0-9]{64}$') not valid,
  drop constraint if exists ck_audit_inbox_source_contract,
  add constraint ck_audit_inbox_source_contract check (
    (source_service = 'sofia-automation' and event_type = 'sofia.audit.event.record.v1')
    or (source_service = 'lumen-service' and event_type = 'lumen.audit.event.record.v1')
    or (source_service = 'legacy-unknown' and event_type = 'legacy.audit.event.record.v1')
  ) not valid;

alter table audit_runtime.inbox_events
  validate constraint ck_audit_inbox_contract_hash_not_null;

alter table audit_runtime.inbox_events
  validate constraint ck_audit_inbox_contract_hash;

alter table audit_runtime.inbox_events
  validate constraint ck_audit_inbox_source_contract;

-- PostgreSQL can use the validated not-null check to avoid another table scan.
alter table audit_runtime.inbox_events
  alter column contract_hash set not null;

alter table audit_runtime.inbox_events
  drop constraint ck_audit_inbox_contract_hash_not_null;
