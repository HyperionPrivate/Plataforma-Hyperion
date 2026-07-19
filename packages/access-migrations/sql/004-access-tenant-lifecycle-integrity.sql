-- Source-integrity guard for the provider-owned tenant lifecycle feed.
-- Snapshot v1 has no tombstone, so a hard delete would erase both the source
-- row and its projection state/outbox through existing cascades.

create function access_runtime.enforce_tenant_lifecycle_v1()
returns trigger
language plpgsql
set search_path = pg_catalog
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'platform.tenants hard delete is disabled while access.tenant.snapshot.v1 has no tombstone';
  end if;

  if tg_op = 'INSERT' then
    new.updated_at := clock_timestamp();
  else
    new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  end if;

  return new;
end
$function$;

comment on function access_runtime.enforce_tenant_lifecycle_v1() is
  'Access-owned source guard: advances tenant updated_at and fails closed on hard delete until snapshot v1 has tombstones.';

revoke execute on function access_runtime.enforce_tenant_lifecycle_v1()
  from public, hyperion_identity, hyperion_tenant;

create trigger trg_access_tenant_lifecycle_v1
before insert or update or delete on platform.tenants
for each row
execute function access_runtime.enforce_tenant_lifecycle_v1();

alter table platform.tenants enable always trigger trg_access_tenant_lifecycle_v1;

comment on trigger trg_access_tenant_lifecycle_v1 on platform.tenants is
  'Preserves the monotonic source watermark and archive-only lifecycle required by access.tenant.snapshot.v1.';
