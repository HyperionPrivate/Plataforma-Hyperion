import { describe, expect, it } from "vitest";
import { assertJetStreamProductionGate, shouldEnforceJetStreamProductionGate } from "./jetstream-production-gate.js";

describe("JetStream production gate", () => {
  it("allows the JetStream pilot only in local or CI deployments", () => {
    for (const hyperionEnvironment of ["local", "ci"]) {
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: "production",
        HYPERION_ENVIRONMENT: hyperionEnvironment,
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222"
      };

      expect(shouldEnforceJetStreamProductionGate(environment)).toBe(false);
      expect(() => assertJetStreamProductionGate(environment)).not.toThrow();
    }
  });

  it("blocks canonical production and staging even when NODE_ENV is lower", () => {
    for (const hyperionEnvironment of ["production", "staging"]) {
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        HYPERION_ENVIRONMENT: hyperionEnvironment,
        DURABLE_EVENT_TRANSPORT: "jetstream"
      };

      expect(shouldEnforceJetStreamProductionGate(environment)).toBe(true);
      expect(() => assertJetStreamProductionGate(environment)).toThrow(/single-node pilot/);
    }
  });

  it("blocks NODE_ENV production and staging when the canonical variable is absent", () => {
    for (const nodeEnvironment of ["production", "staging"]) {
      expect(() =>
        assertJetStreamProductionGate({ NODE_ENV: nodeEnvironment, DURABLE_EVENT_TRANSPORT: "jetstream" })
      ).toThrow(/single-node pilot/);
    }
  });

  it("cannot be bypassed by legacy flags or declarative HA values", () => {
    expect(() =>
      assertJetStreamProductionGate({
        NODE_ENV: "development",
        HYPERION_ENVIRONMENT: "production",
        CI: "true",
        HYPERION_ALLOW_EXAMPLE_SECRETS: "true",
        PRODUCTION_JETSTREAM_ENABLED: "true",
        JETSTREAM_REPLICAS: "3",
        NATS_URL: "tls://nats.internal:4222",
        JETSTREAM_MAX_BYTES: "10737418240",
        JETSTREAM_MAX_MSGS: "1000000",
        JETSTREAM_MONITOR_URL: "https://monitor.example/nats",
        JETSTREAM_REDRIVE_RUNBOOK_URL: "docs/PRODUCTION.md",
        DURABLE_EVENT_TRANSPORT: "jetstream"
      })
    ).toThrow(/single-node pilot/);
  });

  it("rejects empty or invalid deployment declarations instead of treating them as local", () => {
    for (const hyperionEnvironment of ["", "   ", "prodution"]) {
      expect(() =>
        assertJetStreamProductionGate({
          NODE_ENV: "development",
          HYPERION_ENVIRONMENT: hyperionEnvironment,
          DURABLE_EVENT_TRANSPORT: "jetstream"
        })
      ).toThrow(/HYPERION_ENVIRONMENT must be one of/);
    }

    for (const nodeEnvironment of ["", "   ", "prodution"]) {
      expect(() =>
        assertJetStreamProductionGate({ NODE_ENV: nodeEnvironment, DURABLE_EVENT_TRANSPORT: "jetstream" })
      ).toThrow(/NODE_ENV must be one of/);
    }
  });

  it("does not block the HTTP transport in restricted deployments", () => {
    expect(() =>
      assertJetStreamProductionGate({ HYPERION_ENVIRONMENT: "production", DURABLE_EVENT_TRANSPORT: "http" })
    ).not.toThrow();
  });
});
