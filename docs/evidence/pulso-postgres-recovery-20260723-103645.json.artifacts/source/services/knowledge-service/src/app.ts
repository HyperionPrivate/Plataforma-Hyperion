import { envelope } from "@hyperion/platform-contracts";
import { readInternalCredential, validateInternalAuthorization, type RouteRegistrar } from "@hyperion/service-runtime";
import { registerAccessTenantProjectionRoutes } from "./access-tenant-projections.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  registerAccessTenantProjectionRoutes(app, context);

  app.get("/v1/knowledge-sources", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "api-gateway": readInternalCredential(process.env, "GATEWAY_TO_KNOWLEDGE_TOKEN")
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }

    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, tenant_id, name, source_type, status, checksum, created_at, updated_at
      from platform.knowledge_sources
      order by created_at desc
      limit 100
    `);

    return envelope(result.rows, request.id);
  });
};
