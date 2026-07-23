-- Drop N-1 legacy adapters and their triggers from the autonomous provider schema.
--
-- These SECURITY DEFINER routines bridged Channel/PULSO/SOFIA ledgers for v1
-- writers. After contract cutover they are removed append-only.

DROP TRIGGER IF EXISTS trg_agent_inbox_resolve_legacy_pulso_position
  ON agent_runtime.inbox_events;
DROP TRIGGER IF EXISTS trg_pulso_inbox_resolve_legacy_channel_position
  ON pulso_iris.inbox_events;
DROP TRIGGER IF EXISTS trg_pulso_outbox_legacy_source_position
  ON pulso_iris.outbox_events;

DROP FUNCTION IF EXISTS agent_runtime.resolve_legacy_pulso_inbox_position();
DROP FUNCTION IF EXISTS pulso_iris.resolve_legacy_channel_inbox_position();
DROP FUNCTION IF EXISTS pulso_iris.prepare_legacy_message_source_position();

DO $$
BEGIN
  IF to_regprocedure('agent_runtime.resolve_legacy_pulso_inbox_position()') IS NOT NULL
     OR to_regprocedure('pulso_iris.resolve_legacy_channel_inbox_position()') IS NOT NULL
     OR to_regprocedure('pulso_iris.prepare_legacy_message_source_position()') IS NOT NULL THEN
    RAISE EXCEPTION 'N-1 legacy adapter functions must be dropped';
  END IF;
END
$$;

INSERT INTO pulso_iris.service_migrations(version, name)
VALUES (14, '014-drop-n-minus-one-legacy-adapters.sql')
ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO pulso_iris.schema_version(service_name, current_version, migration_name)
VALUES ('pulso', 14, '014-drop-n-minus-one-legacy-adapters.sql')
ON CONFLICT (service_name) DO UPDATE SET
  current_version = EXCLUDED.current_version,
  migration_name = EXCLUDED.migration_name,
  updated_at = now();
