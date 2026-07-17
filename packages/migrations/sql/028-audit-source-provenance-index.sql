-- hyperion:no-transaction
-- Each block is sent as an independent autocommit statement. A process death
-- can leave a concurrent index invalid; replay first removes any remnant,
-- rebuilds it, and validates the catalog state before the runner records 028.

-- hyperion:statement
drop index concurrently if exists audit_runtime.ix_audit_inbox_source_received;

-- hyperion:statement
create index concurrently ix_audit_inbox_source_received
  on audit_runtime.inbox_events(source_service, event_type, received_at desc);

-- hyperion:statement
do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_class index_class
      join pg_catalog.pg_namespace index_namespace
        on index_namespace.oid = index_class.relnamespace
      join pg_catalog.pg_index index_info
        on index_info.indexrelid = index_class.oid
     where index_namespace.nspname = 'audit_runtime'
       and index_class.relname = 'ix_audit_inbox_source_received'
       and index_info.indisvalid
       and index_info.indisready
       and pg_catalog.pg_get_indexdef(index_info.indexrelid) =
         'CREATE INDEX ix_audit_inbox_source_received ON audit_runtime.inbox_events USING btree (source_service, event_type, received_at DESC)'
  ) then
    raise exception 'Audit provenance index is missing or invalid';
  end if;
end;
$$;
