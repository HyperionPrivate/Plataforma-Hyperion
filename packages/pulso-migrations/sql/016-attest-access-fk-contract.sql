-- Durable, provider-owned evidence for the Access FK contract cutover.
-- The migrator inserts the sealed receipt in the same transaction that records
-- this migration. Runtime roles receive no privileges on this table.

CREATE TABLE pulso_iris.access_fk_contract_attestations (
  receipt_sha256 text PRIMARY KEY
    CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  attestation_mode text NOT NULL
    CHECK (attestation_mode IN ('receipt', 'greenfield')),
  deployment_id text
    CHECK (deployment_id IS NULL OR length(btrim(deployment_id)) BETWEEN 3 AND 128),
  environment text
    CHECK (environment IS NULL OR length(btrim(environment)) BETWEEN 3 AND 128),
  pulso_database text,
  access_database text,
  source_revision text
    CHECK (source_revision IS NULL OR (source_revision ~ '^[a-f0-9]{40}$' AND source_revision !~ '^0+$')),
  migration_set_sha256 text NOT NULL
    CHECK (migration_set_sha256 ~ '^[a-f0-9]{64}$'),
  observed_schema_version integer NOT NULL
    CHECK (observed_schema_version BETWEEN 8 AND 15),
  observed_migration text NOT NULL,
  target_schema_version integer NOT NULL
    CHECK (target_schema_version = 16),
  target_migration text NOT NULL
    CHECK (target_migration = '016-attest-access-fk-contract.sql'),
  captured_at timestamptz NOT NULL,
  attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  receipt jsonb NOT NULL
    CHECK (jsonb_typeof(receipt) = 'object'),
  CONSTRAINT access_fk_contract_receipt_binding_check CHECK (
    attestation_mode = 'greenfield'
    OR (
      deployment_id IS NOT NULL
      AND environment IS NOT NULL
      AND pulso_database IS NOT NULL
      AND access_database IS NOT NULL
      AND source_revision IS NOT NULL
    )
  )
);

REVOKE ALL ON TABLE pulso_iris.access_fk_contract_attestations FROM PUBLIC;

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (16, '016-attest-access-fk-contract.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 16, '016-attest-access-fk-contract.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
