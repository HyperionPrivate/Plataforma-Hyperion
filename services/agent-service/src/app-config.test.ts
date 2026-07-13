import { describe, expect, it } from "vitest";
import { readDurableOutboxConfiguration, shouldStartDurableOutbox } from "./app.js";

const NATS_TEST_SECRET = "nats-test-secret-with-24-characters";

describe("agent durable outbox configuration", () => {
  it("keeps HTTP as the default and honors both disable switches", () => {
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

  it("requires explicit credential-separated JetStream configuration", () => {
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
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222"
      })
    ).toThrow("NATS authentication is required");

    expect(
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_USERNAME: "sofia",
        NATS_PASSWORD: NATS_TEST_SECRET
      })
    ).toMatchObject({ authentication: { username: "sofia", password: NATS_TEST_SECRET } });
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

  it("keeps JetStream delivery independent from the legacy internal HTTP token", () => {
    const jetStream = readDurableOutboxConfiguration({
      DURABLE_EVENT_TRANSPORT: "jetstream",
      NATS_URL: "nats://nats:4222",
      NATS_USERNAME: "sofia",
      NATS_PASSWORD: NATS_TEST_SECRET
    });

    expect(shouldStartDurableOutbox(jetStream, undefined)).toBe(true);
    expect(shouldStartDurableOutbox({ transport: "http", enabled: true }, undefined)).toBe(false);
    expect(shouldStartDurableOutbox({ transport: "http", enabled: true }, "legacy-http-token")).toBe(true);
    expect(shouldStartDurableOutbox({ ...jetStream, enabled: false }, undefined)).toBe(false);
  });

  it("rejects unknown transports", () => {
    expect(() => readDurableOutboxConfiguration({ DURABLE_EVENT_TRANSPORT: "unknown" })).toThrow(
      "DURABLE_EVENT_TRANSPORT must be either http or jetstream"
    );
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
});
