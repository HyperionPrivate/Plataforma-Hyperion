import { lumenCatalog } from "@hyperion/lumen-contracts";
import {
  assertLumenRuntimeDatabaseBoundary,
  LUMEN_CURRENT_MIGRATION,
  LUMEN_CURRENT_SCHEMA_VERSION,
  type LumenSchemaClient
} from "@hyperion/lumen-migrations/schema-manifest";
import {
  HttpOutboxDispatcher,
  JetStreamOutboxDispatcher,
  isHttpDurableEventIngressEnabled,
  readNatsAuthentication,
  type NatsAuthentication
} from "@hyperion/durable-events";
import {
  createInternalAuthorizationHeaders,
  isRestrictedDeploymentEnvironment,
  readInternalCaller,
  readInternalCredential,
  readOperatorAssertionKey,
  validateOperatorAssertionContext,
  validateInternalAuthorization,
  validateProductOperatorAssertionContext,
  type RouteRegistrar,
  type ServiceContext
} from "@hyperion/service-runtime";
import { randomUUID } from "node:crypto";
import { readLumenAudioCleanupConfiguration, startLumenAudioCleanupReconciler } from "./audio-cleanup-recovery.js";
import { DeepSeekClinicalStructurer } from "./clinical-ai.js";
import { PostgresLumenOutbox } from "./lumen-outbox.js";
import { registerLumenProjectionEventRoutes } from "./projection-events.js";
import { startLumenProjectionJetStreamConsumers } from "./projection-jetstream.js";
import { registerLumenRoutes } from "./routes.js";
import { ElevenLabsSpeechToTextProvider } from "./speech-to-text.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const durableOutbox = readDurableOutboxConfiguration(process.env);
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_LUMEN_TOKEN");
  const lumenBffToken = readInternalCredential(process.env, "LUMEN_BFF_TO_LUMEN_TOKEN");
  const gatewayAssertionKey = readOperatorAssertionKey(process.env);
  const lumenAssertionKey = readInternalCredential(process.env, "LUMEN_OPERATOR_ASSERTION_KEY");
  if (lumenBffToken && !lumenAssertionKey) {
    throw new Error("LUMEN_OPERATOR_ASSERTION_KEY is required with LUMEN_BFF_TO_LUMEN_TOKEN");
  }
  const auditToken = readInternalCredential(process.env, "LUMEN_TO_AUDIT_TOKEN");
  if (context.db) await verifyLumenSchema(context);

  const audioCleanup = readLumenAudioCleanupConfiguration(process.env);
  if (context.db) {
    // Startup reconciliation is deliberately awaited before any clinical route
    // can accept new audio. The periodic worker is drained before DB shutdown.
    const reconciler = await startLumenAudioCleanupReconciler(context.db, audioCleanup, {
      onError: () => app.log.error("LUMEN temporary-audio cleanup retry failed")
    });
    app.addHook("onClose", async () => reconciler.stop());
    context.registerReadinessCheck?.({
      name: "lumen_audio_cleanup_lease",
      check: () => reconciler.checkReadiness()
    });
  }

  const transcriber = new ElevenLabsSpeechToTextProvider({
    tempRootDirectory: audioCleanup.rootDirectory,
    cleanupOwner: audioCleanup.owner
  });
  const structurer = new DeepSeekClinicalStructurer();

  app.addHook("preHandler", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/v1/tenants/")) return;
    const tenantId = readTenantParam(request.params);
    if (tenantId === undefined) return;
    const authError = validateInternalAuthorization(request.headers, {
      "lumen-bff": lumenBffToken,
      "api-gateway": gatewayToken
    });
    if (authError) {
      return reply.code(authError.statusCode).send({ data: { error: authError.message }, requestId: request.id });
    }
    const assertionError =
      readInternalCaller(request.headers) === "lumen-bff"
        ? validateProductOperatorAssertionContext(request.headers, lumenAssertionKey, tenantId, "LUMEN")
        : validateOperatorAssertionContext(request.headers, gatewayAssertionKey, tenantId);
    if (assertionError) {
      return reply
        .code(assertionError.statusCode)
        .send({ data: { error: assertionError.message }, requestId: request.id });
    }
  });

  if (isHttpDurableEventIngressEnabled(durableOutbox.transport)) {
    await registerLumenProjectionEventRoutes(app, context);
  }
  await registerLumenRoutes(app, context, {
    transcriber,
    structurer,
    audioCleanupOwner: audioCleanup.owner
  });

  if (context.db && durableOutbox.enabled && (durableOutbox.transport === "jetstream" || auditToken)) {
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
            internalToken: auditToken!,
            fetch: createWorkloadFetch("lumen-service", auditToken!),
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
        structuringConfigured: structurer.isConfigured()
      }
    },
    requestId: request.id
  }));

  app.get("/v1/lumen/catalog", async (request) => ({ data: lumenCatalog, requestId: request.id }));
};

function readTenantParam(params: unknown): string | undefined {
  return typeof params === "object" &&
    params !== null &&
    "tenantId" in params &&
    typeof (params as { tenantId?: unknown }).tenantId === "string"
    ? (params as { tenantId: string }).tenantId
    : undefined;
}

export async function verifyLumenSchema(context: ServiceContext): Promise<void> {
  const database = context.db!;
  const schemaClient: LumenSchemaClient = {
    query: async <T = Record<string, unknown>>(sql: string, values?: unknown[]) => {
      const result = await database.query(sql, values);
      return { rows: result.rows as unknown as T[] };
    }
  };
  const { schema: inspection } = await assertLumenRuntimeDatabaseBoundary(schemaClient);
  if (
    inspection.state !== "managed" ||
    inspection.currentVersion !== LUMEN_CURRENT_SCHEMA_VERSION ||
    inspection.migrationName !== LUMEN_CURRENT_MIGRATION
  ) {
    const detail = inspection.issues.length > 0 ? `: ${inspection.issues.join("; ")}` : "";
    throw new Error(`LUMEN runtime schema integrity verification failed${detail}`);
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
        allowToken: !isRestrictedDeploymentEnvironment(env)
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

function createWorkloadFetch(caller: string, token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(createInternalAuthorizationHeaders(caller, token))) {
      headers.set(name, value);
    }
    return fetch(input, { ...init, headers, redirect: "error" });
  };
}
