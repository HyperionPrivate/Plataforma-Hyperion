import { envelope, tenantIdSchema } from "@hyperion/platform-contracts";
import {
  pulsoAgendaReadinessSchema,
  sofiaReadinessSchema,
  whatsappIntegrationStatusSchema,
  whatsappQrSchema
} from "@hyperion/pulso-contracts";
import {
  createInternalAuthorizationHeaders,
  readInternalCaller,
  readInternalCredential,
  readOperatorAssertionKey,
  validateOperatorAssertionContext,
  validateInternalAuthorization,
  validateProductOperatorAssertionContext,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import type { FastifyReply, FastifyRequest } from "fastify";

const CHANNEL_TIMEOUT_MS = 5_000;
const READINESS_TIMEOUT_MS = 3_000;

type OperatorRole = "admin" | "coordinator" | "advisor" | "auditor";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const channelUrl = (process.env.WHATSAPP_CHANNEL_SERVICE_URL ?? "http://localhost:8089").replace(/\/$/, "");
  const agentUrl = (process.env.AGENT_SERVICE_URL ?? "http://localhost:8083").replace(/\/$/, "");
  const pulsoUrl = (process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088").replace(/\/$/, "");
  const channelToken = readInternalCredential(process.env, "INTEGRATION_TO_CHANNEL_TOKEN");
  const sofiaToken = readInternalCredential(process.env, "INTEGRATION_TO_SOFIA_TOKEN");
  const pulsoToken = readInternalCredential(process.env, "INTEGRATION_TO_PULSO_TOKEN");
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_INTEGRATION_TOKEN");
  const pulsoBffToken = readInternalCredential(process.env, "PULSO_BFF_TO_INTEGRATION_TOKEN");
  const gatewayAssertionKey = readOperatorAssertionKey(process.env);
  const pulsoAssertionKey = readInternalCredential(process.env, "PULSO_OPERATOR_ASSERTION_KEY");
  if (pulsoBffToken && !pulsoAssertionKey) {
    throw new Error("PULSO_OPERATOR_ASSERTION_KEY is required with PULSO_BFF_TO_INTEGRATION_TOKEN");
  }

  app.get("/v1/integrations", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    if (!requireOperatorRole(request, reply, ["admin"], gatewayAssertionKey, null)) return;
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
    if (!requireProductEdge(request, reply, gatewayToken, pulsoBffToken)) return;
    const tenantId = requireTenantAndRole(
      request,
      reply,
      ["admin", "coordinator"],
      gatewayAssertionKey,
      pulsoAssertionKey
    );
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
    if (!requireProductEdge(request, reply, gatewayToken, pulsoBffToken)) return;
    const tenantId = requireTenantAndRole(request, reply, ["admin"], gatewayAssertionKey, pulsoAssertionKey);
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
    if (!requireProductEdge(request, reply, gatewayToken, pulsoBffToken)) return;
    const tenantId = requireTenantAndRole(request, reply, ["admin"], gatewayAssertionKey, pulsoAssertionKey);
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
    if (!requireProductEdge(request, reply, gatewayToken, pulsoBffToken)) return;
    const tenantId = requireTenantAndRole(request, reply, ["admin"], gatewayAssertionKey, pulsoAssertionKey);
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
    if (!requireProductEdge(request, reply, gatewayToken, pulsoBffToken)) return;
    const tenantId = requireTenantAndRole(
      request,
      reply,
      ["admin", "coordinator"],
      gatewayAssertionKey,
      pulsoAssertionKey
    );
    if (!tenantId) return;
    const [channel, agent, agenda] = await Promise.all([
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
      callInternal(
        `${pulsoUrl}/internal/v1/tenants/${tenantId}/pulso-iris/agenda/readiness`,
        "GET",
        pulsoToken,
        READINESS_TIMEOUT_MS
      )
    ]);

    const agendaPayload = agenda.ok ? pulsoAgendaReadinessSchema.safeParse(agenda.data) : undefined;
    if (!agendaPayload?.success || agendaPayload.data.tenantId !== tenantId) {
      return reply.code(502).send(envelope({ error: "PULSO agenda readiness unavailable" }, request.id));
    }

    const channelState = readString(channel.data, "state");
    const workerReady = readBoolean(agent.data, "workerEnabled") && readBoolean(agent.data, "workerRunning");
    const agentReady = agent.ok && readBoolean(agent.data, "ready") && workerReady;
    const agendaReady = agendaPayload.data.ready;
    // N-1 SOFIA responses only expose `ready`; current providers also expose
    // `promptFlowReady`. In both cases the provider owns the prompt decision.
    const promptReady =
      agent.ok && (readOptionalBoolean(agent.data, "promptFlowReady") ?? readBoolean(agent.data, "ready"));
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

function requireProductEdge(
  request: FastifyRequest,
  reply: FastifyReply,
  gatewayToken: string | undefined,
  pulsoBffToken: string | undefined
): boolean {
  const failure = validateInternalAuthorization(request.headers, {
    "pulso-bff": pulsoBffToken,
    "api-gateway": gatewayToken
  });
  if (!failure) return true;
  void reply.code(failure.statusCode).send(envelope({ error: failure.message }, request.id));
  return false;
}

function requireTenantAndRole(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedRoles: OperatorRole[],
  gatewayAssertionKey: string | undefined,
  pulsoAssertionKey: string | undefined
): string | undefined {
  const params = request.params as { tenantId?: unknown };
  const tenantId = tenantIdSchema.safeParse(params.tenantId);
  if (!tenantId.success) {
    void reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    return undefined;
  }
  const assertionFailure =
    readInternalCaller(request.headers) === "pulso-bff"
      ? validateProductOperatorAssertionContext(request.headers, pulsoAssertionKey, tenantId.data, "PULSO_IRIS")
      : validateOperatorAssertionContext(request.headers, gatewayAssertionKey, tenantId.data);
  if (assertionFailure) {
    void reply.code(assertionFailure.statusCode).send(envelope({ error: assertionFailure.message }, request.id));
    return undefined;
  }
  const role = readOperatorRole(request);
  if (!role || !allowedRoles.includes(role)) {
    void reply.code(403).send(envelope({ error: "Insufficient integration permissions" }, request.id));
    return undefined;
  }
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
      redirect: "error",
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

function readOptionalBoolean(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}
