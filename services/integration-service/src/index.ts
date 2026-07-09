import { envelope } from "@hyperion/contracts";
import { startService, type RouteRegistrar } from "@hyperion/service-runtime";

const registerRoutes: RouteRegistrar = async (app, context) => {
  app.get("/v1/integrations", async (request) => {
    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, tenant_id, provider, name, status, config, created_at, updated_at
      from platform.integrations
      order by created_at desc
      limit 100
    `);

    return envelope(result.rows, request.id);
  });
};

await startService({
  serviceName: "integration-service",
  databaseRequired: true,
  requiredMigrations: ["001-platform.sql"],
  registerRoutes
});
