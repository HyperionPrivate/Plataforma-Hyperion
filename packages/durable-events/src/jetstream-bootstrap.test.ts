import { describe, expect, it } from "vitest";
import {
  HYPERION_KNOWN_CONSUMERS,
  provisionHyperionJetStreamTopology,
  readJetStreamTopologyBootstrapOptions
} from "./jetstream-bootstrap.js";
import {
  hyperionConsumerConfiguration,
  hyperionStreamConfiguration,
  type HyperionConsumerTopologySnapshot,
  type HyperionStreamConfiguration,
  type JetStreamTopologyAdapter
} from "./jetstream-consumer.js";

describe("JetStream topology bootstrap", () => {
  it("rejects example credentials in production despite legacy bypass signals", () => {
    expect(() =>
      readJetStreamTopologyBootstrapOptions({
        NODE_ENV: "production",
        HYPERION_ENVIRONMENT: "production",
        CI: "true",
        HYPERION_ALLOW_EXAMPLE_SECRETS: "true",
        NATS_URL: "nats://nats:4222",
        NATS_USERNAME: "topology",
        NATS_PASSWORD: "replace-topology-nats-secret-01"
      })
    ).toThrow(/NATS_PASSWORD/);
  });

  it("accepts example credentials only for an explicit local rehearsal", () => {
    expect(
      readJetStreamTopologyBootstrapOptions({
        NODE_ENV: "production",
        HYPERION_ENVIRONMENT: "local",
        NATS_URL: "nats://nats:4222",
        NATS_USERNAME: "topology",
        NATS_PASSWORD: "replace-topology-nats-secret-01"
      })
    ).toMatchObject({
      server: "nats://nats:4222",
      username: "topology",
      password: "replace-topology-nats-secret-01",
      allowToken: true
    });
  });

  it("blocks the pilot bootstrap in canonical production despite declarative HA values", () => {
    expect(() =>
      readJetStreamTopologyBootstrapOptions({
        NODE_ENV: "test",
        HYPERION_ENVIRONMENT: "production",
        NATS_URL: "tls://nats.internal:4222",
        NATS_USERNAME: "topology",
        NATS_PASSWORD: "real-topology-password-0001",
        PRODUCTION_JETSTREAM_ENABLED: "true",
        JETSTREAM_REPLICAS: "3",
        JETSTREAM_MAX_BYTES: "10737418240",
        JETSTREAM_MAX_MSGS: "1000000"
      })
    ).toThrow(/single-node pilot/);
  });

  it("owns active durables, separate v1 rollout durables and the drain-only Audit durable", () => {
    expect(HYPERION_KNOWN_CONSUMERS).toHaveLength(14);
    expect(new Set(HYPERION_KNOWN_CONSUMERS.map(({ durableName }) => durableName)).size).toBe(14);
    expect(HYPERION_KNOWN_CONSUMERS).toEqual(
      expect.arrayContaining([
        {
          eventType: "sofia.audit.event.record.v1",
          durableName: "audit_sofia_event_record_v1"
        },
        {
          eventType: "lumen.audit.event.record.v1",
          durableName: "audit_lumen_event_record_v1"
        },
        {
          eventType: "pulso.audit.event.record.v1",
          durableName: "audit_pulso_event_record_v1"
        },
        {
          eventType: "channel.audit.event.record.v1",
          durableName: "audit_channel_event_record_v1"
        },
        {
          eventType: "audit.event.record.v1",
          durableName: "audit_event_record_v1"
        },
        {
          eventType: "access.tenant.snapshot.v1",
          durableName: "channel_access_tenant_snapshot_v1"
        },
        {
          eventType: "channel.inbound.received.v2",
          durableName: "pulso_channel_inbound_v2"
        },
        {
          eventType: "channel.delivery.updated.v1",
          durableName: "pulso_channel_delivery_v1"
        },
        {
          eventType: "pulso.message.received.v1",
          durableName: "sofia_pulso_message_v1"
        },
        {
          eventType: "pulso.message.received.v2",
          durableName: "sofia_pulso_message_v2"
        }
      ])
    );
  });

  it("provisions the stream and all fixed consumers idempotently", async () => {
    const fixture = topologyFixture();
    const first = await provisionHyperionJetStreamTopology(fixture.adapter);
    const second = await provisionHyperionJetStreamTopology(fixture.adapter);

    expect(first.consumers).toHaveLength(14);
    expect(first.consumers.filter(({ result }) => result.consumerCreated)).toHaveLength(14);
    expect(first.consumers.filter(({ result }) => result.streamCreated)).toHaveLength(1);
    expect(second.consumers.every(({ result }) => !result.streamCreated && !result.consumerCreated)).toBe(true);
  });

  it("keeps the narrow legacy max-deliver upgrade in the administrative bootstrap", async () => {
    const fixture = topologyFixture();
    await provisionHyperionJetStreamTopology(fixture.adapter);
    const first = HYPERION_KNOWN_CONSUMERS[0]!;
    fixture.consumers.set(first.durableName, {
      ...fixture.consumers.get(first.durableName)!,
      max_deliver: 12
    });

    const result = await provisionHyperionJetStreamTopology(fixture.adapter);
    expect(result.consumers[0]?.result.legacyConsumerUpgraded).toBe(true);
    expect(fixture.consumers.get(first.durableName)?.max_deliver).toBe(-1);
  });
});

function topologyFixture(): {
  adapter: JetStreamTopologyAdapter;
  consumers: Map<string, HyperionConsumerTopologySnapshot>;
} {
  let stream: HyperionStreamConfiguration | undefined;
  const consumers = new Map<string, HyperionConsumerTopologySnapshot>();
  const adapter: JetStreamTopologyAdapter = {
    getStream: async () => stream,
    addStream: async (configuration) => {
      stream = configuration;
    },
    getConsumer: async (_stream, durableName) => consumers.get(durableName),
    addConsumer: async (_stream, configuration) => {
      consumers.set(configuration.durable_name, { ...configuration });
    },
    updateConsumerMaxDeliver: async (_stream, durableName, maxDeliver) => {
      const existing = consumers.get(durableName);
      if (existing) consumers.set(durableName, { ...existing, max_deliver: maxDeliver });
    }
  };
  // Ensures this fixture follows the production topology functions rather than
  // silently accepting a partial stream shape.
  void hyperionStreamConfiguration();
  void hyperionConsumerConfiguration(HYPERION_KNOWN_CONSUMERS[0]!);
  return { adapter, consumers };
}
