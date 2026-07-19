-- Customer routing and flow identifiers are tenant configuration, never product constants.
alter table nova.agencies
  add column if not exists routing_tag text;

alter table nova.campaigns
  drop constraint if exists campaigns_product_flow_check;
alter table nova.campaigns
  add constraint campaigns_product_flow_check
  check (product_flow ~ '^[a-z][a-z0-9_-]{1,79}$');

alter table nova.agent_configs
  drop constraint if exists agent_configs_product_flow_check;
alter table nova.agent_configs
  add constraint agent_configs_product_flow_check
  check (product_flow ~ '^[a-z][a-z0-9_-]{1,79}$');

alter table nova.leads
  drop constraint if exists leads_product_line_check;
alter table nova.leads
  alter column product_line drop default;
alter table nova.leads
  add constraint leads_product_line_check
  check (product_line ~ '^[a-z][a-z0-9_-]{1,79}$');

create unique index if not exists ux_nova_agencies_routing_tag
  on nova.agencies (tenant_id, routing_tag)
  where routing_tag is not null;

grant select, insert, update, delete on all tables in schema nova to hyperion_nova;

insert into nova.service_migrations(version, name)
values (6, '053-nova-tenant-owned-routing.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 6, migration_name = '053-nova-tenant-owned-routing.sql', updated_at = now()
where service_name = 'nova';
