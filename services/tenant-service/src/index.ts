import { envelope } from "@hyperion/contracts";
import { startService, type RouteRegistrar } from "@hyperion/service-runtime";

const registerRoutes: RouteRegistrar = async (app, context) => {
  app.get("/v1/tenants", async (request) => {
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

await startService({
  serviceName: "tenant-service",
  databaseRequired: true,
  registerRoutes
});
