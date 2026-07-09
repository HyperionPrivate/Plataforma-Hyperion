create extension if not exists pgcrypto;

alter table platform.operators
  add column if not exists password_hash text,
  add column if not exists last_login_at timestamptz;

create table if not exists platform.operator_sessions (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references platform.operators(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists idx_operator_sessions_operator on platform.operator_sessions(operator_id);
create index if not exists idx_operator_sessions_expires on platform.operator_sessions(expires_at);

create table if not exists platform.operator_tenants (
  operator_id uuid not null references platform.operators(id) on delete cascade,
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (operator_id, tenant_id)
);
