-- CRM product lines (Renovación / Reactivación / Nuevos / Microcrédito)
alter table nova.leads
  add column if not exists product_line text;

update nova.leads l
   set product_line = coalesce(
     (
       select c.product_flow
         from nova.campaign_enrollments e
         join nova.campaigns c
           on c.tenant_id = e.tenant_id and c.campaign_id = e.campaign_id
        where e.tenant_id = l.tenant_id and e.contact_id = l.contact_id
        order by e.updated_at desc nulls last
        limit 1
     ),
     case
       when lower(coalesce((select segment from nova.contacts ct
                             where ct.tenant_id = l.tenant_id and ct.contact_id = l.contact_id), ''))
            like '%reactiv%' then 'reactivacion'
       else 'renovacion'
     end
   )
 where product_line is null;

alter table nova.leads
  alter column product_line set default 'renovacion';

update nova.leads set product_line = 'renovacion' where product_line is null;

alter table nova.leads
  alter column product_line set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_product_line_check'
  ) then
    alter table nova.leads
      add constraint leads_product_line_check
      check (product_line in ('renovacion', 'reactivacion', 'nuevos', 'microcredito'));
  end if;
end $$;

create index if not exists ix_nova_leads_product_line
  on nova.leads (tenant_id, product_line);

grant select, insert, update, delete on all tables in schema nova to hyperion_nova;

insert into nova.service_migrations(version, name)
values (4, '050-nova-lead-product-line.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 4, migration_name = '050-nova-lead-product-line.sql', updated_at = now()
where service_name = 'nova';
