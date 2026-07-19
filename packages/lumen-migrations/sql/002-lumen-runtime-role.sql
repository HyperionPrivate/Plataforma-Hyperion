-- Provider-owned least-privilege runtime matrix for the standalone LUMEN cell.
-- The cluster bootstrap creates hyperion_lumen as NOLOGIN before this runs.

revoke all privileges on schema lumen from public;
revoke all privileges on all tables in schema lumen from public;
revoke all privileges on all sequences in schema lumen from public;
revoke execute on all functions in schema lumen from public;

revoke all privileges on schema lumen from hyperion_lumen;
revoke all privileges on all tables in schema lumen from hyperion_lumen;
revoke all privileges on all sequences in schema lumen from hyperion_lumen;
revoke execute on all functions in schema lumen from hyperion_lumen;

do $$
begin
  execute format('revoke all privileges on database %I from public', current_database());
  execute format('revoke all privileges on database %I from hyperion_lumen', current_database());
  execute format('grant connect on database %I to hyperion_lumen', current_database());
end
$$;
grant usage on schema lumen to hyperion_lumen;

grant select on table
  lumen.schema_version,
  lumen.service_migrations
to hyperion_lumen;

grant select, insert, update, delete on table
  lumen.audio_cleanup_owner_leases
to hyperion_lumen;

grant select, insert, update on table
  lumen.tenant_snapshots,
  lumen.operator_grants,
  lumen.encounter_reference_snapshots,
  lumen.inbox_events,
  lumen.outbox_events,
  lumen.dictations,
  lumen.clinical_records,
  lumen.processing_attempts
to hyperion_lumen;

grant select, update on table lumen.encounters to hyperion_lumen;
grant select on table lumen.preconsultation_summaries to hyperion_lumen;

-- Compatibility-window and migration-ledger tables remain migrator/admin-only.
revoke all privileges on table
  lumen.n_minus_one_compatibility_windows,
  lumen.legacy_audio_scope_attestations,
  lumen.migration_ledger
from hyperion_lumen;

insert into lumen.service_migrations (version, name)
values (40, '002-lumen-runtime-role.sql')
on conflict (version) do update set name = excluded.name;

insert into lumen.schema_version (service_name, current_version, migration_name)
values ('lumen', 40, '002-lumen-runtime-role.sql')
on conflict (service_name) do update set
  current_version = greatest(lumen.schema_version.current_version, excluded.current_version),
  migration_name = case
    when excluded.current_version >= lumen.schema_version.current_version then excluded.migration_name
    else lumen.schema_version.migration_name
  end,
  updated_at = now();
