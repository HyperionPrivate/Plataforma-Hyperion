-- Fresh provider-owned Audit baseline. This SQL is intentionally self-contained:
-- it has no foreign keys to Access, NOVA, LUMEN or PULSO logical databases.

CREATE SCHEMA platform AUTHORIZATION hyperion_audit_migrator;
CREATE SCHEMA audit_runtime AUTHORIZATION hyperion_audit_migrator;

REVOKE ALL PRIVILEGES ON SCHEMA platform, audit_runtime FROM PUBLIC;

CREATE TABLE platform.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor_id text,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 160),
  entity_type text NOT NULL CHECK (char_length(entity_type) BETWEEN 2 AND 80),
  entity_id text CHECK (entity_id IS NULL OR char_length(entity_id) BETWEEN 1 AND 160),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  source_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_tenant_created
  ON platform.audit_events(tenant_id, created_at DESC);
CREATE UNIQUE INDEX uq_audit_events_source_event
  ON platform.audit_events(source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE TABLE audit_runtime.inbox_events (
  event_id uuid PRIMARY KEY,
  tenant_id uuid,
  source_service text NOT NULL CHECK (char_length(source_service) BETWEEN 1 AND 80),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 3 AND 160),
  event_version integer NOT NULL CHECK (event_version BETWEEN 1 AND 1000),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  contract_hash text NOT NULL CHECK (contract_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_audit_inbox_source_contract CHECK (
    (source_service = 'nova-core-service' AND event_type = 'nova.audit.event.record.v1')
    OR (source_service = 'sofia-automation' AND event_type = 'sofia.audit.event.record.v1')
    OR (source_service = 'lumen-service' AND event_type = 'lumen.audit.event.record.v1')
    OR (source_service = 'pulso-iris-service' AND event_type = 'pulso.audit.event.record.v1')
    OR (source_service = 'whatsapp-channel-service' AND event_type = 'channel.audit.event.record.v1')
    OR (source_service = 'legacy-unknown' AND event_type = 'legacy.audit.event.record.v1')
  )
);

CREATE INDEX ix_audit_inbox_tenant_received
  ON audit_runtime.inbox_events(tenant_id, received_at DESC);
CREATE INDEX ix_audit_inbox_source_received
  ON audit_runtime.inbox_events(source_service, event_type, received_at DESC);

CREATE TABLE audit_runtime.migration_ledger (
  name text PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyperion_audit') THEN
    RAISE EXCEPTION 'Required Audit runtime role hyperion_audit is missing';
  END IF;
  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM hyperion_audit', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hyperion_audit', current_database());
END
$$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform, audit_runtime FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform, audit_runtime FROM hyperion_audit;
GRANT USAGE ON SCHEMA platform, audit_runtime TO hyperion_audit;
GRANT SELECT, INSERT ON TABLE platform.audit_events TO hyperion_audit;
GRANT SELECT, INSERT ON TABLE audit_runtime.inbox_events TO hyperion_audit;
GRANT SELECT ON TABLE audit_runtime.migration_ledger TO hyperion_audit;
