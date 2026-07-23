-- Provider-owned least-privilege role matrix for the standalone PULSO cell.
-- All runtime identities are created NOLOGIN by bootstrap:database and are
-- activated only after this migration and its structural/ACL verification.

-- The legacy configurable-agenda migration installed these checks NOT VALID
-- and never completed its contract phase. Validation is provider-owned here;
-- failure rolls this whole migration back before any runtime role is activated.
ALTER TABLE pulso_iris.appointments
  VALIDATE CONSTRAINT chk_appointments_manual_verification;
ALTER TABLE pulso_iris.appointments
  VALIDATE CONSTRAINT chk_appointments_verified_evidence;

REVOKE ALL PRIVILEGES ON SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM PUBLIC;

DO $$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'hyperion_pulso',
    'hyperion_sofia',
    'hyperion_knowledge',
    'hyperion_integration',
    'hyperion_channel'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      RAISE EXCEPTION 'Required PULSO runtime role % is missing', runtime_role;
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), runtime_role);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), runtime_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM %I', runtime_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM %I', runtime_role);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM %I', runtime_role);
    EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA platform, pulso_iris, agent_runtime, channel_runtime FROM %I', runtime_role);
  END LOOP;
  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

-- Every PULSO runtime reads the provider-owned readiness marker.
GRANT USAGE ON SCHEMA pulso_iris TO
  hyperion_pulso, hyperion_sofia, hyperion_knowledge, hyperion_integration, hyperion_channel;
GRANT SELECT ON TABLE pulso_iris.schema_version TO
  hyperion_pulso, hyperion_sofia, hyperion_knowledge, hyperion_integration, hyperion_channel;

-- PULSO core owns the product-domain state. Migration metadata remains admin-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pulso_iris TO hyperion_pulso;
REVOKE ALL PRIVILEGES ON TABLE
  pulso_iris.schema_version,
  pulso_iris.service_migrations,
  pulso_iris.migration_ledger
FROM hyperion_pulso;
GRANT SELECT ON TABLE pulso_iris.schema_version TO hyperion_pulso;

-- SOFIA and Prompt Flow share one runtime identity, but only inside their
-- provider-owned configuration and execution stores.
GRANT USAGE ON SCHEMA platform, agent_runtime TO hyperion_sofia;
GRANT SELECT ON TABLE platform.agents, platform.prompt_flows TO hyperion_sofia;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agent_runtime TO hyperion_sofia;
GRANT EXECUTE ON FUNCTION agent_runtime.claim_next_job(text) TO hyperion_sofia;

-- Knowledge and Integration are read-only catalog providers today.
GRANT USAGE ON SCHEMA platform TO hyperion_knowledge, hyperion_integration;
GRANT SELECT ON TABLE platform.knowledge_sources TO hyperion_knowledge;
GRANT SELECT ON TABLE platform.integrations TO hyperion_integration;

-- The WhatsApp channel owns only its delivery/runtime schema.
GRANT USAGE ON SCHEMA channel_runtime TO hyperion_channel;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA channel_runtime TO hyperion_channel;
GRANT EXECUTE ON FUNCTION channel_runtime.claim_next_inbound_event(text) TO hyperion_channel;
GRANT EXECUTE ON FUNCTION channel_runtime.claim_next_outbound_message(text) TO hyperion_channel;

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (2, '002-pulso-runtime-roles.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 2, '002-pulso-runtime-roles.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
