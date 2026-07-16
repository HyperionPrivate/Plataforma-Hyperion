import { randomUUID } from "node:crypto";
import { envelope, productModules } from "@hyperion/contracts";
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
  readInternalCredential,
  validateInternalAuthorization,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import { PostgresAgentOutbox } from "./agent-outbox.js";
import { DeepSeekLlmProvider } from "./deepseek-llm-provider.js";
import { readPulsoMessageV1Compatibility, registerPulsoEventRoutesWithCompatibility } from "./pulso-events.js";
import { startPulsoMessageJetStreamConsumers, type ManagedJetStreamConsumer } from "./pulso-jetstream.js";
import { createLegacyPulsoPositionResolver } from "./pulso-position-client.js";
import { registerSofiaReadinessRoute, SofiaRuntime } from "./sofia-runtime.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const durableOutbox = readDurableOutboxConfiguration(process.env);
  const lifecycle: {
    dispatcher?: Pick<HttpOutboxDispatcher<unknown> | JetStreamOutboxDispatcher<unknown>, "stop">;
    runtime?: Pick<SofiaRuntime, "stop">;
    consumers?: readonly Pick<ManagedJetStreamConsumer, "stop">[];
  } = {};
  app.addHook("onClose", async () => {
    await stopSofiaComponents(lifecycle);
  });
  const auditToken = readInternalCredential(process.env, "SOFIA_TO_AUDIT_TOKEN");
  const channelToken = readInternalCredential(process.env, "SOFIA_TO_CHANNEL_TOKEN");
  const promptFlowToken = readInternalCredential(process.env, "SOFIA_TO_PROMPT_FLOW_TOKEN");
  const pulsoToken = readInternalCredential(process.env, "SOFIA_TO_PULSO_TOKEN");
  const integrationToken = readInternalCredential(process.env, "INTEGRATION_TO_SOFIA_TOKEN");
  const allowLegacyPulsoV1 = readPulsoMessageV1Compatibility(process.env);
  const resolveLegacyPulsoPosition = allowLegacyPulsoV1
    ? createLegacyPulsoPositionResolver({
        pulsoServiceUrl: process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088",
        credential: pulsoToken ?? ""
      })
    : undefined;
  if (allowLegacyPulsoV1) {
    context.logger.warn("PULSO message v1 compatibility window is enabled", {
      compatibilityMode: "pulso_message_v1",
      targetContract: "pulso.message.received.v2"
    });
  }
  if (isHttpDurableEventIngressEnabled(durableOutbox.transport)) {
    registerPulsoEventRoutesWithCompatibility(app, context, {
      allowLegacyV1: allowLegacyPulsoV1,
      resolveLegacyPosition: resolveLegacyPulsoPosition
    });
  }

  if (context.db && durableOutbox.transport === "jetstream") {
    const consumers = await startPulsoMessageJetStreamConsumers(context.db, {
      natsUrl: durableOutbox.natsUrl,
      allowLegacyV1: allowLegacyPulsoV1,
      resolveLegacyPosition: resolveLegacyPulsoPosition,
      ...durableOutbox.authentication
    });
    lifecycle.consumers = consumers;
    consumers.forEach((consumer, index) => {
      context.registerReadinessCheck?.({
        name: `jetstream_pulso_message_consumer_${index + 1}`,
        check: () => consumer.checkReadiness()
      });
    });
  }

  app.get("/v1/products", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "api-gateway": readInternalCredential(process.env, "GATEWAY_TO_SOFIA_TOKEN")
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    // Catalogo de producto versionado en contracts (sin SQL cruzado a access/platform.products).
    return envelope(
      productModules.map((module) => ({
        code: module.code,
        name: module.name,
        status: module.status,
        owner_service: module.ownerService
      })),
      request.id
    );
  });

  app.get("/v1/agents", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "api-gateway": readInternalCredential(process.env, "GATEWAY_TO_SOFIA_TOKEN")
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
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
  const dispatcher = shouldStartDurableOutbox(durableOutbox, auditToken)
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
          batchSize: 5,
          intervalMs: 750,
          connectTimeoutMs: 5_000,
          publishTimeoutMs: 3_000
        })
      : new HttpOutboxDispatcher<Record<string, unknown>>({
          workerId: outboxWorkerId,
          internalToken: auditToken!,
          fetch: createWorkloadFetch("agent-service", auditToken!),
          claim: (limit) => outbox.claim(limit),
          complete: (eventId) => outbox.complete(eventId),
          fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
          batchSize: 5,
          intervalMs: 750,
          timeoutMs: 3_000
        })
    : undefined;
  lifecycle.dispatcher = dispatcher;
  if (dispatcher) {
    if (dispatcher instanceof JetStreamOutboxDispatcher) {
      await dispatcher.initialize();
      context.registerReadinessCheck?.({
        name: "jetstream_sofia_publisher",
        check: () => dispatcher.checkReadiness()
      });
    }
    dispatcher.start();
  }

  const runtimeCredentials = { auditToken, channelToken, promptFlowToken, pulsoToken };
  const missingRuntimeCredentials = Object.entries(runtimeCredentials)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingRuntimeCredentials.length > 0) {
    context.logger.warn("SOFIA HTTP runtime disabled: workload credentials missing", {
      credentials: missingRuntimeCredentials
    });
    return;
  }

  const llm = new DeepSeekLlmProvider();
  const runtimeInstance = new SofiaRuntime({
    db: context.db,
    logger: context.logger,
    llm,
    auditToken: auditToken!,
    channelToken: channelToken!,
    promptFlowToken: promptFlowToken!,
    pulsoToken: pulsoToken!,
    channelUrl: (process.env.WHATSAPP_CHANNEL_SERVICE_URL ?? "http://localhost:8089").replace(/\/$/, ""),
    promptFlowUrl: (process.env.PROMPT_FLOW_SERVICE_URL ?? "http://localhost:8084").replace(/\/$/, ""),
    pulsoIrisUrl: (process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088").replace(/\/$/, ""),
    auditUrl: (process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086").replace(/\/$/, ""),
    inboundPollingEnabled: process.env.SOFIA_LEGACY_POLLING_ENABLED === "true"
  });
  lifecycle.runtime = runtimeInstance;
  const workerEnabled = process.env.SOFIA_WORKER_ENABLED !== "false";
  if (workerEnabled) runtimeInstance.start();
  registerSofiaReadinessRoute(app, {
    db: context.db,
    llm,
    integrationToken,
    workerEnabled,
    runtime: runtimeInstance
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
        allowToken: !isRestrictedDeploymentEnvironment(env)
      }
    )!
  };
}

export function shouldStartDurableOutbox(
  configuration: DurableOutboxConfiguration,
  auditToken: string | undefined
): boolean {
  return configuration.enabled && (configuration.transport === "jetstream" || Boolean(auditToken));
}

export async function stopSofiaComponents(options: {
  dispatcher?: Pick<HttpOutboxDispatcher<unknown> | JetStreamOutboxDispatcher<unknown>, "stop">;
  runtime?: Pick<SofiaRuntime, "stop">;
  consumers?: readonly Pick<ManagedJetStreamConsumer, "stop">[];
}): Promise<void> {
  const operations = [
    options.dispatcher?.stop() ?? Promise.resolve(),
    options.runtime?.stop() ?? Promise.resolve(),
    ...[...(options.consumers ?? [])].reverse().map((consumer) => consumer.stop())
  ];
  const results = await Promise.allSettled(operations);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("sofia_shutdown_error");
  }
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

function createWorkloadFetch(caller: string, token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(createInternalAuthorizationHeaders(caller, token))) {
      headers.set(name, value);
    }
    return fetch(input, { ...init, headers });
  };
}
