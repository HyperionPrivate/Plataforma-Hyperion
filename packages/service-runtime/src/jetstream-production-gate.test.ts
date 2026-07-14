import { describe, expect, it } from "vitest";
import { assertJetStreamProductionGate, shouldEnforceJetStreamProductionGate } from "./jetstream-production-gate.js";

const haBase = {
  NODE_ENV: "production",
  DURABLE_EVENT_TRANSPORT: "jetstream",
  PRODUCTION_JETSTREAM_ENABLED: "true",
  JETSTREAM_REPLICAS: "3",
  NATS_URL: "tls://nats.internal:4222",
  JETSTREAM_MAX_BYTES: "10737418240",
  JETSTREAM_MAX_MSGS: "1000000",
  JETSTREAM_MONITOR_URL: "https://monitor.example/nats",
  JETSTREAM_REDRIVE_RUNBOOK_URL: "docs/PRODUCTION.md"
} as const;

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

  it("allows Compose/CI JetStream pilots that set NODE_ENV=production with example secrets", () => {
    expect(
      shouldEnforceJetStreamProductionGate({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        HYPERION_ALLOW_EXAMPLE_SECRETS: "true"
      })
    ).toBe(false);

    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        HYPERION_ALLOW_EXAMPLE_SECRETS: "true",
        NATS_URL: "nats://nats:4222"
      })
    ).not.toThrow();

    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "production",
        CI: "true",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222"
      })
    ).not.toThrow();
  });

  it("still enforces when HYPERION_ENVIRONMENT marks real production", () => {
    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "production",
        HYPERION_ENVIRONMENT: "production",
        HYPERION_ALLOW_EXAMPLE_SECRETS: "true",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222"
      })
    ).toThrow(/Single-node JetStream remains blocked/);
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

  it("refuses HA enablement without capacity limits, monitor and redrive", () => {
    expect(() =>
      assertJetStreamProductionGate({
        ...haBase,
        JETSTREAM_MAX_BYTES: undefined,
        JETSTREAM_MAX_MSGS: undefined
      })
    ).toThrow(/JETSTREAM_MAX_BYTES/);

    expect(() =>
      assertJetStreamProductionGate({
        ...haBase,
        JETSTREAM_MONITOR_URL: "http://insecure"
      })
    ).toThrow(/JETSTREAM_MONITOR_URL/);

    expect(() =>
      assertJetStreamProductionGate({
        ...haBase,
        JETSTREAM_REDRIVE_RUNBOOK_URL: undefined
      })
    ).toThrow(/JETSTREAM_REDRIVE_RUNBOOK_URL/);
  });

  it("accepts an explicit HA jetstream configuration", () => {
    expect(() => assertJetStreamProductionGate({ ...haBase })).not.toThrow();
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
