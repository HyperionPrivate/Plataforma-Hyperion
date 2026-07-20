-- Append-only contract: drop SOFIA→Access FKs from the global chain.

ALTER TABLE platform.agents
  DROP CONSTRAINT IF EXISTS agents_product_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'platform.agents'::regclass
       AND constraint_record.conname = 'agents_product_id_fkey'
  ) THEN
    RAISE EXCEPTION 'SOFIA must not retain foreign key agents_product_id_fkey';
  END IF;
END
$$;

ALTER TABLE platform.agents
  DROP CONSTRAINT IF EXISTS agents_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'platform.agents'::regclass
       AND constraint_record.conname = 'agents_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'SOFIA must not retain foreign key agents_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE platform.prompt_flows
  DROP CONSTRAINT IF EXISTS prompt_flows_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'platform.prompt_flows'::regclass
       AND constraint_record.conname = 'prompt_flows_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'SOFIA must not retain foreign key prompt_flows_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE agent_runtime.executions
  DROP CONSTRAINT IF EXISTS executions_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'agent_runtime.executions'::regclass
       AND constraint_record.conname = 'executions_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'SOFIA must not retain foreign key executions_tenant_id_fkey';
  END IF;
END
$$;

ALTER TABLE agent_runtime.jobs
  DROP CONSTRAINT IF EXISTS jobs_tenant_id_fkey;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint constraint_record
     WHERE constraint_record.contype = 'f'
       AND constraint_record.conrelid = 'agent_runtime.jobs'::regclass
       AND constraint_record.conname = 'jobs_tenant_id_fkey'
  ) THEN
    RAISE EXCEPTION 'SOFIA must not retain foreign key jobs_tenant_id_fkey';
  END IF;
END
$$;
