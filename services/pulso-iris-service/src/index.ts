import {
  envelope,
  pulsoIrisAgentCode,
  pulsoIrisCatalog,
  pulsoIrisOperationalKpisSchema,
  pulsoIrisProductCode
} from "@hyperion/contracts";
import { startService, type RouteRegistrar } from "@hyperion/service-runtime";

const tenantParamPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const registerRoutes: RouteRegistrar = async (app, context) => {
  if (context.db) {
    await ensurePulsoIrisDatabase(context.db);
  }

  app.get("/v1/pulso-iris/health", async (request) => {
    return envelope({
      service: "pulso-iris-service",
      product: pulsoIrisProductCode,
      agent: pulsoIrisAgentCode,
      status: "ok"
    }, request.id);
  });

  app.get("/v1/pulso-iris/catalog", async (request) => {
    return envelope(pulsoIrisCatalog, request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/overview", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(`
      select
        (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and status = 'active') as "conversationsActive",
        (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and status in ('resolved', 'closed') and date(updated_at) = current_date) as "conversationsResolvedToday",
        (select count(*)::int from pulso_iris.appointments where tenant_id = $1 and status in ('verified', 'confirmed') and date(updated_at) = current_date) as "appointmentsVerifiedToday",
        (select count(*)::int from pulso_iris.handoffs where tenant_id = $1 and status in ('open', 'assigned', 'in_progress')) as "handoffsOpen",
        (select count(*)::int from pulso_iris.rpa_actions where tenant_id = $1 and status = 'queued') as "rpaActionsQueued",
        (select count(*)::int from pulso_iris.rpa_actions where tenant_id = $1 and status = 'deferred') as "rpaActionsDeferred"
    `, [tenantId]);

    const kpis = pulsoIrisOperationalKpisSchema.parse(result.rows[0]);

    return envelope({
      tenantId,
      product: pulsoIrisCatalog.product,
      agent: pulsoIrisCatalog.agent,
      kpis
    }, request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/conversations", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(`
      select
        id,
        tenant_id as "tenantId",
        patient_id as "patientId",
        channel,
        direction,
        status,
        primary_intent as "primaryIntent",
        started_at as "startedAt",
        ended_at as "endedAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from pulso_iris.conversations
      where tenant_id = $1
      order by started_at desc
      limit 100
    `, [tenantId]);

    return envelope(result.rows, request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/appointments", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(`
      select
        id,
        tenant_id as "tenantId",
        patient_id as "patientId",
        conversation_id as "conversationId",
        site_id as "siteId",
        professional_id as "professionalId",
        payer_id as "payerId",
        appointment_type as "appointmentType",
        status,
        scheduled_at as "scheduledAt",
        legacy_reference as "legacyReference",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from pulso_iris.appointments
      where tenant_id = $1
      order by coalesce(scheduled_at, created_at) desc
      limit 100
    `, [tenantId]);

    return envelope(result.rows, request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/handoffs", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(`
      select
        id,
        tenant_id as "tenantId",
        patient_id as "patientId",
        conversation_id as "conversationId",
        trigger_code as "triggerCode",
        priority,
        status,
        summary,
        sla_due_at as "slaDueAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from pulso_iris.handoffs
      where tenant_id = $1
      order by created_at desc
      limit 100
    `, [tenantId]);

    return envelope(result.rows, request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/rpa/actions", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(`
      select
        id,
        tenant_id as "tenantId",
        appointment_id as "appointmentId",
        conversation_id as "conversationId",
        action_type as "actionType",
        status,
        priority,
        idempotency_key as "idempotencyKey",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from pulso_iris.rpa_actions
      where tenant_id = $1
      order by created_at desc
      limit 100
    `, [tenantId]);

    return envelope(result.rows, request.id);
  });
};

function readTenantId(params: unknown): string | undefined {
  const tenantId = typeof params === "object" && params !== null && "tenantId" in params
    ? String((params as { tenantId?: unknown }).tenantId)
    : undefined;

  return tenantId && tenantParamPattern.test(tenantId) ? tenantId : undefined;
}

async function ensurePulsoIrisDatabase(db: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  await db.query(`
    create extension if not exists pgcrypto;
    create schema if not exists pulso_iris;

    insert into platform.products (code, name, status, owner_service, metadata)
    values (
      'PULSO_IRIS',
      'PULSO IRIS',
      'building',
      'pulso-iris-service',
      '{"source":"req_pulso_iris.md","agent":"SOFIA"}'::jsonb
    )
    on conflict (code) do update set
      name = excluded.name,
      status = excluded.status,
      owner_service = excluded.owner_service,
      metadata = platform.products.metadata || excluded.metadata,
      updated_at = now();

    insert into platform.agents (tenant_id, product_id, code, name, channel, status, runtime_config)
    select
      null,
      p.id,
      'SOFIA',
      'Sofia',
      'voice_whatsapp',
      'draft',
      '{"product":"PULSO_IRIS","mode":"foundation","realProvidersEnabled":false}'::jsonb
    from platform.products p
    where p.code = 'PULSO_IRIS'
      and not exists (
        select 1
        from platform.agents a
        where a.tenant_id is null
          and a.code = 'SOFIA'
      );

    create table if not exists pulso_iris.sites (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      name text not null,
      city text,
      status text not null default 'active' check (status in ('active', 'paused')),
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists pulso_iris.professionals (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      name text not null,
      professional_type text not null check (professional_type in ('ophthalmologist', 'optometrist')),
      status text not null default 'active' check (status in ('active', 'paused')),
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists pulso_iris.payers (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      name text not null,
      payer_group text not null check (payer_group in ('eps', 'private_prepaid', 'policy', 'particular', 'other')),
      requires_authorization boolean not null default false,
      status text not null default 'active' check (status in ('active', 'paused')),
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists pulso_iris.administrative_patients (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      status text not null default 'active' check (status in ('active', 'inactive_12m', 'waiting_list', 'high_noshow_risk', 'partial_optout', 'total_optout', 'data_cleanup')),
      document_type text,
      document_number_hash text,
      document_number_masked text,
      full_name text,
      preferred_channel text check (preferred_channel in ('voice', 'whatsapp')),
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists pulso_iris.conversations (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      patient_id uuid references pulso_iris.administrative_patients(id) on delete set null,
      channel text not null check (channel in ('voice', 'whatsapp')),
      direction text not null default 'inbound' check (direction in ('inbound', 'outbound')),
      status text not null default 'active' check (status in ('active', 'resolved', 'handoff_required', 'closed')),
      primary_intent text,
      started_at timestamptz not null default now(),
      ended_at timestamptz,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists pulso_iris.messages (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null references pulso_iris.conversations(id) on delete cascade,
      sender text not null check (sender in ('sofia', 'patient', 'advisor', 'system')),
      body text not null,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists pulso_iris.appointments (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      patient_id uuid references pulso_iris.administrative_patients(id) on delete set null,
      conversation_id uuid references pulso_iris.conversations(id) on delete set null,
      site_id uuid references pulso_iris.sites(id) on delete set null,
      professional_id uuid references pulso_iris.professionals(id) on delete set null,
      payer_id uuid references pulso_iris.payers(id) on delete set null,
      appointment_type text,
      status text not null default 'offered' check (status in ('offered', 'registered', 'verified', 'confirmed', 'rescheduled', 'cancelled', 'no_show')),
      scheduled_at timestamptz,
      legacy_reference text,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists pulso_iris.rpa_actions (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      appointment_id uuid references pulso_iris.appointments(id) on delete set null,
      conversation_id uuid references pulso_iris.conversations(id) on delete set null,
      action_type text not null check (action_type in ('check_availability', 'register_appointment', 'cancel', 'reschedule', 'confirm', 'sweep', 'create_patient')),
      status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'verification_failed', 'deferred', 'failed')),
      priority integer not null default 50,
      idempotency_key text not null,
      payload jsonb not null default '{}'::jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (tenant_id, idempotency_key)
    );

    create table if not exists pulso_iris.handoffs (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      patient_id uuid references pulso_iris.administrative_patients(id) on delete set null,
      conversation_id uuid references pulso_iris.conversations(id) on delete set null,
      trigger_code text not null,
      priority text not null default 'medium' check (priority in ('max', 'high', 'medium', 'low')),
      status text not null default 'open' check (status in ('open', 'assigned', 'in_progress', 'resolved', 'returned_to_sofia')),
      summary text,
      sla_due_at timestamptz,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists pulso_iris.operational_kpi_snapshots (
      id uuid primary key default gen_random_uuid(),
      tenant_id uuid not null references platform.tenants(id) on delete cascade,
      snapshot_at timestamptz not null default now(),
      metrics jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create index if not exists idx_pulso_iris_sites_tenant on pulso_iris.sites(tenant_id);
    create index if not exists idx_pulso_iris_professionals_tenant on pulso_iris.professionals(tenant_id);
    create index if not exists idx_pulso_iris_payers_tenant on pulso_iris.payers(tenant_id);
    create index if not exists idx_pulso_iris_patients_tenant on pulso_iris.administrative_patients(tenant_id);
    create index if not exists idx_pulso_iris_conversations_tenant_started on pulso_iris.conversations(tenant_id, started_at desc);
    create index if not exists idx_pulso_iris_appointments_tenant_scheduled on pulso_iris.appointments(tenant_id, scheduled_at desc);
    create index if not exists idx_pulso_iris_rpa_actions_tenant_status on pulso_iris.rpa_actions(tenant_id, status, created_at desc);
    create index if not exists idx_pulso_iris_handoffs_tenant_status on pulso_iris.handoffs(tenant_id, status, created_at desc);
    create index if not exists idx_pulso_iris_kpis_tenant_snapshot on pulso_iris.operational_kpi_snapshots(tenant_id, snapshot_at desc);
  `);
}

await startService({
  serviceName: "pulso-iris-service",
  databaseRequired: true,
  registerRoutes
});
