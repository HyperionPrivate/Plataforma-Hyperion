-- Contract cutover: revoke inherited SOFIA grants on the PULSO Iris control plane.
--
-- SOFIA retains its own agent_runtime.schema_version marker; USAGE/SELECT on
-- pulso_iris was an N-1 readiness bridge (DEBT-027).

REVOKE USAGE ON SCHEMA pulso_iris FROM hyperion_sofia;
REVOKE SELECT ON TABLE pulso_iris.schema_version FROM hyperion_sofia;

DO $$
BEGIN
  IF has_schema_privilege('hyperion_sofia', 'pulso_iris', 'USAGE') THEN
    RAISE EXCEPTION 'hyperion_sofia must not retain USAGE on pulso_iris';
  END IF;
  IF has_table_privilege('hyperion_sofia', 'pulso_iris.schema_version', 'SELECT') THEN
    RAISE EXCEPTION 'hyperion_sofia must not retain SELECT on pulso_iris.schema_version';
  END IF;
END
$$;

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (15, '015-revoke-sofia-pulso-iris-control-plane-grants.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 15, '015-revoke-sofia-pulso-iris-control-plane-grants.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
