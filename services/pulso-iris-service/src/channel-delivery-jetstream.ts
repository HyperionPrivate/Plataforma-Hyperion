import {
  DurableJetStreamConsumer,
  type JetStreamEventHandler,
  type NatsAuthentication
} from "@hyperion/durable-events";
import type { DatabaseClient } from "@hyperion/database";
import {
  CHANNEL_DELIVERY_EVENT_TYPE,
  channelDeliveryEventSchema,
  receiveChannelDeliveryEvent,
  type ChannelDeliveryEvent
} from "./channel-delivery-events.js";
import type {
  ManagedJetStreamConsumer,
  ManagedJetStreamConsumerFactory,
  OnCloseRegistrar
} from "./channel-inbound-jetstream.js";

export const CHANNEL_DELIVERY_DURABLE_NAME = "pulso_channel_delivery_v1";

export type ChannelDeliveryJetStreamConfiguration = NatsAuthentication & {
  readonly natsUrl: string;
};

export type ChannelDeliveryReceiver = (
  db: DatabaseClient,
  event: ChannelDeliveryEvent
) => ReturnType<typeof receiveChannelDeliveryEvent>;

export function createChannelDeliveryJetStreamHandler(
  db: DatabaseClient,
  receive: ChannelDeliveryReceiver = receiveChannelDeliveryEvent
): JetStreamEventHandler {
  return async (event) => {
    const parsed = channelDeliveryEventSchema.safeParse(event);
    if (!parsed.success) return { action: "term" };
    try {
      const result = await receive(db, parsed.data);
      if (result.status === "gap" || result.status === "retryable") return { action: "retry" };
      if (result.status === "conflict") return { action: "term" };
      return { action: "ack" };
    } catch {
      return { action: "retry" };
    }
  };
}

export async function startChannelDeliveryJetStreamConsumer(
  registerOnClose: OnCloseRegistrar,
  db: DatabaseClient,
  configuration: ChannelDeliveryJetStreamConfiguration,
  factory: ManagedJetStreamConsumerFactory = (options) => new DurableJetStreamConsumer(options)
): Promise<ManagedJetStreamConsumer> {
  const consumer = factory({
    eventType: CHANNEL_DELIVERY_EVENT_TYPE,
    durableName: CHANNEL_DELIVERY_DURABLE_NAME,
    connectionName: "pulso-channel-delivery-v1",
    servers: configuration.natsUrl,
    authToken: configuration.authToken,
    username: configuration.username,
    password: configuration.password,
    provisionTopology: false,
    handler: createChannelDeliveryJetStreamHandler(db)
  });
  registerOnClose(() => consumer.stop());
  await consumer.initialize();
  consumer.start();
  return consumer;
}
