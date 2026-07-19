-- Access owns the source state and durable delivery ledger for the two LUMEN
-- projections it provides. The tables deliberately contain no LUMEN schema
-- references: delivery crosses the product boundary only through the published
-- HTTP event contract.

create table if not exists access_runtime.lumen_projection_state (
  projection_kind text not null,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  aggregate_id uuid not null,
  source_version bigint not null,
  source_updated_at timestamptz not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (projection_kind, tenant_id, aggregate_id),
  constraint ck_access_lumen_projection_kind check (
    projection_kind in ('tenant_snapshot', 'operator_grant')
  ),
  constraint ck_access_lumen_projection_version check (
    source_version between 1 and 9007199254740991
  ),
  constraint ck_access_lumen_projection_payload_hash check (
    payload_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint ck_access_lumen_projection_aggregate check (
    (projection_kind = 'tenant_snapshot' and aggregate_id = tenant_id)
    or projection_kind = 'operator_grant'
  )
);

create table if not exists access_runtime.lumen_projection_outbox (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  projection_kind text not null,
  aggregate_id uuid not null,
  source_version bigint not null,
  event_type text not null,
  event_version integer not null default 1,
  payload jsonb not null,
  occurred_at timestamptz not null,
  status text not null default 'queued',
  attempt_count integer not null default 0,
  max_attempts integer not null default 20,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  published_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (projection_kind, tenant_id, aggregate_id, source_version),
  constraint ck_access_lumen_outbox_kind check (
    projection_kind in ('tenant_snapshot', 'operator_grant')
  ),
  constraint ck_access_lumen_outbox_contract check (
    (projection_kind = 'tenant_snapshot' and event_type = ('access' || '.lumen.tenant-snapshot.v1'))
    or
    (projection_kind = 'operator_grant' and event_type = ('access' || '.lumen.operator-grant.v1'))
  ),
  constraint ck_access_lumen_outbox_event_version check (event_version = 1),
  constraint ck_access_lumen_outbox_source_version check (
    source_version between 1 and 9007199254740991
  ),
  constraint ck_access_lumen_outbox_payload check (jsonb_typeof(payload) = 'object'),
  constraint ck_access_lumen_outbox_status check (
    status in ('queued', 'processing', 'retry_scheduled', 'published', 'dead_letter')
  ),
  constraint ck_access_lumen_outbox_attempts check (
    attempt_count between 0 and max_attempts and max_attempts between 1 and 100
  ),
  constraint ck_access_lumen_outbox_lock check (
    (status = 'processing' and locked_at is not null and locked_by is not null)
    or
    (status <> 'processing' and locked_at is null and locked_by is null)
  ),
  constraint ck_access_lumen_outbox_publish check (
    (status = 'published' and published_at is not null)
    or
    (status <> 'published' and published_at is null)
  ),
  constraint ck_access_lumen_outbox_error check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'
  )
);

create index if not exists ix_access_lumen_projection_backfill
  on access_runtime.lumen_projection_state(projection_kind, source_updated_at, tenant_id, aggregate_id);

create index if not exists ix_access_lumen_projection_outbox_claim
  on access_runtime.lumen_projection_outbox(next_attempt_at, created_at, id)
  where status in ('queued', 'processing', 'retry_scheduled');

revoke all on access_runtime.lumen_projection_state from public;
revoke all on access_runtime.lumen_projection_outbox from public;

do $migration$
begin
  if exists (select 1 from pg_roles where rolname = 'hyperion_access') then
    grant select, insert, update on access_runtime.lumen_projection_state to hyperion_access;
    grant select, insert, update on access_runtime.lumen_projection_outbox to hyperion_access;
  end if;
end
$migration$;
