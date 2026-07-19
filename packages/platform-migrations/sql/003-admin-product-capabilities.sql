-- Preserve the checksum of the deployed Access backfill while converging its
-- legacy administrative grants on the provider-owned admin capabilities.

update access_runtime.product_grants
   set capabilities = capabilities || array['lumen:admin']::text[],
       updated_at = now()
 where product_id = 'LUMEN'
   and roles @> array['admin']::text[]
   and not capabilities @> array['lumen:admin']::text[];

update access_runtime.product_grants
   set capabilities = capabilities || array['pulso:admin']::text[],
       updated_at = now()
 where product_id = 'PULSO_IRIS'
   and roles @> array['admin']::text[]
   and not capabilities @> array['pulso:admin']::text[];

do $validation$
begin
  if exists (
    select 1
      from access_runtime.product_grants grant_row
     where (
       grant_row.product_id = 'LUMEN'
       and grant_row.roles @> array['admin']::text[]
       and not grant_row.capabilities @> array['lumen:admin']::text[]
     ) or (
       grant_row.product_id = 'PULSO_IRIS'
       and grant_row.roles @> array['admin']::text[]
       and not grant_row.capabilities @> array['pulso:admin']::text[]
     )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Access product admin grant capability convergence failed';
  end if;
end
$validation$;
