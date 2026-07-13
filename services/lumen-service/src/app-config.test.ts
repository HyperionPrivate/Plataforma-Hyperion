import { describe, expect, it } from "vitest";
import { readDurableOutboxConfiguration } from "./app.js";

const NATS_TEST_SECRET = "nats-test-secret-with-24-characters";

describe("LUMEN durable outbox configuration", () => {
  it("uses HTTP by default and honors both disable switches", () => {
    expect(readDurableOutboxConfiguration({})).toEqual({ transport: "http", enabled: true });
    expect(readDurableOutboxConfiguration({ DURABLE_HTTP_OUTBOX_ENABLED: "false" })).toEqual({
      transport: "http",
      enabled: false
    });
    expect(readDurableOutboxConfiguration({ DURABLE_OUTBOX_ENABLED: "false" })).toEqual({
      transport: "http",
      enabled: false
    });
  });

  it("requires credential-separated JetStream configuration", () => {
    expect(
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_AUTH_TOKEN: NATS_TEST_SECRET
      })
    ).toEqual({
      transport: "jetstream",
      enabled: true,
      natsUrl: "nats://nats:4222",
      authentication: { authToken: NATS_TEST_SECRET }
    });
    expect(() =>
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://user:password@nats:4222",
        NATS_AUTH_TOKEN: NATS_TEST_SECRET
      })
    ).toThrow("must not contain credentials");
    expect(() =>
      readDurableOutboxConfiguration({ DURABLE_EVENT_TRANSPORT: "jetstream", NATS_URL: "nats://nats:4222" })
    ).toThrow("NATS authentication is required");
  });

  it("requires a per-service username identity in production", () => {
    expect(() =>
      readDurableOutboxConfiguration({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_AUTH_TOKEN: NATS_TEST_SECRET
      })
    ).toThrow("token authentication is not allowed");
  });

  it.each([
    "https://nats:4222",
    "nats://nats:4222/",
    "nats://nats:4222/path",
    "nats://nats:4222?token=unsafe",
    "nats://nats:4222#fragment"
  ])("rejects a non-NATS or component-bearing broker URL %s", (natsUrl) => {
    expect(() =>
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: natsUrl,
        NATS_AUTH_TOKEN: NATS_TEST_SECRET
      })
    ).toThrow("NATS_URL");
  });

  it("rejects unknown transports", () => {
    expect(() => readDurableOutboxConfiguration({ DURABLE_EVENT_TRANSPORT: "unknown" })).toThrow(
      "DURABLE_EVENT_TRANSPORT must be either http or jetstream"
    );
  });
});
