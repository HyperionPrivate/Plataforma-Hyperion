-- Expand the Access-owned tenant lifecycle feed into SOFIA-owned storage.
--
-- These relations deliberately have no foreign key to platform.tenants. They
-- are the local projection used to remove SOFIA's historical SQL dependency
-- on the Access schema in a later contract/cutover migration.

CREATE TABLE agent_runtime.tenant_snapshots (
  tenant_id uuid PRIMARY KEY,
  status text NOT NULL,
  source_event_id uuid NOT NULL,
  source_version bigint NOT NULL,
  source_updated_at timestamptz NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runtime_tenant_snapshots_status_check CHECK (
    status IN ('active', 'paused', 'archived')
  ),
  CONSTRAINT agent_runtime_tenant_snapshots_source_version_check CHECK (
    source_version BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT agent_runtime_tenant_snapshots_payload_hash_check CHECK (
    payload_hash ~ '^[a-f0-9]{64}$'
  )
);

CREATE TABLE agent_runtime.access_projection_inbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  envelope_hash text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT agent_runtime_access_projection_contract_check CHECK (
    event_type = 'access.tenant.snapshot.v1' AND event_version = 1
  ),
  CONSTRAINT agent_runtime_access_projection_envelope_hash_check CHECK (
    envelope_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT agent_runtime_access_projection_result_check CHECK (
    (processed_at IS NULL AND result IS NULL)
    OR (
      processed_at IS NOT NULL
      AND jsonb_typeof(result) = 'object'
      AND result->>'status' IN ('accepted', 'duplicate', 'stale', 'conflict')
    )
  )
);

CREATE INDEX agent_runtime_tenant_snapshots_reconcile_idx
  ON agent_runtime.tenant_snapshots(source_updated_at, tenant_id);

CREATE INDEX agent_runtime_access_projection_inbox_tenant_idx
  ON agent_runtime.access_projection_inbox(tenant_id, received_at, id);

REVOKE ALL PRIVILEGES ON TABLE
  agent_runtime.tenant_snapshots,
  agent_runtime.access_projection_inbox
FROM PUBLIC, hyperion_pulso, hyperion_knowledge, hyperion_integration, hyperion_channel;

GRANT SELECT, INSERT, UPDATE ON TABLE
  agent_runtime.tenant_snapshots,
  agent_runtime.access_projection_inbox
TO hyperion_sofia;

INSERT INTO agent_runtime.schema_version(service_name, current_version, migration_name)
VALUES ('sofia', 2, '006-access-sofia-tenant-projection.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (6, '006-access-sofia-tenant-projection.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 6, '006-access-sofia-tenant-projection.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
