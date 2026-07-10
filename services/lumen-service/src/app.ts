import { lumenCatalog } from "@hyperion/contracts";
import type { RouteRegistrar, ServiceContext } from "@hyperion/service-runtime";
import { createLumenAuditClient } from "./audit-client.js";
import { DeepSeekClinicalStructurer, OpenAiClinicalTranscriber } from "./clinical-ai.js";
import { registerLumenRoutes } from "./routes.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  if (context.db) await verifySchema(context);

  const transcriber = new OpenAiClinicalTranscriber();
  const structurer = new DeepSeekClinicalStructurer();
  const emitAudit = createLumenAuditClient({
    auditServiceUrl: process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086",
    internalServiceToken: context.config.internalServiceToken,
    logger: context.logger
  });

  await registerLumenRoutes(app, context, { transcriber, structurer, emitAudit });

  app.get("/v1/lumen/health", async (request) => ({
    data: {
      service: "lumen-service",
      product: lumenCatalog.product.code,
      status: "ok",
      providers: {
        transcriptionConfigured: transcriber.isConfigured(),
        structuringConfigured: structurer.isConfigured()
      }
    },
    requestId: request.id
  }));

  app.get("/v1/lumen/catalog", async (request) => ({ data: lumenCatalog, requestId: request.id }));
};

async function verifySchema(context: ServiceContext): Promise<void> {
  const result = await context.db!.query<{ encounters: string | null; records: string | null }>(
    `select to_regclass('lumen.encounters')::text as encounters,
            to_regclass('lumen.clinical_records')::text as records`
  );
  if (!result.rows[0]?.encounters || !result.rows[0]?.records) {
    throw new Error("LUMEN schema is incomplete; run migrations");
  }
}
