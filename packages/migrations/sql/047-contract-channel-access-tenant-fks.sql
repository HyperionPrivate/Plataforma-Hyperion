-- Append-only contract: drop Channel→Access tenant FKs from the global chain.
-- Mirrors pulso tip 009 for environments still on packages/migrations.

ALTER TABLE channel_runtime.connections
  DROP CONSTRAINT IF EXISTS connections_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'channel_runtime.connections'::regclass
       AND constraint_record.conname = 'connections_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'Channel must not retain foreign key connections_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE channel_runtime.delivery_receipts
  DROP CONSTRAINT IF EXISTS delivery_receipts_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'channel_runtime.delivery_receipts'::regclass
       AND constraint_record.conname = 'delivery_receipts_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'Channel must not retain foreign key delivery_receipts_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE channel_runtime.inbound_events
  DROP CONSTRAINT IF EXISTS inbound_events_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'channel_runtime.inbound_events'::regclass
       AND constraint_record.conname = 'inbound_events_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'Channel must not retain foreign key inbound_events_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE channel_runtime.outbound_messages
  DROP CONSTRAINT IF EXISTS outbound_messages_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'channel_runtime.outbound_messages'::regclass
       AND constraint_record.conname = 'outbound_messages_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'Channel must not retain foreign key outbound_messages_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE channel_runtime.thread_bindings
  DROP CONSTRAINT IF EXISTS thread_bindings_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'channel_runtime.thread_bindings'::regclass
       AND constraint_record.conname = 'thread_bindings_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'Channel must not retain foreign key thread_bindings_tenant_id_fkey';
  END IF;
END
$$;
