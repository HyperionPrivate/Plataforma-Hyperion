-- Provider-owned fresh baseline for Access/SSO and neutral tenant provisioning.
-- Legacy schema names are retained inside the isolated hyperion_access logical
-- database so Identity and Tenant can move without a flag-day SQL rewrite.

create schema if not exists platform;
create schema if not exists access_runtime;

revoke all privileges on schema platform from public;
revoke all privileges on schema access_runtime from public;
revoke create on schema public from public;

create table platform.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_access_tenant_slug check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

create table platform.operators (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  role text not null default 'advisor',
  status text not null default 'active' check (status in ('active', 'disabled')),
  password_hash text,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_access_operator_email check (email = lower(email) and email ~ '^[^[:space:]@]+@[^[:space:]@]+$'),
  constraint ck_access_operator_role check (role in ('admin', 'coordinator', 'advisor', 'auditor'))
);

create table platform.operator_sessions (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references platform.operators(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint ck_access_session_expiry check (expires_at > created_at),
  constraint ck_access_session_revoke check (revoked_at is null or revoked_at >= created_at)
);

create index ix_access_sessions_operator on platform.operator_sessions(operator_id);
create index ix_access_sessions_expiry on platform.operator_sessions(expires_at) where revoked_at is null;

create table platform.operator_tenants (
  operator_id uuid not null references platform.operators(id) on delete cascade,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (operator_id, tenant_id)
);

create function access_runtime.valid_grant_values(values_input text[], expression text)
returns boolean
language sql
immutable
parallel safe
as $function$
  select cardinality(values_input) > 0
     and cardinality(values_input) <= 128
     and not exists (
       select 1 from unnest(values_input) value
        where value is null or value !~ expression
     )
     and (select count(distinct value) from unnest(values_input) value) = cardinality(values_input)
$function$;

revoke execute on function access_runtime.valid_grant_values(text[], text) from public;

create table access_runtime.product_grants (
  operator_id uuid not null references platform.operators(id) on delete cascade,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  product_id text not null,
  roles text[] not null,
  capabilities text[] not null,
  active boolean not null default true,
  granted_by uuid not null references platform.operators(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (operator_id, tenant_id, product_id),
  constraint ck_access_product_id check (product_id ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  constraint ck_access_product_roles check (
    cardinality(roles) <= 32
    and access_runtime.valid_grant_values(roles, '^[a-z][a-z0-9_-]{1,63}$')
  ),
  constraint ck_access_product_capabilities check (
    access_runtime.valid_grant_values(capabilities, '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$')
  )
);

create index ix_access_grants_operator_active
  on access_runtime.product_grants(operator_id, active, tenant_id, product_id);
create index ix_access_grants_tenant_product
  on access_runtime.product_grants(tenant_id, product_id) where active;

create table access_runtime.bootstrap_tenants (
  bootstrap_key text primary key,
  tenant_id uuid not null unique references platform.tenants(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint ck_access_bootstrap_tenant_key check (bootstrap_key = 'platform-control')
);

insert into platform.tenants (id, slug, display_name, status, metadata)
values (
  '00000000-0000-4000-8000-000000000001'::uuid,
  'hyperion-platform-control',
  'Hyperion Platform Control',
  'active',
  '{"owner":"access-migrations","purpose":"platform-control","customerFacing":false}'::jsonb
);

insert into access_runtime.bootstrap_tenants (bootstrap_key, tenant_id)
values ('platform-control', '00000000-0000-4000-8000-000000000001'::uuid);

create table access_runtime.lumen_projection_state (
  projection_kind text not null,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  aggregate_id uuid not null,
  source_version bigint not null,
  source_updated_at timestamptz not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (projection_kind, tenant_id, aggregate_id),
  constraint ck_access_lumen_projection_kind check (projection_kind in ('tenant_snapshot', 'operator_grant')),
  constraint ck_access_lumen_projection_version check (source_version between 1 and 9007199254740991),
  constraint ck_access_lumen_projection_payload_hash check (payload_hash ~ '^[a-f0-9]{64}$'),
  constraint ck_access_lumen_projection_aggregate check (
    (projection_kind = 'tenant_snapshot' and aggregate_id = tenant_id)
    or projection_kind = 'operator_grant'
  )
);

create table access_runtime.lumen_projection_outbox (
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
  constraint ck_access_lumen_outbox_kind check (projection_kind in ('tenant_snapshot', 'operator_grant')),
  constraint ck_access_lumen_outbox_contract check (
    (projection_kind = 'tenant_snapshot' and event_type = ('access' || '.lumen.tenant-snapshot.v1'))
    or (projection_kind = 'operator_grant' and event_type = ('access' || '.lumen.operator-grant.v1'))
  ),
  constraint ck_access_lumen_outbox_event_version check (event_version = 1),
  constraint ck_access_lumen_outbox_source_version check (source_version between 1 and 9007199254740991),
  constraint ck_access_lumen_outbox_payload check (jsonb_typeof(payload) = 'object'),
  constraint ck_access_lumen_outbox_status check (
    status in ('queued', 'processing', 'retry_scheduled', 'published', 'dead_letter')
  ),
  constraint ck_access_lumen_outbox_attempts check (
    attempt_count between 0 and max_attempts and max_attempts between 1 and 100
  ),
  constraint ck_access_lumen_outbox_lock check (
    (status = 'processing' and locked_at is not null and locked_by is not null)
    or (status <> 'processing' and locked_at is null and locked_by is null)
  ),
  constraint ck_access_lumen_outbox_publish check (
    (status = 'published' and published_at is not null)
    or (status <> 'published' and published_at is null)
  ),
  constraint ck_access_lumen_outbox_error check (
    last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'
  )
);

create index ix_access_lumen_projection_backfill
  on access_runtime.lumen_projection_state(projection_kind, source_updated_at, tenant_id, aggregate_id);
create index ix_access_lumen_projection_outbox_claim
  on access_runtime.lumen_projection_outbox(next_attempt_at, created_at, id)
  where status in ('queued', 'processing', 'retry_scheduled');
