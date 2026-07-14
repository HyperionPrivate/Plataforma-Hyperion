import { describe, expect, it } from "vitest";
import { assertJetStreamProductionGate } from "./jetstream-production-gate.js";

describe("JetStream production gate", () => {
  it("allows jetstream outside production", () => {
    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "development",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222"
      })
    ).not.toThrow();
  });

  it("refuses jetstream in production without the HA enablement flag", () => {
    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222"
      })
    ).toThrow(/Single-node JetStream remains blocked/);
  });

  it("refuses PRODUCTION_JETSTREAM_ENABLED without TLS and replicas", () => {
    expect(() =>
      assertJetStreamProductionGate({
        HYPERION_ENVIRONMENT: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        PRODUCTION_JETSTREAM_ENABLED: "true",
        JETSTREAM_REPLICAS: "1",
        NATS_URL: "nats://nats:4222"
      })
    ).toThrow(/JETSTREAM_REPLICAS>=3/);

    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        PRODUCTION_JETSTREAM_ENABLED: "true",
        JETSTREAM_REPLICAS: "3",
        NATS_URL: "nats://nats:4222"
      })
    ).toThrow(/tls:/);
  });

  it("accepts an explicit HA jetstream configuration", () => {
    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        PRODUCTION_JETSTREAM_ENABLED: "true",
        JETSTREAM_REPLICAS: "3",
        NATS_URL: "tls://nats.internal:4222"
      })
    ).not.toThrow();
  });

  it("ignores http transport in production", () => {
    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "http"
      })
    ).not.toThrow();
  });
});
