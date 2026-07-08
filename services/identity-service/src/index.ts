import { envelope } from "@hyperion/contracts";
import { startService, type RouteRegistrar, type ServiceContext } from "@hyperion/service-runtime";

const registerRoutes: RouteRegistrar = async (app, context) => {
  app.get("/v1/identity/status", async (request) => {
    const operatorCount = await countRows(context, "platform.operators");

    return envelope({
      service: "identity-service",
      operatorCount,
      databaseConfigured: Boolean(context.db)
    }, request.id);
  });

  app.get("/v1/identity/operators", async (request) => {
    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, email, display_name, role, status, created_at
      from platform.operators
      order by created_at desc
      limit 100
    `);

    return envelope(result.rows, request.id);
  });
};

async function countRows(context: ServiceContext, tableName: string): Promise<number> {
  if (!context.db) {
    return 0;
  }

  const result = await context.db.query<{ total: string }>(`select count(*)::text as total from ${tableName}`);
  return Number(result.rows[0]?.total ?? 0);
}

await startService({
  serviceName: "identity-service",
  databaseRequired: true,
  registerRoutes
});
