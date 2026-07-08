import { envelope } from "@hyperion/contracts";
import { startService, type RouteRegistrar } from "@hyperion/service-runtime";

const registerRoutes: RouteRegistrar = async (app, context) => {
  app.get("/v1/products", async (request) => {
    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, code, name, status, owner_service, created_at, updated_at
      from platform.products
      order by created_at desc
      limit 100
    `);

    return envelope(result.rows, request.id);
  });

  app.get("/v1/agents", async (request) => {
    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, tenant_id, product_id, code, name, channel, status, created_at, updated_at
      from platform.agents
      order by created_at desc
      limit 100
    `);

    return envelope(result.rows, request.id);
  });
};

await startService({
  serviceName: "agent-service",
  databaseRequired: true,
  registerRoutes
});
