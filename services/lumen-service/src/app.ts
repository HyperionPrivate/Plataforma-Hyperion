import { lumenCatalog } from "@hyperion/contracts";
import type { RouteRegistrar, ServiceContext } from "@hyperion/service-runtime";
import { createLumenAuditClient } from "./audit-client.js";
import { DeepSeekClinicalStructurer } from "./clinical-ai.js";
import { registerLumenRoutes } from "./routes.js";
import { ElevenLabsSpeechToTextProvider } from "./speech-to-text.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  if (context.db) await verifySchema(context);

  const transcriber = new ElevenLabsSpeechToTextProvider();
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
        transcriptionProvider: transcriber.name,
        transcriptionModel: transcriber.model,
        transcriptionLanguage: transcriber.language,
        zeroRetentionRequired: true,
        structuringConfigured: structurer.isConfigured(),
        structuringProvider: structurer.name,
        structuringModel: structurer.model
      }
    },
    requestId: request.id
  }));

  app.get("/v1/lumen/catalog", async (request) => ({ data: lumenCatalog, requestId: request.id }));
};

async function verifySchema(context: ServiceContext): Promise<void> {
  const result = await context.db!.query<{
    encounters: string | null;
    records: string | null;
    invariants: boolean;
    audioPipeline: boolean;
  }>(
    `select to_regclass('lumen.encounters')::text as encounters,
            to_regclass('lumen.clinical_records')::text as records,
            exists (
              select 1 from platform.schema_migrations
              where name = '019-lumen-clinical-invariants.sql'
            ) as invariants,
            exists (
              select 1 from platform.schema_migrations
              where name = '020-lumen-real-audio-pipeline.sql'
            ) as "audioPipeline"`
  );
  if (
    !result.rows[0]?.encounters ||
    !result.rows[0]?.records ||
    !result.rows[0]?.invariants ||
    !result.rows[0]?.audioPipeline
  ) {
    throw new Error("LUMEN schema is incomplete; run migrations");
  }
}
