import { lumenCatalog } from "@hyperion/contracts";
import {
  HttpOutboxDispatcher,
  JetStreamOutboxDispatcher,
  isHttpDurableEventIngressEnabled,
  readNatsAuthentication,
  type NatsAuthentication
} from "@hyperion/durable-events";
import type { RouteRegistrar, ServiceContext } from "@hyperion/service-runtime";
import { randomUUID } from "node:crypto";
import { DeepSeekClinicalStructurer } from "./clinical-ai.js";
import { PostgresLumenOutbox } from "./lumen-outbox.js";
import { registerLumenProjectionEventRoutes } from "./projection-events.js";
import { startLumenProjectionJetStreamConsumers } from "./projection-jetstream.js";
import { registerLumenRoutes } from "./routes.js";
import { ElevenLabsSpeechToTextProvider } from "./speech-to-text.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const durableOutbox = readDurableOutboxConfiguration(process.env);
  if (context.db) await verifyLumenSchema(context);

  const transcriber = new ElevenLabsSpeechToTextProvider();
  const structurer = new DeepSeekClinicalStructurer();

  if (isHttpDurableEventIngressEnabled(durableOutbox.transport)) {
    await registerLumenProjectionEventRoutes(app, context);
  }
  await registerLumenRoutes(app, context, { transcriber, structurer });

  if (
    context.db &&
    durableOutbox.enabled &&
    (durableOutbox.transport === "jetstream" || context.config.internalServiceToken)
  ) {
    const workerId = `lumen-outbox-${randomUUID()}`;
    const outbox = new PostgresLumenOutbox(
      context.db,
      workerId,
      process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086"
    );
    const dispatcher =
      durableOutbox.transport === "jetstream"
        ? new JetStreamOutboxDispatcher<Record<string, unknown>>({
            workerId,
            servers: durableOutbox.natsUrl,
            ...durableOutbox.authentication,
            connectionName: workerId,
            subjectPrefix: "hyperion.events",
            expectedStream: "HYPERION_EVENTS",
            claim: (limit) => outbox.claim(limit),
            complete: (eventId) => outbox.complete(eventId),
            fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
            batchSize: 10,
            intervalMs: 750,
            connectTimeoutMs: 5_000,
            publishTimeoutMs: 5_000
          })
        : new HttpOutboxDispatcher<Record<string, unknown>>({
            workerId,
            internalToken: context.config.internalServiceToken!,
            claim: (limit) => outbox.claim(limit),
            complete: (eventId) => outbox.complete(eventId),
            fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
            batchSize: 10,
            intervalMs: 750,
            timeoutMs: 5_000
          });
    app.addHook("onClose", async () => dispatcher.stop());
    if (dispatcher instanceof JetStreamOutboxDispatcher) {
      await dispatcher.initialize();
      context.registerReadinessCheck?.({
        name: "jetstream_lumen_publisher",
        check: () => dispatcher.checkReadiness()
      });
    }
    dispatcher.start();
  }

  // Consumer lifecycle is independent from producer/outbox switches: disabling
  // local publication must never make subscribed projections silently stale.
  if (context.db && durableOutbox.transport === "jetstream") {
    const consumers = await startLumenProjectionJetStreamConsumers((hook) => app.addHook("onClose", hook), context.db, {
      natsUrl: durableOutbox.natsUrl,
      ...durableOutbox.authentication
    });
    consumers.forEach((consumer, index) => {
      context.registerReadinessCheck?.({
        name: `jetstream_lumen_projection_${index + 1}`,
        check: () => consumer.checkReadiness()
      });
    });
  }

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

export async function verifyLumenSchema(context: ServiceContext): Promise<void> {
  const result = await context.db!.query<{
    encounters: string | null;
    records: string | null;
    currentVersion: number | string | null;
  }>(
    `select to_regclass('lumen.encounters')::text as encounters,
            to_regclass('lumen.clinical_records')::text as records,
            (
              select current_version from lumen.schema_version
              where service_name = 'lumen'
            ) as "currentVersion"`
  );
  const currentVersion = Number(result.rows[0]?.currentVersion ?? 0);
  if (!result.rows[0]?.encounters || !result.rows[0]?.records || currentVersion < 26) {
    throw new Error("LUMEN schema is incomplete; run migrations");
  }
}

type DurableOutboxConfiguration =
  | { readonly transport: "http"; readonly enabled: boolean }
  | {
      readonly transport: "jetstream";
      readonly enabled: boolean;
      readonly natsUrl: string;
      readonly authentication: NatsAuthentication;
    };

export function readDurableOutboxConfiguration(env: NodeJS.ProcessEnv): DurableOutboxConfiguration {
  const transport = env.DURABLE_EVENT_TRANSPORT?.trim() || "http";
  if (transport !== "http" && transport !== "jetstream") {
    throw new Error("DURABLE_EVENT_TRANSPORT must be either http or jetstream");
  }

  const globallyEnabled = env.DURABLE_OUTBOX_ENABLED !== "false";
  if (transport === "http") {
    return {
      transport,
      enabled: globallyEnabled && env.DURABLE_HTTP_OUTBOX_ENABLED !== "false"
    };
  }

  return {
    transport,
    enabled: globallyEnabled,
    natsUrl: requireCredentialFreeNatsUrl(env.NATS_URL),
    authentication: readNatsAuthentication(
      { authToken: env.NATS_AUTH_TOKEN, username: env.NATS_USERNAME, password: env.NATS_PASSWORD },
      {
        required: true,
        minimumSecretLength: 24,
        serverConfigurationSafe: true,
        allowToken: env.NODE_ENV !== "production"
      }
    )!
  };
}

function requireCredentialFreeNatsUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error("NATS_URL is required when DURABLE_EVENT_TRANSPORT=jetstream");

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("NATS_URL must be a valid credential-free URL");
  }
  if (parsed.username || parsed.password) throw new Error("NATS_URL must not contain credentials");
  if (
    (parsed.protocol !== "nats:" && parsed.protocol !== "tls:") ||
    !parsed.hostname ||
    parsed.pathname !== "" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NATS_URL must be a nats: or tls: endpoint without path, query, or hash");
  }
  return normalized;
}
