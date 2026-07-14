import { describe, expect, it } from "vitest";
import { HYPERION_KNOWN_CONSUMERS, provisionHyperionJetStreamTopology } from "./jetstream-bootstrap.js";
import {
  hyperionConsumerConfiguration,
  hyperionStreamConfiguration,
  type HyperionConsumerTopologySnapshot,
  type HyperionStreamConfiguration,
  type JetStreamTopologyAdapter
} from "./jetstream-consumer.js";

describe("JetStream topology bootstrap", () => {
  it("owns active durables, separate v1 rollout durables and the drain-only Audit durable", () => {
    expect(HYPERION_KNOWN_CONSUMERS).toHaveLength(10);
    expect(new Set(HYPERION_KNOWN_CONSUMERS.map(({ durableName }) => durableName)).size).toBe(10);
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
          eventType: "audit.event.record.v1",
          durableName: "audit_event_record_v1"
        },
        {
          eventType: "channel.inbound.received.v2",
          durableName: "pulso_channel_inbound_v2"
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

    expect(first.consumers).toHaveLength(10);
    expect(first.consumers.filter(({ result }) => result.consumerCreated)).toHaveLength(10);
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
