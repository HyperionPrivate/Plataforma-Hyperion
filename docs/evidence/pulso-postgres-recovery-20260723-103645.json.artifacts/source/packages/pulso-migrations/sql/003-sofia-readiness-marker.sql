-- Expand SOFIA readiness away from the PULSO core schema marker.
--
-- Current SOFIA images read only this owner-local marker. The legacy SELECT
-- grant on pulso_iris.schema_version is intentionally retained for N-1 images
-- until the provider-owned rolling upgrade/rollback rehearsal has completed.

CREATE TABLE agent_runtime.schema_version (
  service_name text PRIMARY KEY,
  current_version integer NOT NULL CHECK (current_version > 0),
  migration_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sofia_schema_version_service_name_check CHECK (service_name = 'sofia')
);

REVOKE ALL PRIVILEGES ON TABLE agent_runtime.schema_version FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE agent_runtime.schema_version FROM
  hyperion_pulso, hyperion_sofia, hyperion_knowledge, hyperion_integration, hyperion_channel;
GRANT SELECT ON TABLE agent_runtime.schema_version TO hyperion_sofia;

INSERT INTO agent_runtime.schema_version(service_name, current_version, migration_name)
VALUES ('sofia', 1, '003-sofia-readiness-marker.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (3, '003-sofia-readiness-marker.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 3, '003-sofia-readiness-marker.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
