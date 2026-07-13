import {
  DurableJetStreamConsumer,
  type DurableJetStreamConsumerOptions,
  type JetStreamEventHandler,
  type JsonValue,
  type NatsAuthentication
} from "@hyperion/durable-events";
import type { DatabaseClient } from "@hyperion/database";
import { channelInboundEventSchema, receiveChannelInboundEvent } from "./channel-inbound-events.js";

export const CHANNEL_INBOUND_EVENT_TYPE = "channel.inbound.received.v1";
export const CHANNEL_INBOUND_DURABLE_NAME = "pulso_channel_inbound_v1";

export type ChannelInboundJetStreamConfiguration = NatsAuthentication & {
  readonly natsUrl: string;
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
  receive: ChannelInboundReceiver = receiveChannelInboundEvent
): JetStreamEventHandler {
  return async (event) => {
    const parsed = channelInboundEventSchema.safeParse(event);
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

export async function startChannelInboundJetStreamConsumer(
  registerOnClose: OnCloseRegistrar,
  db: DatabaseClient,
  configuration: ChannelInboundJetStreamConfiguration,
  factory: ManagedJetStreamConsumerFactory = (options) => new DurableJetStreamConsumer(options)
): Promise<ManagedJetStreamConsumer> {
  const consumer = factory({
    eventType: CHANNEL_INBOUND_EVENT_TYPE,
    durableName: CHANNEL_INBOUND_DURABLE_NAME,
    connectionName: "pulso-channel-inbound",
    servers: configuration.natsUrl,
    authToken: configuration.authToken,
    username: configuration.username,
    password: configuration.password,
    provisionTopology: false,
    handler: createChannelInboundJetStreamHandler(db)
  });
  registerOnClose(() => consumer.stop());
  await consumer.initialize();
  consumer.start();
  return consumer;
}
