-- Exact runtime privilege matrix for Identity and Tenant. Cluster bootstrap
-- creates both as NOLOGIN; password activation happens only after these grants.

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'hyperion_identity')
     or not exists (select 1 from pg_roles where rolname = 'hyperion_tenant') then
    raise exception using errcode = '42501', message = 'Access runtime roles must exist before migration';
  end if;
end
$roles$;

revoke all privileges on schema platform from public, hyperion_identity, hyperion_tenant;
revoke all privileges on schema access_runtime from public, hyperion_identity, hyperion_tenant;
revoke all privileges on all tables in schema platform from public, hyperion_identity, hyperion_tenant;
revoke all privileges on all tables in schema access_runtime from public, hyperion_identity, hyperion_tenant;
revoke all privileges on all sequences in schema platform from public, hyperion_identity, hyperion_tenant;
revoke all privileges on all sequences in schema access_runtime from public, hyperion_identity, hyperion_tenant;
revoke execute on function access_runtime.valid_grant_values(text[], text)
  from public, hyperion_identity, hyperion_tenant;

do $database$
begin
  execute format('revoke all privileges on database %I from public', current_database());
  execute format('revoke all privileges on database %I from hyperion_identity', current_database());
  execute format('revoke all privileges on database %I from hyperion_tenant', current_database());
  execute format('grant connect on database %I to hyperion_identity', current_database());
  execute format('grant connect on database %I to hyperion_tenant', current_database());
end
$database$;

grant usage on schema platform, access_runtime to hyperion_identity;
grant usage on schema platform, access_runtime to hyperion_tenant;

grant select on table platform.tenants to hyperion_identity, hyperion_tenant;
grant select, insert, update on table platform.operators to hyperion_identity;
grant select, insert, delete on table platform.operator_tenants to hyperion_identity;
grant select, insert, update on table platform.operator_sessions to hyperion_identity;

grant select, insert, update, delete on table access_runtime.product_grants to hyperion_identity;
grant select on table access_runtime.bootstrap_tenants to hyperion_identity;
grant select, insert, update on table
  access_runtime.lumen_projection_state,
  access_runtime.lumen_projection_outbox
to hyperion_identity;
grant execute on function access_runtime.valid_grant_values(text[], text) to hyperion_identity;

grant select on table access_runtime.migration_ledger to hyperion_identity, hyperion_tenant;
