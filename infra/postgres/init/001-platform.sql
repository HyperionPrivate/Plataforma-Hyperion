create extension if not exists pgcrypto;

create schema if not exists platform;

create table if not exists platform.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.operators (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references platform.tenants(id) on delete set null,
  email text not null unique,
  display_name text not null,
  role text not null default 'operator',
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  status text not null default 'building' check (status in ('foundation', 'building', 'active', 'paused')),
  owner_service text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references platform.tenants(id) on delete cascade,
  product_id uuid references platform.products(id) on delete set null,
  code text not null,
  name text not null,
  channel text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'retired')),
  runtime_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists platform.prompt_flows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references platform.tenants(id) on delete cascade,
  agent_id uuid references platform.agents(id) on delete cascade,
  name text not null,
  version integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references platform.tenants(id) on delete cascade,
  name text not null,
  source_type text not null,
  status text not null default 'pending' check (status in ('pending', 'indexing', 'ready', 'failed', 'archived')),
  checksum text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references platform.tenants(id) on delete cascade,
  provider text not null,
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'failed', 'archived')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform.audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references platform.tenants(id) on delete set null,
  actor_id text,
  event_type text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agents_tenant_id on platform.agents(tenant_id);
create index if not exists idx_prompt_flows_agent_id on platform.prompt_flows(agent_id);
create index if not exists idx_knowledge_sources_tenant_id on platform.knowledge_sources(tenant_id);
create index if not exists idx_integrations_tenant_id on platform.integrations(tenant_id);
create index if not exists idx_audit_events_tenant_created on platform.audit_events(tenant_id, created_at desc);
