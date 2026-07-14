import { envelope } from "@hyperion/contracts";
import {
  readInternalCredential,
  validateInternalAuthorization,
  type RouteRegistrar
} from "@hyperion/service-runtime";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  app.get("/v1/tenants", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "api-gateway": readInternalCredential(process.env, "GATEWAY_TO_TENANT_TOKEN")
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }

    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, slug, display_name, status, created_at, updated_at
      from platform.tenants
      order by created_at desc
      limit 100
    `);

    return envelope(result.rows, request.id);
  });
};
