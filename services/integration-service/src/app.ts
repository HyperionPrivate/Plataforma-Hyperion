import {
  envelope,
  sofiaReadinessSchema,
  tenantIdSchema,
  whatsappIntegrationStatusSchema,
  whatsappQrSchema
} from "@hyperion/contracts";
import {
  createInternalAuthorizationHeaders,
  readInternalCredential,
  readOperatorAssertionKey,
  validateOperatorAssertionContext,
  validateInternalAuthorization,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import type { FastifyReply, FastifyRequest } from "fastify";

const CHANNEL_TIMEOUT_MS = 5_000;
const READINESS_TIMEOUT_MS = 3_000;

type OperatorRole = "admin" | "coordinator" | "advisor" | "auditor";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const channelUrl = (process.env.WHATSAPP_CHANNEL_SERVICE_URL ?? "http://localhost:8089").replace(/\/$/, "");
  const agentUrl = (process.env.AGENT_SERVICE_URL ?? "http://localhost:8083").replace(/\/$/, "");
  const channelToken = readInternalCredential(process.env, "INTEGRATION_TO_CHANNEL_TOKEN");
  const sofiaToken = readInternalCredential(process.env, "INTEGRATION_TO_SOFIA_TOKEN");
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_INTEGRATION_TOKEN");
  const operatorAssertionKey = readOperatorAssertionKey(process.env);

  app.get("/v1/integrations", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    if (!requireOperatorRole(request, reply, ["admin"], operatorAssertionKey, null)) return;
    if (!context.db) return envelope([], request.id);
    const result = await context.db.query(`
      select id, tenant_id, provider, name, status, config, created_at, updated_at
      from platform.integrations
      order by created_at desc
      limit 100
    `);
    return envelope(result.rows, request.id);
  });

  app.get("/v1/tenants/:tenantId/integrations/whatsapp/status", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    const tenantId = requireTenantAndRole(request, reply, ["admin", "coordinator"], operatorAssertionKey);
    if (!tenantId) return;
    const response = await callInternal(
      `${channelUrl}/internal/v1/tenants/${tenantId}/whatsapp/status`,
      "GET",
      channelToken
    );
    if (!response.ok) return sendUpstreamFailure(reply, request, response);
    const status = whatsappIntegrationStatusSchema.parse(response.data);
    return envelope(status, request.id);
  });

  app.post("/v1/tenants/:tenantId/integrations/whatsapp/connect", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    const tenantId = requireTenantAndRole(request, reply, ["admin"], operatorAssertionKey);
    if (!tenantId) return;
    const response = await callInternal(
      `${channelUrl}/internal/v1/tenants/${tenantId}/whatsapp/connect`,
      "POST",
      channelToken
    );
    if (!response.ok) return sendUpstreamFailure(reply, request, response);
    const status = whatsappIntegrationStatusSchema.parse(response.data);
    return reply.code(202).send(envelope({ status }, request.id));
  });

  app.get("/v1/tenants/:tenantId/integrations/whatsapp/qr", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    const tenantId = requireTenantAndRole(request, reply, ["admin"], operatorAssertionKey);
    if (!tenantId) return;
    reply.header("cache-control", "no-store, private, max-age=0");
    reply.header("pragma", "no-cache");
    reply.header("expires", "0");
    const response = await callInternal(
      `${channelUrl}/internal/v1/tenants/${tenantId}/whatsapp/qr`,
      "GET",
      channelToken
    );
    if (!response.ok) return sendUpstreamFailure(reply, request, response);
    return envelope(whatsappQrSchema.parse(response.data), request.id);
  });

  app.post("/v1/tenants/:tenantId/integrations/whatsapp/disconnect", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    const tenantId = requireTenantAndRole(request, reply, ["admin"], operatorAssertionKey);
    if (!tenantId) return;
    const response = await callInternal(
      `${channelUrl}/internal/v1/tenants/${tenantId}/whatsapp/disconnect`,
      "POST",
      channelToken
    );
    if (!response.ok) return sendUpstreamFailure(reply, request, response);
    const status = whatsappIntegrationStatusSchema.parse(response.data);
    return envelope({ status }, request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/sofia/readiness", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    const tenantId = requireTenantAndRole(request, reply, ["admin", "coordinator"], operatorAssertionKey);
    if (!tenantId) return;
    if (!context.db) return reply.code(503).send(envelope({ error: "Database unavailable" }, request.id));

    const [channel, agent, agenda, prompt] = await Promise.all([
      callInternal(
        `${channelUrl}/internal/v1/tenants/${tenantId}/whatsapp/status`,
        "GET",
        channelToken,
        READINESS_TIMEOUT_MS
      ),
      callInternal(
        `${agentUrl}/internal/v1/tenants/${tenantId}/sofia/readiness`,
        "GET",
        sofiaToken,
        READINESS_TIMEOUT_MS
      ),
      context.db.query<{
        mode: string;
        status: string;
        professionalCount: number;
        ruleCount: number;
      }>(
        `select s.mode, s.status,
                (select count(*)::int from pulso_iris.professionals p
                 where p.tenant_id = s.tenant_id and p.status = 'active') as "professionalCount",
                (select count(*)::int from pulso_iris.availability_rules r
                 where r.tenant_id = s.tenant_id and r.status = 'active') as "ruleCount"
         from pulso_iris.agenda_settings s where s.tenant_id = $1`,
        [tenantId]
      ),
      context.db.query<{ count: number }>(
        `select count(*)::int as count
         from (
           select f.definition ->> 'runtimeKey' as runtime_key
           from platform.prompt_flows f
           join platform.agents a on a.id = f.agent_id
           where f.tenant_id = $1 and a.tenant_id = $1 and a.code = 'SOFIA'
             and a.status = 'active' and f.status = 'active'
           order by f.version desc, f.updated_at desc
           limit 1
         ) selected
         where selected.runtime_key = 'sofia_whatsapp_internal_v5'
           and exists (
             select 1 from platform.schema_migrations
             where name = '016-sofia-search-constraints.sql'
           )`,
        [tenantId]
      )
    ]);

    const channelState = readString(channel.data, "state");
    const workerReady = readBoolean(agent.data, "workerEnabled") && readBoolean(agent.data, "workerRunning");
    const agentReady = agent.ok && readBoolean(agent.data, "ready") && workerReady;
    const agendaRow = agenda.rows[0];
    const agendaReady =
      agendaRow?.mode === "internal" &&
      agendaRow.status === "active" &&
      agendaRow.professionalCount > 0 &&
      agendaRow.ruleCount > 0;
    const promptReady = (prompt.rows[0]?.count ?? 0) > 0;
    const channelReady = channel.ok && channelState === "ready";

    const dependencies = [
      { name: "channel", status: channelReady ? "ok" : channel.ok ? "degraded" : "down" },
      { name: "llm", status: agentReady ? "ok" : agent.ok ? "degraded" : "down" },
      { name: "prompt_flow", status: promptReady ? "ok" : "down" },
      { name: "agenda", status: agendaReady ? "ok" : "down" }
    ];
    const allReady = dependencies.every((dependency) => dependency.status === "ok");
    const anyDown = dependencies.some((dependency) => dependency.status === "down");
    const payload = sofiaReadinessSchema.parse({
      tenantId,
      status: allReady ? "ready" : anyDown ? "not_ready" : "degraded",
      checkedAt: new Date().toISOString(),
      canReceiveMessages: channelReady && agentReady && promptReady,
      canBookAppointments: agentReady && promptReady && agendaReady,
      dependencies
    });
    return envelope(payload, request.id);
  });
};

