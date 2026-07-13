import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_EVENT_CONSUMERS,
  createAuditEventJetStreamHandler,
  readAuditEventTransportConfiguration,
  startAuditEventJetStreamConsumers,
  type AuditEventReceiver,
  type ManagedJetStreamConsumerFactory
} from "./audit-jetstream.js";

const NATS_TEST_SECRET = "nats-test-secret-with-24-characters";

const EVENT = {
  id: "3fd21746-8456-4972-9a89-95519bbcff22",
  type: AUDIT_EVENT_CONSUMERS[0].eventType,
  version: 1,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
  payload: {
    tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
    actorId: "sofia-automation",
    eventType: "sofia.job.queued",
    entityType: "agent_job",
    entityId: "94f7d38e-a9b8-4861-8427-29abfe67b687",
    metadata: { source: "pulso" }
  }
} as const;

describe("audit JetStream adapter", () => {
  it("maps accepted and duplicate database outcomes to ack", async () => {
    for (const status of ["accepted", "duplicate"] as const) {
      await expect(
        createAuditEventJetStreamHandler(database(), "sofia-automation", receiverReturning(status))(EVENT, context())
      ).resolves.toEqual({ action: "ack" });
    }
  });

  it("maps conflict or strict-envelope failure to term", async () => {
    await expect(
      createAuditEventJetStreamHandler(database(), "sofia-automation", receiverReturning("conflict"))(EVENT, context())
    ).resolves.toEqual({ action: "term" });
    await expect(
      createAuditEventJetStreamHandler(
        database(),
        "sofia-automation",
        receiverReturning("accepted")
      )({ ...EVENT, tenantId: "1a4857f9-d4ca-43df-94dd-aa5dff87a874" }, context())
    ).resolves.toEqual({ action: "term" });
  });

  it("terminates an envelope whose body claims the other source contract", async () => {
    const receive = receiverReturning("accepted");

    await expect(
      createAuditEventJetStreamHandler(
        database(),
        "sofia-automation",
        receive
      )({ ...EVENT, type: AUDIT_EVENT_CONSUMERS[1].eventType }, context())
    ).resolves.toEqual({ action: "term" });
    expect(receive).not.toHaveBeenCalled();
  });

  it("drains the legacy durable without inventing producer provenance", async () => {
    const receive = receiverReturning("accepted");
    const legacyEvent = { ...EVENT, type: AUDIT_EVENT_CONSUMERS[2].eventType };

    await expect(
      createAuditEventJetStreamHandler(
        database(),
        "legacy-unknown",
        receive
      )(legacyEvent, {
        subject: `hyperion.events.${legacyEvent.type}`,
        deliveryCount: 1
      })
    ).resolves.toEqual({ action: "ack" });
    expect(receive).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceService: "legacy-unknown",
        type: "legacy.audit.event.record.v1"
      })
    );
  });

  it("maps a transient persistence error to retry", async () => {
    const receive = vi.fn<AuditEventReceiver>(async () => Promise.reject(new Error("temporary database failure")));
    await expect(
      createAuditEventJetStreamHandler(database(), "sofia-automation", receive)(EVENT, context())
    ).resolves.toEqual({ action: "retry" });
  });

  it("starts both source-scoped durables plus the legacy drain and stops them through one close hook", async () => {
    const start = vi.fn();
    const stop = vi.fn(async () => undefined);
    const initialize = vi.fn(async () => undefined);
    const checkReadiness = vi.fn(async () => undefined);
    let closeHook: (() => Promise<void>) | undefined;
    const factory = vi.fn<ManagedJetStreamConsumerFactory>(() => ({ initialize, checkReadiness, start, stop }));

    const consumers = await startAuditEventJetStreamConsumers(
      (hook) => {
        closeHook = hook;
      },
      database(),
      {
        transport: "jetstream",
        natsUrl: "nats://nats:4222",
        authToken: "controlled-token"
      },
      factory
    );

    expect(consumers).toHaveLength(3);
    expect(initialize).toHaveBeenCalledTimes(3);
    expect(start).toHaveBeenCalledTimes(3);
    expect(factory).toHaveBeenCalledTimes(3);
    for (const definition of AUDIT_EVENT_CONSUMERS) {
      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: definition.eventType,
          durableName: definition.durableName,
          connectionName: definition.connectionName,
          servers: "nats://nats:4222",
          authToken: "controlled-token",
          provisionTopology: false,
          handler: expect.any(Function)
        })
      );
    }
    await closeHook?.();
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it("closes every source consumer and starts none when preflight fails", async () => {
    const first = managedConsumer();
    const second = managedConsumer();
    const legacy = managedConsumer();
    second.initialize.mockRejectedValueOnce(new Error("topology unavailable"));
    const factory = vi
      .fn<ManagedJetStreamConsumerFactory>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(legacy);

    await expect(
      startAuditEventJetStreamConsumers(
        vi.fn(),
        database(),
        {
          transport: "jetstream",
          natsUrl: "nats://nats:4222",
          authToken: "controlled-token"
        },
        factory
      )
    ).rejects.toThrow("topology unavailable");

    expect(first.start).not.toHaveBeenCalled();
    expect(second.start).not.toHaveBeenCalled();
    expect(legacy.start).not.toHaveBeenCalled();
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(legacy.stop).toHaveBeenCalledTimes(1);
  });
});

