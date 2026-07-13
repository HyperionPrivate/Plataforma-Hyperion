import {
  DurableJetStreamConsumer,
  type DurableJetStreamConsumerOptions,
  type JetStreamEventHandler,
  type JsonValue,
  type NatsAuthentication
} from "@hyperion/durable-events";
import type { DatabaseClient } from "@hyperion/database";
import { consumePulsoMessageEvent, pulsoMessageEventSchema } from "./pulso-events.js";

export const PULSO_MESSAGE_EVENT_TYPE = "pulso.message.received.v1";
export const PULSO_MESSAGE_DURABLE_NAME = "sofia_pulso_message_v1";

export type PulsoMessageJetStreamConfiguration = NatsAuthentication & {
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

export type PulsoMessageReceiver = typeof consumePulsoMessageEvent;
export type OnCloseRegistrar = (hook: () => Promise<void>) => void;

export function createPulsoMessageJetStreamHandler(
  db: DatabaseClient,
  consume: PulsoMessageReceiver = consumePulsoMessageEvent
): JetStreamEventHandler {
  return async (event) => {
    const parsed = pulsoMessageEventSchema.safeParse(event);
    if (!parsed.success) {
      return { action: "term" };
    }

    try {
      const result = await consume(db, parsed.data);
      return result.status === "conflict" ? { action: "term" } : { action: "ack" };
    } catch {
      return { action: "retry" };
    }
  };
}

export async function startPulsoMessageJetStreamConsumer(
  registerOnClose: OnCloseRegistrar,
  db: DatabaseClient,
  configuration: PulsoMessageJetStreamConfiguration,
  factory: ManagedJetStreamConsumerFactory = (options) => new DurableJetStreamConsumer(options)
): Promise<ManagedJetStreamConsumer> {
  const consumer = factory({
    eventType: PULSO_MESSAGE_EVENT_TYPE,
    durableName: PULSO_MESSAGE_DURABLE_NAME,
    connectionName: "sofia-pulso-message",
    servers: configuration.natsUrl,
    authToken: configuration.authToken,
    username: configuration.username,
    password: configuration.password,
    provisionTopology: false,
    handler: createPulsoMessageJetStreamHandler(db)
  });
  registerOnClose(() => consumer.stop());
  await consumer.initialize();
  consumer.start();
  return consumer;
}
