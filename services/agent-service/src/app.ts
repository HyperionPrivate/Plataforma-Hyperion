import { randomUUID } from "node:crypto";
import { envelope } from "@hyperion/contracts";
import {
  HttpOutboxDispatcher,
  JetStreamOutboxDispatcher,
  isHttpDurableEventIngressEnabled,
  readNatsAuthentication,
  type NatsAuthentication
} from "@hyperion/durable-events";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { PostgresAgentOutbox } from "./agent-outbox.js";
import { DeepSeekLlmProvider } from "./deepseek-llm-provider.js";
import { registerPulsoEventRoutes } from "./pulso-events.js";
import { startPulsoMessageJetStreamConsumer } from "./pulso-jetstream.js";
import { registerSofiaReadinessRoute, SofiaRuntime } from "./sofia-runtime.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const durableOutbox = readDurableOutboxConfiguration(process.env);
  if (isHttpDurableEventIngressEnabled(durableOutbox.transport)) {
    await registerPulsoEventRoutes(app, context);
  }

  if (context.db && durableOutbox.transport === "jetstream") {
    const consumer = await startPulsoMessageJetStreamConsumer((hook) => app.addHook("onClose", hook), context.db, {
      natsUrl: durableOutbox.natsUrl,
      ...durableOutbox.authentication
    });
    context.registerReadinessCheck?.({
      name: "jetstream_pulso_message_consumer",
      check: () => consumer.checkReadiness()
    });
  }

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

  if (!context.db) {
    context.logger.warn("SOFIA runtime disabled: database missing");
    return;
  }

  const outboxWorkerId = `sofia-outbox-${randomUUID()}`;
  const outbox = new PostgresAgentOutbox(
    context.db,
    outboxWorkerId,
    process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086"
  );
  const dispatcher = shouldStartDurableOutbox(durableOutbox, context.config.internalServiceToken)
    ? durableOutbox.transport === "jetstream"
      ? new JetStreamOutboxDispatcher<Record<string, unknown>>({
          workerId: outboxWorkerId,
          servers: durableOutbox.natsUrl,
          ...durableOutbox.authentication,
          connectionName: outboxWorkerId,
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
          workerId: outboxWorkerId,
          internalToken: context.config.internalServiceToken!,
          claim: (limit) => outbox.claim(limit),
          complete: (eventId) => outbox.complete(eventId),
          fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
          batchSize: 10,
          intervalMs: 750,
          timeoutMs: 5_000
        })
    : undefined;
  if (dispatcher) {
    app.addHook("onClose", async () => dispatcher.stop());
    if (dispatcher instanceof JetStreamOutboxDispatcher) {
      await dispatcher.initialize();
      context.registerReadinessCheck?.({
        name: "jetstream_sofia_publisher",
        check: () => dispatcher.checkReadiness()
      });
    }
    dispatcher.start();
  }

  // JetStream uses its own service identity, so durable SOFIA audit delivery
  // must not depend on the shared legacy HTTP credential. Only the HTTP-based
  // orchestration runtime is disabled when that credential is absent.
  if (!context.config.internalServiceToken) {
    context.logger.warn("SOFIA HTTP runtime disabled: internal token missing");
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
    auditUrl: (process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086").replace(/\/$/, ""),
    inboundPollingEnabled: process.env.SOFIA_LEGACY_POLLING_ENABLED === "true"
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
  app.addHook("onClose", async () => {
    runtime.stop();
  });
};

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

export function shouldStartDurableOutbox(
  configuration: DurableOutboxConfiguration,
  internalServiceToken: string | undefined
): boolean {
  return configuration.enabled && (configuration.transport === "jetstream" || Boolean(internalServiceToken));
}

function requireCredentialFreeNatsUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error("NATS_URL is required when DURABLE_EVENT_TRANSPORT=jetstream");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("NATS_URL must be a valid credential-free URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("NATS_URL must not contain credentials");
  }
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