describe("audit durable event transport configuration", () => {
  it("defaults to HTTP and reads separated JetStream credentials", () => {
    expect(readAuditEventTransportConfiguration({})).toEqual({ transport: "http" });
    expect(
      readAuditEventTransportConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "tls://nats:4222",
        NATS_AUTH_TOKEN: NATS_TEST_SECRET
      })
    ).toEqual({
      transport: "jetstream",
      natsUrl: "tls://nats:4222",
      authToken: NATS_TEST_SECRET
    });
  });

  it("requires a per-service username identity in production", () => {
    expect(() =>
      readAuditEventTransportConfiguration({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_AUTH_TOKEN: NATS_TEST_SECRET
      })
    ).toThrow("token authentication is not allowed");
  });

  it.each([
    "https://nats:4222",
    "nats://user:password@nats:4222",
    "nats://nats:4222/",
    "nats://nats:4222/path",
    "nats://nats:4222?token=unsafe",
    "nats://nats:4222#fragment"
  ])("rejects unsafe NATS endpoint %s", (natsUrl) => {
    expect(() =>
      readAuditEventTransportConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: natsUrl,
        NATS_AUTH_TOKEN: NATS_TEST_SECRET
      })
    ).toThrow("NATS_URL");
  });
});

function database(): DatabaseClient {
  return {} as DatabaseClient;
}

function receiverReturning(status: "accepted" | "conflict" | "duplicate"): AuditEventReceiver {
  return vi.fn(async () =>
    status === "accepted"
      ? {
          status,
          eventId: EVENT.id,
          auditEvent: {
            id: "ee02dadc-865a-4bee-8b20-087403755d80",
            tenant_id: EVENT.tenantId,
            actor_id: EVENT.payload.actorId,
            event_type: EVENT.payload.eventType,
            entity_type: EVENT.payload.entityType,
            entity_id: EVENT.payload.entityId,
            metadata: EVENT.payload.metadata,
            source_event_id: EVENT.id,
            created_at: EVENT.occurredAt
          }
        }
      : { status, eventId: EVENT.id }
  );
}

function context() {
  return { subject: `hyperion.events.${AUDIT_EVENT_CONSUMERS[0].eventType}`, deliveryCount: 1 } as const;
}

function managedConsumer() {
  return {
    initialize: vi.fn(async () => undefined),
    checkReadiness: vi.fn(async () => undefined),
    start: vi.fn(),
    stop: vi.fn(async () => undefined)
  };
}