function requireGateway(request: FastifyRequest, reply: FastifyReply, token: string | undefined): boolean {
  const failure = validateInternalAuthorization(request.headers, { "api-gateway": token });
  if (!failure) return true;
  void reply.code(failure.statusCode).send(envelope({ error: failure.message }, request.id));
  return false;
}

function requireTenantAndRole(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: OperatorRole[],
  operatorAssertionKey: string | undefined
): string | undefined {
  const params = request.params as { tenantId?: unknown };
  const tenantId = tenantIdSchema.safeParse(params.tenantId);
  if (!tenantId.success) {
    void reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    return undefined;
  }
  if (!requireOperatorRole(request, reply, allowedRoles, operatorAssertionKey, tenantId.data)) return undefined;
  return tenantId.data;
}

function requireOperatorRole(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: OperatorRole[],
  operatorAssertionKey: string | undefined,
  expectedTenantId: string | null
): OperatorRole | undefined {
  const assertionFailure = validateOperatorAssertionContext(request.headers, operatorAssertionKey, expectedTenantId);
  if (assertionFailure) {
    void reply.code(assertionFailure.statusCode).send(envelope({ error: assertionFailure.message }, request.id));
    return undefined;
  }
  const role = readOperatorRole(request);
  if (!role || !allowedRoles.includes(role)) {
    void reply.code(403).send(envelope({ error: "Insufficient integration permissions" }, request.id));
    return undefined;
  }
  return role;
}

function readOperatorRole(request: FastifyRequest): OperatorRole | undefined {
  const raw = request.headers["x-operator-role"];
  const role = Array.isArray(raw) ? raw[0] : raw;
  return role === "admin" || role === "coordinator" || role === "advisor" || role === "auditor" ? role : undefined;
}

interface InternalResponse {
  ok: boolean;
  status: number;
  data?: unknown;
}

async function callInternal(
  url: string,
  method: "GET" | "POST",
  token: string | undefined,
  timeoutMs = CHANNEL_TIMEOUT_MS
): Promise<InternalResponse> {
  if (!token) return { ok: false, status: 503 };
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...createInternalAuthorizationHeaders("integration-service", token),
        "content-type": "application/json"
      },
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = (await response.json()) as { data?: unknown } | unknown;
    const data = isRecord(payload) && "data" in payload ? payload.data : payload;
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 503 };
  }
}

function sendUpstreamFailure(reply: FastifyReply, request: FastifyRequest, response: InternalResponse) {
  const status = response.status >= 400 && response.status < 600 ? response.status : 503;
  return reply.code(status).send(envelope({ error: "WhatsApp channel unavailable" }, request.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function readBoolean(value: unknown, key: string): boolean {
  return isRecord(value) && value[key] === true;
}
