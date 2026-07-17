import type { DatabaseClient } from "@hyperion/database";
import {
  DurableJetStreamConsumer,
  type DurableJetStreamConsumerOptions,
  type JsonValue,
  type NatsAuthentication
} from "@hyperion/durable-events";
import { createLumenProjectionJetStreamHandler } from "./projection-events.js";

export const LUMEN_PROJECTION_CONSUMERS = [
  {
    eventType: "access.lumen.tenant-snapshot.v1",
    durableName: "lumen_tenant_snapshot_v1",
    connectionName: "lumen-tenant-snapshot"
  },
  {
    eventType: "access.lumen.operator-grant.v1",
    durableName: "lumen_operator_grant_v1",
    connectionName: "lumen-operator-grant"
  },
  {
    eventType: "pulso.lumen.encounter-reference.v1",
    durableName: "lumen_encounter_reference_v1",
    connectionName: "lumen-encounter-reference"
  }
] as const;

export type LumenProjectionJetStreamConfiguration = NatsAuthentication & {
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

export async function startLumenProjectionJetStreamConsumers(
  registerOnClose: OnCloseRegistrar,
  db: DatabaseClient,
  configuration: LumenProjectionJetStreamConfiguration,
  factory: ManagedJetStreamConsumerFactory = (options) => new DurableJetStreamConsumer(options)
): Promise<readonly ManagedJetStreamConsumer[]> {
  const handler = createLumenProjectionJetStreamHandler(db);
  const consumers = LUMEN_PROJECTION_CONSUMERS.map((definition) =>
    factory({
      ...definition,
      servers: configuration.natsUrl,
      authToken: configuration.authToken,
      username: configuration.username,
      password: configuration.password,
      provisionTopology: false,
      handler
    })
  );
  registerOnClose(async () => {
    await Promise.all(consumers.map((consumer) => consumer.stop()));
  });
  await Promise.all(consumers.map((consumer) => consumer.initialize()));
  for (const consumer of consumers) consumer.start();
  return consumers;
}
