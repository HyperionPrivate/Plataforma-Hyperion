import {
  DurableJetStreamConsumer,
  type DurableJetStreamConsumerOptions,
  type JetStreamEventHandler,
  type JsonValue,
  type NatsAuthentication
} from "@hyperion/durable-events";
import type { DatabaseClient } from "@hyperion/database";
import type { LegacyPulsoPositionResolver } from "./pulso-position-client.js";
import {
  PULSO_MESSAGE_EVENT_V1_TYPE,
  PULSO_MESSAGE_EVENT_V2_TYPE,
  consumePulsoMessageEvent,
  pulsoMessageEventSchema,
  pulsoMessageEventV1Schema
} from "./pulso-events.js";

export const PULSO_MESSAGE_EVENT_TYPE = PULSO_MESSAGE_EVENT_V2_TYPE;
export const PULSO_MESSAGE_DURABLE_NAME = "sofia_pulso_message_v2";
export const LEGACY_PULSO_MESSAGE_EVENT_TYPE = PULSO_MESSAGE_EVENT_V1_TYPE;
export const LEGACY_PULSO_MESSAGE_DURABLE_NAME = "sofia_pulso_message_v1";

export type PulsoMessageJetStreamConfiguration = NatsAuthentication & {
  readonly natsUrl: string;
  readonly allowLegacyV1?: boolean;
  readonly resolveLegacyPosition?: LegacyPulsoPositionResolver;
};

export interface ManagedJetStreamConsumer {
  initialize(): Promise<void>;
  checkReadiness(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export type ManagedJetStreamConsumerFactory = (
  options: DurableJetStreamConsumerOptions<JsonValue>
) => ManagedJetStreamConsumer;

export type PulsoMessageReceiver = typeof consumePulsoMessageEvent;

export function createPulsoMessageJetStreamHandler(
  db: DatabaseClient,
  consume: PulsoMessageReceiver = consumePulsoMessageEvent,
  options: Readonly<{
    legacyV1?: boolean;
    resolveLegacyPosition?: LegacyPulsoPositionResolver;
  }> = {}
): JetStreamEventHandler {
  return async (event) => {
    try {
      const result = options.legacyV1
        ? await consumeLegacyEvent(db, event, consume, options.resolveLegacyPosition)
        : await consumeOrderedEvent(db, event, consume);
      if (!result) return { action: "term" };
      if (result.status === "gap") return { action: "retry" };
      return result.status === "conflict" ? { action: "term" } : { action: "ack" };
    } catch {
      return { action: "retry" };
    }
  };
}

async function consumeLegacyEvent(
  db: DatabaseClient,
  event: unknown,
  consume: PulsoMessageReceiver,
  resolver: LegacyPulsoPositionResolver | undefined
) {
  const parsed = pulsoMessageEventV1Schema.safeParse(event);
  if (!parsed.success) return undefined;
  const position = await requireLegacyPositionResolver(resolver)(parsed.data);
  return consume(db, parsed.data, position);
}

async function consumeOrderedEvent(db: DatabaseClient, event: unknown, consume: PulsoMessageReceiver) {
  const parsed = pulsoMessageEventSchema.safeParse(event);
  if (!parsed.success) return undefined;
  return consume(db, parsed.data);
}

export async function startPulsoMessageJetStreamConsumers(
  db: DatabaseClient,
  configuration: PulsoMessageJetStreamConfiguration,
  factory: ManagedJetStreamConsumerFactory = (options) => new DurableJetStreamConsumer(options)
): Promise<readonly ManagedJetStreamConsumer[]> {
  if (configuration.allowLegacyV1 && !configuration.resolveLegacyPosition) {
    throw new Error("PULSO v1 JetStream compatibility requires an owner position resolver");
  }

  const definitions = [
    {
      eventType: PULSO_MESSAGE_EVENT_TYPE,
      durableName: PULSO_MESSAGE_DURABLE_NAME,
      connectionName: "sofia-pulso-message-v2",
      legacyV1: false
    },
    ...(configuration.allowLegacyV1
      ? [
          {
            eventType: LEGACY_PULSO_MESSAGE_EVENT_TYPE,
            durableName: LEGACY_PULSO_MESSAGE_DURABLE_NAME,
            connectionName: "sofia-pulso-message-v1-compat",
            legacyV1: true
          }
        ]
      : [])
  ] as const;

  const consumers = definitions.map((definition) =>
    factory({
      eventType: definition.eventType,
      durableName: definition.durableName,
      connectionName: definition.connectionName,
      servers: configuration.natsUrl,
      authToken: configuration.authToken,
      username: configuration.username,
      password: configuration.password,
      provisionTopology: false,
      handler: createPulsoMessageJetStreamHandler(db, consumePulsoMessageEvent, {
        legacyV1: definition.legacyV1,
        resolveLegacyPosition: configuration.resolveLegacyPosition
      })
    })
  );

  try {
    await Promise.all(consumers.map((consumer) => consumer.initialize()));
    consumers.forEach((consumer) => consumer.start());
    return consumers;
  } catch (error) {
    await Promise.allSettled([...consumers].reverse().map((consumer) => consumer.stop()));
    throw error;
  }
}

function requireLegacyPositionResolver(resolver: LegacyPulsoPositionResolver | undefined): LegacyPulsoPositionResolver {
  if (!resolver) throw new Error("PULSO v1 compatibility resolver is not configured");
  return resolver;
}
