-- Expand the Access-owned tenant lifecycle feed into Channel-owned storage.
--
-- These relations deliberately have no foreign key to platform.tenants. They
-- are the first local projection used to remove Channel's historical SQL
-- dependency on the Access schema in a later contract/cutover migration.

CREATE TABLE channel_runtime.tenant_snapshots (
  tenant_id uuid PRIMARY KEY,
  status text NOT NULL,
  source_event_id uuid NOT NULL,
  source_version bigint NOT NULL,
  source_updated_at timestamptz NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_tenant_snapshots_status_check CHECK (
    status IN ('active', 'paused', 'archived')
  ),
  CONSTRAINT channel_tenant_snapshots_source_version_check CHECK (
    source_version BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT channel_tenant_snapshots_payload_hash_check CHECK (
    payload_hash ~ '^[a-f0-9]{64}$'
  )
);

CREATE TABLE channel_runtime.access_projection_inbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL,
  envelope_hash text NOT NULL,
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT channel_access_projection_contract_check CHECK (
    event_type = 'access.tenant.snapshot.v1' AND event_version = 1
  ),
  CONSTRAINT channel_access_projection_envelope_hash_check CHECK (
    envelope_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT channel_access_projection_result_check CHECK (
    (processed_at IS NULL AND result IS NULL)
    OR (
      processed_at IS NOT NULL
      AND jsonb_typeof(result) = 'object'
      AND result->>'status' IN ('accepted', 'duplicate', 'stale', 'conflict')
    )
  )
);

CREATE INDEX channel_tenant_snapshots_reconcile_idx
  ON channel_runtime.tenant_snapshots(source_updated_at, tenant_id);

CREATE INDEX channel_access_projection_inbox_tenant_idx
  ON channel_runtime.access_projection_inbox(tenant_id, received_at, id);

REVOKE ALL PRIVILEGES ON TABLE
  channel_runtime.tenant_snapshots,
  channel_runtime.access_projection_inbox
FROM PUBLIC, hyperion_pulso, hyperion_sofia, hyperion_knowledge, hyperion_integration, hyperion_channel;

GRANT SELECT, INSERT, UPDATE ON TABLE
  channel_runtime.tenant_snapshots,
  channel_runtime.access_projection_inbox
TO hyperion_channel;

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (4, '004-access-channel-tenant-projection.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 4, '004-access-channel-tenant-projection.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
