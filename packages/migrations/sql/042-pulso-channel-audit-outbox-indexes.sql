-- hyperion:no-transaction
-- Online index phase for the nullable audit/delivery outbox dedupe keys added
-- by 041.  Each block autocommits so PostgreSQL can build concurrently.  A
-- replay removes incomplete remnants and the final catalog guard prevents the
-- migration ledger from advancing unless both definitions are valid.

-- hyperion:statement
drop index concurrently if exists pulso_iris.uq_pulso_outbox_dedupe;

-- hyperion:statement
create unique index concurrently uq_pulso_outbox_dedupe
  on pulso_iris.outbox_events (tenant_id, dedupe_key)
  where dedupe_key is not null;

-- hyperion:statement
drop index concurrently if exists channel_runtime.uq_channel_outbox_dedupe;

-- hyperion:statement
create unique index concurrently uq_channel_outbox_dedupe
  on channel_runtime.outbox_events (tenant_id, dedupe_key)
  where dedupe_key is not null;

-- hyperion:statement
do $migration$
begin
  if exists (
    select 1
      from (
        values
          ('pulso_iris'::text, 'uq_pulso_outbox_dedupe'::text),
          ('channel_runtime'::text, 'uq_channel_outbox_dedupe'::text)
      ) as expected(schema_name, index_name)
      left join pg_catalog.pg_namespace index_namespace
        on index_namespace.nspname = expected.schema_name
      left join pg_catalog.pg_class index_class
        on index_class.relnamespace = index_namespace.oid
       and index_class.relname = expected.index_name
      left join pg_catalog.pg_index index_info
        on index_info.indexrelid = index_class.oid
     where index_info.indexrelid is null
        or not index_info.indisvalid
        or not index_info.indisready
        or not index_info.indisunique
        or pg_catalog.pg_get_indexdef(index_info.indexrelid) not like
          'CREATE UNIQUE INDEX % ON %.outbox_events USING btree (tenant_id, dedupe_key) WHERE (dedupe_key IS NOT NULL)'
  ) then
    raise exception 'PULSO/Channel outbox dedupe indexes are missing or invalid';
  end if;
end;
$migration$;
