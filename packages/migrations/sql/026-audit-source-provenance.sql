-- Audit transport provenance is a contract, never a column default.
-- SOFIA and LUMEN use different wrapper event types so JetStream can enforce
-- producer identity with subject ACLs and Audit can retain the declared source.

do $$
begin
  if exists (
    select 1
      from agent_runtime.outbox_events legacy
      join agent_runtime.outbox_events current_contract
        on current_contract.tenant_id = legacy.tenant_id
       and current_contract.aggregate_id = legacy.aggregate_id
       and current_contract.event_type = 'sofia.audit.event.record.v1'
     where legacy.event_type = 'audit.event.record.v1'
       and legacy.id <> current_contract.id
  ) then
    raise exception 'Cannot migrate SOFIA audit outbox: legacy and source-scoped events conflict';
  end if;

  if exists (
    select 1
      from lumen.outbox_events legacy
      join lumen.outbox_events current_contract
        on current_contract.tenant_id = legacy.tenant_id
       and current_contract.dedupe_key = legacy.dedupe_key
       and current_contract.event_type = 'lumen.audit.event.record.v1'
     where legacy.event_type = 'audit.event.record.v1'
       and legacy.id <> current_contract.id
  ) then
    raise exception 'Cannot migrate LUMEN audit outbox: legacy and source-scoped events conflict';
  end if;

  if exists (
    select 1
      from audit_runtime.inbox_events inbox
     where exists (select 1 from agent_runtime.outbox_events event where event.id = inbox.event_id)
       and exists (select 1 from lumen.outbox_events event where event.id = inbox.event_id)
  ) then
    raise exception 'Cannot infer Audit provenance: event id belongs to both SOFIA and LUMEN outboxes';
  end if;

  if exists (
    select 1
      from audit_runtime.inbox_events inbox
     where (inbox.event_type = 'sofia.audit.event.record.v1'
            and exists (select 1 from lumen.outbox_events event where event.id = inbox.event_id))
        or (inbox.event_type = 'lumen.audit.event.record.v1'
            and exists (select 1 from agent_runtime.outbox_events event where event.id = inbox.event_id))
  ) then
    raise exception 'Cannot migrate Audit provenance: event type contradicts its durable outbox source';
  end if;
end
$$;

update agent_runtime.outbox_events
   set event_type = 'sofia.audit.event.record.v1', updated_at = now()
 where event_type = 'audit.event.record.v1';

update lumen.outbox_events
   set event_type = 'lumen.audit.event.record.v1', updated_at = now()
 where event_type = 'audit.event.record.v1';

-- Existing inbox rows are attributed only when durable evidence identifies the
-- producer. Uncorrelated HTTP-era rows lose the misleading SOFIA default and
-- remain explicitly unknown instead of receiving invented provenance.
update audit_runtime.inbox_events inbox
   set source_service = case
         when inbox.event_type = 'sofia.audit.event.record.v1'
           or exists (select 1 from agent_runtime.outbox_events event where event.id = inbox.event_id)
           then 'sofia-automation'
         when inbox.event_type = 'lumen.audit.event.record.v1'
           or exists (select 1 from lumen.outbox_events event where event.id = inbox.event_id)
           then 'lumen-service'
         else 'legacy-unknown'
       end,
       event_type = case
         when inbox.event_type = 'sofia.audit.event.record.v1'
           or exists (select 1 from agent_runtime.outbox_events event where event.id = inbox.event_id)
           then 'sofia.audit.event.record.v1'
         when inbox.event_type = 'lumen.audit.event.record.v1'
           or exists (select 1 from lumen.outbox_events event where event.id = inbox.event_id)
           then 'lumen.audit.event.record.v1'
         else 'legacy.audit.event.record.v1'
       end;

alter table audit_runtime.inbox_events
  alter column source_service drop default,
  add column if not exists contract_hash text;

update audit_runtime.inbox_events
   set contract_hash = encode(
     digest(
       source_service || chr(31) ||
       event_type || chr(31) ||
       event_version::text || chr(31) ||
       coalesce(lower(tenant_id::text), '<none>') || chr(31) ||
       payload_hash,
       'sha256'
     ),
     'hex'
   )
 where contract_hash is null;

-- The NOT NULL/check contract and the operational index are deliberately
-- installed by 027/028. Keeping expansion/backfill separate avoids combining
-- a potentially large rewrite with every lock-heavy contract operation.

-- Replace the LUMEN approval trigger body installed by 022 so every future
-- record uses the LUMEN-scoped wrapper event contract.
create or replace function lumen.finalize_clinical_record_approval()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'draft' and new.status = 'approved' then
    update lumen.encounter_reference_snapshots
    set frozen_at = coalesce(frozen_at, new.approved_at, now()), updated_at = now()
    where tenant_id = new.tenant_id and encounter_id = new.encounter_id;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN approval requires a reference snapshot';
    end if;

    update lumen.encounters
    set status = 'approved', updated_at = now()
    where tenant_id = new.tenant_id and id = new.encounter_id;
    if not found then
      raise exception using errcode = '23514', message = 'LUMEN approval encounter is missing';
    end if;

    insert into lumen.outbox_events (
      tenant_id, event_type, event_version, aggregate_type, aggregate_id,
      dedupe_key, payload, occurred_at
    )
    values (
      new.tenant_id,
      'lumen.audit.event.record.v1',
      1,
      'lumen_clinical_record',
      new.id,
      'clinical-record:' || new.id::text || ':draft-approved',
      jsonb_build_object(
        'tenantId', new.tenant_id::text,
        'actorId', new.approved_by::text,
        'eventType', 'lumen.record.approved',
        'entityType', 'lumen_clinical_record',
        'entityId', new.id::text,
        'metadata', jsonb_build_object(
          'source', 'lumen-service',
          'encounterId', new.encounter_id::text,
          'schemaVersion', new.schema_version
        )
      ),
      coalesce(new.approved_at, now())
    )
    on conflict (tenant_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

insert into lumen.service_migrations (version, name)
values (26, '026-audit-source-provenance.sql')
on conflict (version) do update set name = excluded.name;

insert into lumen.schema_version (service_name, current_version, migration_name)
values ('lumen', 26, '026-audit-source-provenance.sql')
on conflict (service_name) do update set
  current_version = greatest(lumen.schema_version.current_version, excluded.current_version),
  migration_name = case
    when excluded.current_version >= lumen.schema_version.current_version then excluded.migration_name
    else lumen.schema_version.migration_name
  end,
  updated_at = now();
