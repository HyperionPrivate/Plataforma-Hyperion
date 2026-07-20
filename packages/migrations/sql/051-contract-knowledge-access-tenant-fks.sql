-- Append-only contract: drop Knowledge→Access tenant FKs from the global chain.

ALTER TABLE platform.knowledge_sources
  DROP CONSTRAINT IF EXISTS knowledge_sources_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'platform.knowledge_sources'::regclass
       AND constraint_record.conname = 'knowledge_sources_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'Knowledge must not retain foreign key knowledge_sources_tenant_id_fkey';
  END IF;
END
$$;
