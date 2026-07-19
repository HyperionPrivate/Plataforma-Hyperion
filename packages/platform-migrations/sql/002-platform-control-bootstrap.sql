-- Platform Access owns one neutral control tenant. Runtime code discovers it
-- through this registry's UUID foreign key; the slug is never a tenant selector.
create table if not exists access_runtime.bootstrap_tenants (
  bootstrap_key text primary key,
  tenant_id uuid not null unique references platform.tenants(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint ck_access_bootstrap_tenant_key check (bootstrap_key = 'platform-control')
);

with created_tenant as (
  insert into platform.tenants (id, slug, display_name, status, metadata)
  select
    '00000000-0000-4000-8000-000000000001'::uuid,
    'hyperion-platform-control',
    'Hyperion Platform Control',
    'active',
    jsonb_build_object(
      'owner', 'platform-migrations',
      'purpose', 'platform-control',
      'customerFacing', false
    )
  where not exists (
    select 1
      from access_runtime.bootstrap_tenants
     where bootstrap_key = 'platform-control'
  )
  returning id
)
insert into access_runtime.bootstrap_tenants (bootstrap_key, tenant_id)
select 'platform-control', id
  from created_tenant
on conflict (bootstrap_key) do nothing;

-- Fail closed if a prior/manual partial setup registered the key without the
-- exact neutral tenant owned by this migration set.
do $validation$
begin
  if not exists (
    select 1
      from access_runtime.bootstrap_tenants registry
      join platform.tenants tenant_row on tenant_row.id = registry.tenant_id
     where registry.bootstrap_key = 'platform-control'
       and registry.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
       and tenant_row.slug = 'hyperion-platform-control'
       and tenant_row.display_name = 'Hyperion Platform Control'
       and tenant_row.status = 'active'
       and tenant_row.metadata @> '{
         "owner": "platform-migrations",
         "purpose": "platform-control",
         "customerFacing": false
       }'::jsonb
  ) then
    raise exception using
      errcode = '23514',
      message = 'Platform control tenant bootstrap is missing or inconsistent';
  end if;
end
$validation$;

-- Any PLATFORM grant attached to a customer tenant came from the superseded
-- broad bootstrap. Preserve the row for review, but remove its authority.
update access_runtime.product_grants
   set active = false,
       updated_at = now()
 where product_id = 'PLATFORM'
   and tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid
   and active;

insert into platform.operator_tenants (operator_id, tenant_id)
select operator_row.id,
       '00000000-0000-4000-8000-000000000001'::uuid
  from platform.operators operator_row
 where operator_row.role = 'admin'
   and operator_row.status = 'active'
on conflict (operator_id, tenant_id) do nothing;

insert into access_runtime.product_grants (
  operator_id, tenant_id, product_id, roles, capabilities, active, granted_by
)
select operator_row.id,
       '00000000-0000-4000-8000-000000000001'::uuid,
       'PLATFORM',
       array['platform-admin']::text[],
       array['manage:platform']::text[],
       true,
       operator_row.id
  from platform.operators operator_row
 where operator_row.role = 'admin'
   and operator_row.status = 'active'
on conflict (operator_id, tenant_id, product_id) do nothing;

do $admin_validation$
begin
  if exists (
    select 1
      from platform.operators operator_row
     where operator_row.role = 'admin'
       and operator_row.status = 'active'
       and (
         not exists (
           select 1 from platform.operator_tenants membership
            where membership.operator_id = operator_row.id
              and membership.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
         )
         or not exists (
           select 1 from access_runtime.product_grants grant_row
            where grant_row.operator_id = operator_row.id
              and grant_row.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
              and grant_row.product_id = 'PLATFORM'
              and grant_row.roles = array['platform-admin']::text[]
              and grant_row.capabilities = array['manage:platform']::text[]
              and grant_row.active
         )
       )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Platform control grant bootstrap left an active admin unresolved';
  end if;

  if exists (
    select 1 from access_runtime.product_grants grant_row
     where grant_row.product_id = 'PLATFORM'
       and grant_row.tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid
       and grant_row.active
  ) then
    raise exception using
      errcode = '23514',
      message = 'Active PLATFORM grant exists outside the reserved control tenant';
  end if;
end
$admin_validation$;

revoke all on access_runtime.bootstrap_tenants from public;

do $migration$
begin
  if exists (select 1 from pg_roles where rolname = 'hyperion_access') then
    grant select on access_runtime.bootstrap_tenants to hyperion_access;
  end if;
end
$migration$;
