-- Append-only contract: drop Integration→Access tenant FKs from the global chain.

ALTER TABLE platform.integrations
  DROP CONSTRAINT IF EXISTS integrations_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'platform.integrations'::regclass
       AND constraint_record.conname = 'integrations_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'Integration must not retain foreign key integrations_tenant_id_fkey';
  END IF;
END
$$;
