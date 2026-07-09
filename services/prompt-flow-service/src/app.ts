import { timingSafeEqual } from "node:crypto";
import { envelope, tenantIdSchema } from "@hyperion/contracts";
import type { RouteRegistrar } from "@hyperion/service-runtime";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  app.get("/v1/prompt-flows", async (request) => {
    if (!context.db) return envelope([], request.id);
    const result = await context.db.query(`
      select id, tenant_id, agent_id, name, version, status, created_at, updated_at
      from platform.prompt_flows
      order by created_at desc
      limit 100
    `);
    return envelope(result.rows, request.id);
  });

  app.get("/internal/v1/tenants/:tenantId/prompt-flows/SOFIA/active", async (request, reply) => {
    if (!hasInternalToken(request.headers.authorization, context.config.internalServiceToken)) {
      return reply.code(401).send(envelope({ error: "Internal authentication required" }, request.id));
    }
    const params = request.params as { tenantId?: unknown };
    const tenantId = tenantIdSchema.safeParse(params.tenantId);
    if (!tenantId.success) return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    if (!context.db) return reply.code(503).send(envelope({ error: "Database unavailable" }, request.id));

    const result = await context.db.query<{
      id: string;
      name: string;
      version: number;
      definition: Record<string, unknown>;
    }>(
      `select f.id, f.name, f.version, f.definition
       from platform.prompt_flows f
       join platform.agents a on a.id = f.agent_id
       where f.tenant_id = $1 and a.tenant_id = $1
         and a.code = 'SOFIA' and a.status = 'active' and f.status = 'active'
       order by f.version desc, f.updated_at desc
       limit 1`,
      [tenantId.data]
    );
    const flow = result.rows[0];
    if (!flow) return reply.code(404).send(envelope({ error: "Active SOFIA prompt is not configured" }, request.id));
    const systemPrompt = typeof flow.definition.systemPrompt === "string" ? flow.definition.systemPrompt.trim() : "";
    const urgentMessage =
      typeof flow.definition.urgentMessage === "string" ? flow.definition.urgentMessage.trim() : undefined;
    if (!systemPrompt) return reply.code(422).send(envelope({ error: "Active SOFIA prompt is invalid" }, request.id));
    return envelope(
      { id: flow.id, agentCode: "SOFIA", name: flow.name, version: flow.version, systemPrompt, urgentMessage },
      request.id
    );
  });
};

function hasInternalToken(authorization: string | undefined, expected: string | undefined): boolean {
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7).trim());
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}
