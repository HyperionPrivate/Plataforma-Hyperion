import type { DatabaseClient } from "@hyperion/database";
import { accessTenantSnapshotV1EventType } from "@hyperion/platform-contracts/access-tenant-snapshot";
import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_ACCESS_TENANT_SNAPSHOT_DURABLE_NAME,
  startAccessTenantProjectionJetStreamConsumer,
  type ManagedAccessTenantProjectionConsumerFactory
} from "./access-tenant-projection-jetstream.js";

describe("Access tenant projection JetStream lifecycle", () => {
  it("starts one fixed durable consumer independently from producer switches", async () => {
    const initialize = vi.fn(async () => undefined);
    const checkReadiness = vi.fn(async () => undefined);
    const start = vi.fn();
    const stop = vi.fn(async () => undefined);
    const factory = vi.fn<ManagedAccessTenantProjectionConsumerFactory>(() => ({
      initialize,
      checkReadiness,
      start,
      stop
    }));
    let closeHook: (() => Promise<void>) | undefined;

    const consumer = await startAccessTenantProjectionJetStreamConsumer(
      (hook) => {
        closeHook = hook;
      },
      {} as DatabaseClient,
      {
        natsUrl: "nats://nats:4222",
        username: "channel",
        password: "controlled-channel-password"
      },
      factory
    );

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: accessTenantSnapshotV1EventType,
        durableName: CHANNEL_ACCESS_TENANT_SNAPSHOT_DURABLE_NAME,
        connectionName: "channel-access-tenant-snapshot",
        servers: "nats://nats:4222",
        username: "channel",
        password: "controlled-channel-password",
        provisionTopology: false,
        handler: expect.any(Function)
      })
    );
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    await expect(consumer.checkReadiness()).resolves.toBeUndefined();
    await closeHook?.();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
