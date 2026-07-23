-- Contract cutover: Integration no longer enforces SQL FKs to Access tenants.

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

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (10, '010-contract-integration-access-tenant-fks.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 10, '010-contract-integration-access-tenant-fks.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
