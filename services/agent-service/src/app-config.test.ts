import { describe, expect, it, vi } from "vitest";
import { readDurableOutboxConfiguration, shouldStartDurableOutbox, stopSofiaComponents } from "./app.js";

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
        NODE_ENV: "test",
        HYPERION_ENVIRONMENT: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_AUTH_TOKEN: NATS_TEST_SECRET
      })
    ).toThrow("token authentication is not allowed");
  });

  it("keeps JetStream delivery independent from the SOFIA-to-Audit HTTP credential", () => {
    const jetStream = readDurableOutboxConfiguration({
      DURABLE_EVENT_TRANSPORT: "jetstream",
      NATS_URL: "nats://nats:4222",
      NATS_USERNAME: "sofia",
      NATS_PASSWORD: NATS_TEST_SECRET
    });

    expect(shouldStartDurableOutbox(jetStream, undefined)).toBe(true);
    expect(shouldStartDurableOutbox({ transport: "http", enabled: true }, undefined)).toBe(false);
    expect(shouldStartDurableOutbox({ transport: "http", enabled: true }, "sofia-to-audit-token")).toBe(true);
    expect(shouldStartDurableOutbox({ ...jetStream, enabled: false }, undefined)).toBe(false);
  });

  it("starts runtime, dispatcher, and JetStream consumer shutdown concurrently", async () => {
    let releaseRuntime!: () => void;
    let releaseDispatcher!: () => void;
    let releaseConsumer!: () => void;
    const runtimePending = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const dispatcherPending = new Promise<void>((resolve) => {
      releaseDispatcher = resolve;
    });
    const consumerPending = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const runtime = { stop: vi.fn(() => runtimePending) };
    const dispatcher = { stop: vi.fn(() => dispatcherPending) };
    const consumer = { stop: vi.fn(() => consumerPending) };

    let stopped = false;
    const stopping = stopSofiaComponents({ runtime, dispatcher, consumers: [consumer] }).then(() => {
      stopped = true;
    });
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(dispatcher.stop).toHaveBeenCalledOnce();
    expect(consumer.stop).toHaveBeenCalledOnce();

    releaseRuntime();
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseDispatcher();
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseConsumer();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("waits for every shutdown operation before reporting a sanitized failure", async () => {
    let releaseDispatcher!: () => void;
    let releaseConsumer!: () => void;
    const dispatcherPending = new Promise<void>((resolve) => {
      releaseDispatcher = resolve;
    });
    const consumerPending = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    const runtime = { stop: vi.fn(async () => Promise.reject(new Error("private runtime detail"))) };
    const dispatcher = { stop: vi.fn(() => dispatcherPending) };
    const consumer = { stop: vi.fn(() => consumerPending) };

    let settled = false;
    const stopping = stopSofiaComponents({ runtime, dispatcher, consumers: [consumer] }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseDispatcher();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseConsumer();
    await expect(stopping).rejects.toThrow("sofia_shutdown_error");
    expect(settled).toBe(true);
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
