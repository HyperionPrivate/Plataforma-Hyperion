import { envelope } from "@hyperion/contracts";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { DeepSeekLlmProvider } from "./deepseek-llm-provider.js";
import { registerSofiaReadinessRoute, SofiaRuntime } from "./sofia-runtime.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  app.get("/v1/products", async (request) => {
    if (!context.db) return envelope([], request.id);
    const result = await context.db.query(`
      select id, code, name, status, owner_service, created_at, updated_at
      from platform.products order by created_at desc limit 100
    `);
    return envelope(result.rows, request.id);
  });

  app.get("/v1/agents", async (request) => {
    if (!context.db) return envelope([], request.id);
    const result = await context.db.query(`
      select id, tenant_id, product_id, code, name, channel, status, created_at, updated_at
      from platform.agents order by created_at desc limit 100
    `);
    return envelope(result.rows, request.id);
  });

  if (!context.db || !context.config.internalServiceToken) {
    context.logger.warn("SOFIA runtime disabled: database or internal token missing");
    return;
  }

  const llm = new DeepSeekLlmProvider();
  const runtime = new SofiaRuntime({
    db: context.db,
    logger: context.logger,
    llm,
    internalServiceToken: context.config.internalServiceToken,
    channelUrl: (process.env.WHATSAPP_CHANNEL_SERVICE_URL ?? "http://localhost:8089").replace(/\/$/, ""),
    promptFlowUrl: (process.env.PROMPT_FLOW_SERVICE_URL ?? "http://localhost:8084").replace(/\/$/, ""),
    pulsoIrisUrl: (process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088").replace(/\/$/, ""),
    auditUrl: (process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086").replace(/\/$/, "")
  });
  const workerEnabled = process.env.SOFIA_WORKER_ENABLED !== "false";
  if (workerEnabled) runtime.start();
  registerSofiaReadinessRoute(app, {
    db: context.db,
    llm,
    internalServiceToken: context.config.internalServiceToken,
    workerEnabled,
    runtime
  });
  app.addHook("onClose", async () => runtime.stop());
};
