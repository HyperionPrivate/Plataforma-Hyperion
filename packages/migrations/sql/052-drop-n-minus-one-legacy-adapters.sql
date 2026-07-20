-- Append-only: drop N-1 legacy adapter functions/triggers if still present.
-- Mirrors pulso tip 014; clears DEBT-018/019 temporary exceptions for 038.

DROP TRIGGER IF EXISTS trg_agent_inbox_resolve_legacy_pulso_position
  ON agent_runtime.inbox_events;
DROP TRIGGER IF EXISTS trg_pulso_inbox_resolve_legacy_channel_position
  ON pulso_iris.inbox_events;
DROP TRIGGER IF EXISTS trg_pulso_outbox_legacy_source_position
  ON pulso_iris.outbox_events;

DROP FUNCTION IF EXISTS agent_runtime.resolve_legacy_pulso_inbox_position();
DROP FUNCTION IF EXISTS pulso_iris.resolve_legacy_channel_inbox_position();
DROP FUNCTION IF EXISTS pulso_iris.prepare_legacy_message_source_position();
