-- Runtime readiness may inspect only the Access-owned ledger. Grant the
-- least privilege needed by the Access service role without exposing the
-- migrator's write authority or the legacy global migration catalog.

revoke all on access_runtime.migration_ledger from public;

do $migration$
begin
  if exists (select 1 from pg_roles where rolname = 'hyperion_access') then
    grant usage on schema access_runtime to hyperion_access;
    grant select on access_runtime.migration_ledger to hyperion_access;
  end if;
end
$migration$;
