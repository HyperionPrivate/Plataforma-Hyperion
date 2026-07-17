import {
  DurableJetStreamConsumer,
  type DurableJetStreamConsumerOptions,
  type JetStreamEventHandler,
  type JsonValue,
  type NatsAuthentication
} from "@hyperion/durable-events";
import type { DatabaseClient } from "@hyperion/database";
import {
  CHANNEL_INBOUND_EVENT_V1_TYPE,
  CHANNEL_INBOUND_EVENT_V2_TYPE,
  bindChannelOwnerThread,
  channelInboundEventSchema,
  compatibleChannelInboundEventSchema,
  isLegacyChannelInboundEvent,
  receiveChannelInboundEvent
} from "./channel-inbound-events.js";
import type { LegacyChannelPositionResolver } from "./channel-position-client.js";
import type { ChannelThreadClient } from "./channel-thread-client.js";

export const CHANNEL_INBOUND_EVENT_TYPE = CHANNEL_INBOUND_EVENT_V2_TYPE;
export const CHANNEL_INBOUND_DURABLE_NAME = "pulso_channel_inbound_v2";
export const LEGACY_CHANNEL_INBOUND_EVENT_TYPE = CHANNEL_INBOUND_EVENT_V1_TYPE;
export const LEGACY_CHANNEL_INBOUND_DURABLE_NAME = "pulso_channel_inbound_v1";

export type ChannelInboundJetStreamConfiguration = NatsAuthentication & {
  readonly natsUrl: string;
  readonly allowLegacyV1?: boolean;
  readonly resolveLegacyPosition?: LegacyChannelPositionResolver;
  readonly channelThreads?: ChannelThreadClient;
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

export type OnCloseRegistrar = (hook: () => Promise<void>) => void;

export type ChannelInboundReceiver = typeof receiveChannelInboundEvent;

export function createChannelInboundJetStreamHandler(
  db: DatabaseClient,
  receive: ChannelInboundReceiver = receiveChannelInboundEvent,
  options: Readonly<{
    allowLegacyV1?: boolean;
    resolveLegacyPosition?: LegacyChannelPositionResolver;
    channelThreads?: ChannelThreadClient;
    logger?: { error: (message: string, fields?: Record<string, unknown>) => void };
  }> = {}
): JetStreamEventHandler {
  const logger = options.logger ?? { error: () => undefined };
  return async (event) => {
    const schema = options.allowLegacyV1 ? compatibleChannelInboundEventSchema : channelInboundEventSchema;
    const parsed = schema.safeParse(event);
    if (!parsed.success) {
      return { action: "term" };
    }

    try {
      const legacyPosition = isLegacyChannelInboundEvent(parsed.data)
        ? await requireLegacyPositionResolver(options.resolveLegacyPosition)(parsed.data)
        : undefined;
      const result = await receive(db, parsed.data, legacyPosition);
      if (result.status === "gap") return { action: "retry" };
      if (result.status === "conflict") return { action: "term" };
      await bindChannelOwnerThread(options.channelThreads, parsed.data, result.result, logger);
      return { action: "ack" };
    } catch {
      return { action: "retry" };
    }
  };
}

export async function startChannelInboundJetStreamConsumer(
  registerOnClose: OnCloseRegistrar,
  db: DatabaseClient,
  configuration: ChannelInboundJetStreamConfiguration,
  factory: ManagedJetStreamConsumerFactory = (options) => new DurableJetStreamConsumer(options)
): Promise<ManagedJetStreamConsumer> {
  if (configuration.allowLegacyV1 && !configuration.resolveLegacyPosition) {
    throw new Error("Channel v1 JetStream compatibility requires an owner position resolver");
  }
  const definitions = [
    { eventType: CHANNEL_INBOUND_EVENT_TYPE, durableName: CHANNEL_INBOUND_DURABLE_NAME, legacy: false },
    ...(configuration.allowLegacyV1
      ? [
          {
            eventType: LEGACY_CHANNEL_INBOUND_EVENT_TYPE,
            durableName: LEGACY_CHANNEL_INBOUND_DURABLE_NAME,
            legacy: true
          }
        ]
      : [])
  ];
  const consumers = definitions.map((definition) =>
    factory({
      eventType: definition.eventType,
      durableName: definition.durableName,
      connectionName: definition.legacy ? "pulso-channel-inbound-v1-compat" : "pulso-channel-inbound-v2",
      servers: configuration.natsUrl,
      authToken: configuration.authToken,
      username: configuration.username,
      password: configuration.password,
      provisionTopology: false,
      handler: createChannelInboundJetStreamHandler(db, receiveChannelInboundEvent, {
        allowLegacyV1: definition.legacy,
        resolveLegacyPosition: configuration.resolveLegacyPosition,
        channelThreads: configuration.channelThreads
      })
    })
  );
  const managed: ManagedJetStreamConsumer = {
    initialize: async () => Promise.all(consumers.map((consumer) => consumer.initialize())).then(() => undefined),
    checkReadiness: async () =>
      Promise.all(consumers.map((consumer) => consumer.checkReadiness())).then(() => undefined),
    start: () => consumers.forEach((consumer) => consumer.start()),
    stop: async () => Promise.all([...consumers].reverse().map((consumer) => consumer.stop())).then(() => undefined)
  };
  registerOnClose(() => managed.stop());
  await managed.initialize();
  managed.start();
  return managed;
}

function requireLegacyPositionResolver(
  resolver: LegacyChannelPositionResolver | undefined
): LegacyChannelPositionResolver {
  if (!resolver) throw new Error("Channel v1 compatibility requires an owner position resolver");
  return resolver;
}
