create schema if not exists access_runtime;

create or replace function access_runtime.valid_grant_values(values_input text[], expression text)
returns boolean
language sql
immutable
parallel safe
as $function$
  select cardinality(values_input) > 0
     and cardinality(values_input) <= 128
     and not exists (
       select 1 from unnest(values_input) value
        where value is null or value !~ expression
     )
     and (select count(distinct value) from unnest(values_input) value) = cardinality(values_input)
$function$;

create table if not exists access_runtime.product_grants (
  operator_id uuid not null references platform.operators(id) on delete cascade,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  product_id text not null,
  roles text[] not null,
  capabilities text[] not null,
  active boolean not null default true,
  granted_by uuid not null references platform.operators(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (operator_id, tenant_id, product_id),
  constraint ck_access_product_id check (product_id ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  constraint ck_access_product_roles check (
    cardinality(roles) <= 32
    and access_runtime.valid_grant_values(roles, '^[a-z][a-z0-9_-]{1,63}$')
  ),
  constraint ck_access_product_capabilities check (
    access_runtime.valid_grant_values(capabilities, '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$')
  )
);

create index if not exists ix_access_grants_operator_active
  on access_runtime.product_grants(operator_id, active, tenant_id, product_id);
create index if not exists ix_access_grants_tenant_product
  on access_runtime.product_grants(tenant_id, product_id)
  where active;

-- N/N-1 compatibility backfill. Legacy operator_tenants meant that the global
-- platform role applied to every non-paused product exposed by the shared
-- console. Preserve exactly that effective access while making product and
-- capability decisions explicit. No tenant slug or customer-specific UUID is
-- used: the existing operator/tenant UUID relationship is authoritative.
insert into access_runtime.product_grants (
  operator_id, tenant_id, product_id, roles, capabilities, active, granted_by
)
select membership.operator_id,
       membership.tenant_id,
       mapping.product_id,
       mapping.roles,
       mapping.capabilities,
       true,
       membership.operator_id
  from platform.operator_tenants membership
  join platform.operators operator_row on operator_row.id = membership.operator_id
  cross join lateral (
    values
      (
        'NOVA'::text,
        case operator_row.role
          when 'admin' then array['admin']::text[]
          when 'coordinator' then array['supervisor']::text[]
          else array['asesor']::text[]
        end,
        case operator_row.role
          when 'admin' then array['nova:read', 'nova:write', 'nova:admin']::text[]
          when 'auditor' then array['nova:read']::text[]
          else array['nova:read', 'nova:write']::text[]
        end
      ),
      (
        'LUMEN'::text,
        array[case operator_row.role when 'admin' then 'admin' else operator_row.role end]::text[],
        case operator_row.role
          when 'auditor' then array['lumen:read']::text[]
          else array['lumen:read', 'lumen:write']::text[]
        end
      ),
      (
        'PULSO_IRIS'::text,
        array[case operator_row.role when 'admin' then 'admin' else operator_row.role end]::text[],
        case operator_row.role
          when 'auditor' then array['pulso:read']::text[]
          else array['pulso:read', 'pulso:write']::text[]
        end
      )
  ) as mapping(product_id, roles, capabilities)
  join platform.products product
    on product.code = mapping.product_id
   and product.status <> 'paused'
 where operator_row.status = 'active'
on conflict (operator_id, tenant_id, product_id) do nothing;

do $validation$
begin
  if exists (
    select 1
      from platform.operator_tenants membership
      join platform.operators operator_row
        on operator_row.id = membership.operator_id
       and operator_row.status = 'active'
      join platform.products product on product.code in ('NOVA', 'LUMEN', 'PULSO_IRIS') and product.status <> 'paused'
     where not exists (
       select 1 from access_runtime.product_grants grant_row
        where grant_row.operator_id = membership.operator_id
          and grant_row.tenant_id = membership.tenant_id
          and grant_row.product_id = product.code
     )
  ) then
    raise exception using errcode = '23514', message = 'Access product-grant backfill left an active membership unresolved';
  end if;

end
$validation$;

revoke all on schema access_runtime from public;
revoke all on access_runtime.product_grants from public;

do $migration$
begin
  if exists (select 1 from pg_roles where rolname = 'hyperion_access') then
    grant usage on schema access_runtime to hyperion_access;
    grant select, insert, update, delete on access_runtime.product_grants to hyperion_access;
    grant execute on function access_runtime.valid_grant_values(text[], text) to hyperion_access;
  end if;
end
$migration$;
