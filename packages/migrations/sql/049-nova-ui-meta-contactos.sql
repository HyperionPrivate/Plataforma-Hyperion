-- NOVA Ops UI: meta diaria de contactos (piloto Coopfuturo → Hyperion)
alter table nova.compliance_settings
  add column if not exists meta_contactos_hoy integer not null default 0
    check (meta_contactos_hoy >= 0);

comment on column nova.compliance_settings.meta_contactos_hoy is
  'Meta operativa de contactos por día (0 = sin meta). Usada por Dashboard Meta vs resultado.';

grant select, insert, update, delete on all tables in schema nova to hyperion_nova;

insert into nova.service_migrations(version, name)
values (3, '049-nova-ui-meta-contactos.sql')
on conflict (version) do update set name = excluded.name;

update nova.schema_version
set current_version = 3, migration_name = '049-nova-ui-meta-contactos.sql', updated_at = now()
where service_name = 'nova';
