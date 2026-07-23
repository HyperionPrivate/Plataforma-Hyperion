-- Contract cutover: Knowledge no longer enforces SQL FKs to Access tenants.

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

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (13, '013-contract-knowledge-access-tenant-fks.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 13, '013-contract-knowledge-access-tenant-fks.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
