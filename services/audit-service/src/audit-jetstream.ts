import {
  DurableJetStreamConsumer,
  type DurableJetStreamConsumerOptions,
  type JetStreamEventHandler,
  type JsonValue,
  readNatsAuthentication,
  type NatsAuthentication
} from "@hyperion/durable-events";
import type { DatabaseClient } from "@hyperion/database";
import {
  AUDIT_EVENT_CONTRACTS,
  LEGACY_AUDIT_EVENT_CONTRACT,
  parseInternalAuditEventEnvelope,
  parseLegacyAuditEventEnvelope,
  receiveInternalAuditEvent,
  type AuditSourceService
} from "./event-inbox.js";

export const AUDIT_EVENT_CONSUMERS = [
  {
    ...AUDIT_EVENT_CONTRACTS.sofia,
    durableName: "audit_sofia_event_record_v1",
    connectionName: "audit-sofia-event-record"
  },
  {
    ...AUDIT_EVENT_CONTRACTS.lumen,
    durableName: "audit_lumen_event_record_v1",
    connectionName: "audit-lumen-event-record"
  },
  {
    eventType: LEGACY_AUDIT_EVENT_CONTRACT.eventType,
    sourceService: LEGACY_AUDIT_EVENT_CONTRACT.sourceService,
    durableName: "audit_event_record_v1",
    connectionName: "audit-legacy-event-record"
  }
] as const;

export type AuditEventTransportConfiguration =
  | { readonly transport: "http" }
  | (NatsAuthentication & {
      readonly transport: "jetstream";
      readonly natsUrl: string;
    });

export interface ManagedJetStreamConsumer {
  initialize(): Promise<void>;
  checkReadiness(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export type ManagedJetStreamConsumerFactory = (
  options: DurableJetStreamConsumerOptions<JsonValue>
) => ManagedJetStreamConsumer;

export type AuditEventReceiver = typeof receiveInternalAuditEvent;
export type OnCloseRegistrar = (hook: () => Promise<void>) => void;

export interface StartedAuditEventConsumer {
  readonly sourceService: AuditSourceService;
  readonly eventType: (typeof AUDIT_EVENT_CONSUMERS)[number]["eventType"];
  readonly durableName: (typeof AUDIT_EVENT_CONSUMERS)[number]["durableName"];
  readonly consumer: ManagedJetStreamConsumer;
}

export function readAuditEventTransportConfiguration(env: NodeJS.ProcessEnv): AuditEventTransportConfiguration {
  const transport = env.DURABLE_EVENT_TRANSPORT?.trim() || "http";
  if (transport === "http") {
    return { transport };
  }
  if (transport !== "jetstream") {
    throw new Error("DURABLE_EVENT_TRANSPORT must be either http or jetstream");
  }
  return {
    transport,
    natsUrl: requireCredentialFreeNatsUrl(env.NATS_URL),
    ...readNatsAuthentication(
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

export function createAuditEventJetStreamHandler(
  db: DatabaseClient,
  sourceService: AuditSourceService,
  receive: AuditEventReceiver = receiveInternalAuditEvent
): JetStreamEventHandler {
  return async (event) => {
    const parsed =
      sourceService === LEGACY_AUDIT_EVENT_CONTRACT.sourceService
        ? parseLegacyAuditEventEnvelope(event)
        : parseInternalAuditEventEnvelope(event, sourceService);
    if (!parsed.success) {
      return { action: "term" };
    }

    try {
      const result = await receive(db, parsed.data);
      return result.status === "conflict" ? { action: "term" } : { action: "ack" };
    } catch {
      return { action: "retry" };
    }
  };
}

export async function startAuditEventJetStreamConsumers(
  registerOnClose: OnCloseRegistrar,
  db: DatabaseClient,
  configuration: Extract<AuditEventTransportConfiguration, { transport: "jetstream" }>,
  factory: ManagedJetStreamConsumerFactory = (options) => new DurableJetStreamConsumer(options)
): Promise<readonly StartedAuditEventConsumer[]> {
  const started = AUDIT_EVENT_CONSUMERS.map((definition) => ({
    ...definition,
    consumer: factory({
      eventType: definition.eventType,
      durableName: definition.durableName,
      connectionName: definition.connectionName,
      servers: configuration.natsUrl,
      authToken: configuration.authToken,
      username: configuration.username,
      password: configuration.password,
      provisionTopology: false,
      handler: createAuditEventJetStreamHandler(db, definition.sourceService)
    })
  }));

  try {
    await Promise.all(started.map(({ consumer }) => consumer.initialize()));
    for (const { consumer } of started) consumer.start();
  } catch (error) {
    await Promise.allSettled(started.map(({ consumer }) => consumer.stop()));
    throw error;
  }

  registerOnClose(async () => {
    const results = await Promise.allSettled(started.map(({ consumer }) => consumer.stop()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  });
  return started;
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
    throw new Error("NATS_URL must be a valid credential-free NATS URL");
  }
  if (
    (parsed.protocol !== "nats:" && parsed.protocol !== "tls:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NATS_URL must be a credential-free nats: or tls: endpoint without path, query, or hash");
  }
  return normalized;
}
