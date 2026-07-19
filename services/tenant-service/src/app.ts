import { assertAccessRuntimeDatabaseBoundary } from "@hyperion/access-migrations/runtime-boundary";
import { envelope } from "@hyperion/platform-contracts";
import { readInternalCredential, validateInternalAuthorization, type RouteRegistrar } from "@hyperion/service-runtime";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  context.registerReadinessCheck?.({
    name: "access_runtime_boundary",
    check: async () => {
      if (!context.db) throw new Error("Access database is unavailable");
      await assertAccessRuntimeDatabaseBoundary(context.db as never, "hyperion_tenant");
    }
  });
  app.get("/v1/tenants", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "api-gateway": readInternalCredential(process.env, "GATEWAY_TO_TENANT_TOKEN"),
      "platform-admin-bff": readInternalCredential(process.env, "PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN")
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
