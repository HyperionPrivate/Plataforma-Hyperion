-- hyperion:no-transaction
-- Readiness checks all non-terminal deterministic audio work across owners.
-- Build the narrow partial index concurrently so the global fail-closed check
-- does not scan the complete processing-attempt ledger.

-- hyperion:statement
drop index concurrently if exists lumen.idx_lumen_processing_attempts_unresolved_cleanup_owner;

-- hyperion:statement
create index concurrently idx_lumen_processing_attempts_unresolved_cleanup_owner
  on lumen.processing_attempts(cleanup_owner)
  where operation = 'transcription'
    and cleanup_protocol = 'deterministic_v2'
    and status in ('processing', 'cleanup_pending');

-- hyperion:statement
do $$
begin
  if not exists (
    select 1
      from pg_index
     where indexrelid = 'lumen.idx_lumen_processing_attempts_unresolved_cleanup_owner'::regclass
       and indisvalid
       and indisready
  ) then
    raise exception 'invalid LUMEN unresolved-cleanup-owner index';
  end if;
end
$$;

-- hyperion:statement
insert into lumen.service_migrations (version, name)
values (39, '039-lumen-unresolved-cleanup-owner-index.sql')
on conflict (version) do update set name = excluded.name;

-- hyperion:statement
insert into lumen.schema_version (service_name, current_version, migration_name)
values ('lumen', 39, '039-lumen-unresolved-cleanup-owner-index.sql')
on conflict (service_name) do update set
  current_version = greatest(lumen.schema_version.current_version, excluded.current_version),
  migration_name = case
    when excluded.current_version >= lumen.schema_version.current_version then excluded.migration_name
    else lumen.schema_version.migration_name
  end,
  updated_at = now();
