import type { DatabaseClient } from "@hyperion/database";
import {
  DurableJetStreamConsumer,
  type DurableJetStreamConsumerOptions,
  type JsonValue,
  type NatsAuthentication
} from "@hyperion/durable-events";
import { accessTenantSnapshotV1EventType } from "@hyperion/platform-contracts/access-tenant-snapshot";
import { createAccessTenantProjectionJetStreamHandler } from "./access-tenant-projections.js";

export const CHANNEL_ACCESS_TENANT_SNAPSHOT_DURABLE_NAME = "channel_access_tenant_snapshot_v1";

export type AccessTenantProjectionJetStreamConfiguration = NatsAuthentication & {
  readonly natsUrl: string;
};

export interface ManagedAccessTenantProjectionConsumer {
  initialize(): Promise<void>;
  checkReadiness(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export type ManagedAccessTenantProjectionConsumerFactory = (
  options: DurableJetStreamConsumerOptions<JsonValue>
) => ManagedAccessTenantProjectionConsumer;

export async function startAccessTenantProjectionJetStreamConsumer(
  registerOnClose: (hook: () => Promise<void>) => void,
  db: DatabaseClient,
  configuration: AccessTenantProjectionJetStreamConfiguration,
  factory: ManagedAccessTenantProjectionConsumerFactory = (options) => new DurableJetStreamConsumer(options)
): Promise<ManagedAccessTenantProjectionConsumer> {
  const consumer = factory({
    eventType: accessTenantSnapshotV1EventType,
    durableName: CHANNEL_ACCESS_TENANT_SNAPSHOT_DURABLE_NAME,
    connectionName: "channel-access-tenant-snapshot",
    servers: configuration.natsUrl,
    authToken: configuration.authToken,
    username: configuration.username,
    password: configuration.password,
    provisionTopology: false,
    handler: createAccessTenantProjectionJetStreamHandler(db)
  });
  registerOnClose(() => consumer.stop());
  await consumer.initialize();
  consumer.start();
  return consumer;
}
