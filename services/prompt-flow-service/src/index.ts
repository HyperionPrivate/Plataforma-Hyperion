import { envelope } from "@hyperion/contracts";
import { startService, type RouteRegistrar } from "@hyperion/service-runtime";

const registerRoutes: RouteRegistrar = async (app, context) => {
  app.get("/v1/prompt-flows", async (request) => {
    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, tenant_id, agent_id, name, version, status, created_at, updated_at
      from platform.prompt_flows
      order by created_at desc
      limit 100
    `);

    return envelope(result.rows, request.id);
  });
};

await startService({
  serviceName: "prompt-flow-service",
  databaseRequired: true,
  registerRoutes
});
