-- hyperion:no-transaction
-- El indice parcial se construye fuera de transaccion para no bloquear las
-- escrituras LUMEN durante el scan. Cada bloque es autocommit e idempotente.

-- hyperion:statement
drop index concurrently if exists lumen.idx_lumen_processing_attempts_cleanup_pending;

-- hyperion:statement
create index concurrently idx_lumen_processing_attempts_cleanup_pending
  on lumen.processing_attempts(cleanup_owner, created_at, id)
  where status = 'cleanup_pending' and cleanup_protocol = 'deterministic_v2';

-- hyperion:statement
do $$
declare
  index_definition text;
begin
  select pg_get_indexdef(index_catalog.indexrelid)
    into index_definition
    from pg_index index_catalog
   where index_catalog.indexrelid = 'lumen.idx_lumen_processing_attempts_cleanup_pending'::regclass
     and index_catalog.indisvalid
     and index_catalog.indisready;

  if index_definition is null
    or index_definition !~ 'USING btree \(cleanup_owner, created_at, id\)'
    or index_definition !~ 'WHERE \(\(status = ''cleanup_pending''::text\) AND \(cleanup_protocol = ''deterministic_v2''::text\)\)' then
    raise exception 'invalid LUMEN cleanup-pending index definition';
  end if;
end
$$;

-- hyperion:statement
insert into lumen.service_migrations (version, name)
values (33, '033-lumen-audio-cleanup-index.sql')
on conflict (version) do update set name = excluded.name;

-- hyperion:statement
insert into lumen.schema_version (service_name, current_version, migration_name)
values ('lumen', 33, '033-lumen-audio-cleanup-index.sql')
on conflict (service_name) do update set
  current_version = greatest(lumen.schema_version.current_version, excluded.current_version),
  migration_name = case
    when excluded.current_version >= lumen.schema_version.current_version then excluded.migration_name
    else lumen.schema_version.migration_name
  end,
  updated_at = now();
