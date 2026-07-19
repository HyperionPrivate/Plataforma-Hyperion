-- Provider-owned, product-neutral tenant snapshots. The producer deliberately
-- excludes Access bootstrap tenants and exposes no product enablement or
-- customer-specific metadata.

create table access_runtime.tenant_projection_state (
  tenant_id uuid primary key references platform.tenants(id) on delete cascade,
  source_version bigint not null,
  source_updated_at timestamptz not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_access_tenant_projection_version check (
    source_version between 1 and 9007199254740991
  ),
  constraint ck_access_tenant_projection_payload_hash check (
    payload_hash ~ '^[a-f0-9]{64}$'
  )
);

create table access_runtime.tenant_projection_outbox (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
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
  unique (tenant_id, source_version),
  constraint ck_access_tenant_outbox_contract check (
    event_type = ('access' || '.tenant.snapshot.v1') and event_version = 1
  ),
  constraint ck_access_tenant_outbox_source_version check (
    source_version between 1 and 9007199254740991
  ),
  constraint ck_access_tenant_outbox_payload check (
    jsonb_typeof(payload) = 'object'
    and payload->>'tenantId' = tenant_id::text
    and (payload->>'sourceVersion')::bigint = source_version
    and payload->>'status' in ('active', 'paused', 'archived')
  ),
  constraint ck_access_tenant_outbox_status check (
    status in ('queued', 'processing', 'retry_scheduled', 'published', 'dead_letter')
  ),
  constraint ck_access_tenant_outbox_attempts check (
    attempt_count between 0 and max_attempts and max_attempts between 1 and 100
  ),
  constraint ck_access_tenant_outbox_lock check (
    (status = 'processing' and locked_at is not null and locked_by is not null)
    or (status <> 'processing' and locked_at is null and locked_by is null)
  ),
  constraint ck_access_tenant_outbox_publish check (
    (status = 'published' and published_at is not null)
    or (status <> 'published' and published_at is null)
  ),
  constraint ck_access_tenant_outbox_error check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'
  )
);

create index ix_access_tenant_projection_reconcile
  on access_runtime.tenant_projection_state(source_updated_at, tenant_id);
create index ix_access_tenant_projection_outbox_claim
  on access_runtime.tenant_projection_outbox(next_attempt_at, created_at, id)
  where status in ('queued', 'processing', 'retry_scheduled');

revoke all privileges on table
  access_runtime.tenant_projection_state,
  access_runtime.tenant_projection_outbox
from public, hyperion_identity, hyperion_tenant;

grant select, insert, update on table
  access_runtime.tenant_projection_state,
  access_runtime.tenant_projection_outbox
to hyperion_identity;
