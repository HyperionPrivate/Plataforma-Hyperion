import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import {
  LUMEN_PROJECTION_CONSUMERS,
  startLumenProjectionJetStreamConsumers,
  type ManagedJetStreamConsumerFactory
} from "./projection-jetstream.js";

describe("LUMEN projection JetStream lifecycle", () => {
  it("starts three fixed durable consumers and stops all through the close hook", async () => {
    const starts = LUMEN_PROJECTION_CONSUMERS.map(() => vi.fn());
    const stops = LUMEN_PROJECTION_CONSUMERS.map(() => vi.fn(async () => undefined));
    const initializers = LUMEN_PROJECTION_CONSUMERS.map(() => vi.fn(async () => undefined));
    const readinessChecks = LUMEN_PROJECTION_CONSUMERS.map(() => vi.fn(async () => undefined));
    let created = 0;
    let closeHook: (() => Promise<void>) | undefined;
    const factory = vi.fn<ManagedJetStreamConsumerFactory>(() => {
      const index = created++;
      return {
        initialize: initializers[index]!,
        checkReadiness: readinessChecks[index]!,
        start: starts[index]!,
        stop: stops[index]!
      };
    });

    const consumers = await startLumenProjectionJetStreamConsumers(
      (hook) => {
        closeHook = hook;
      },
      {} as DatabaseClient,
      { natsUrl: "nats://nats:4222", authToken: "controlled-token" },
      factory
    );

    expect(consumers).toHaveLength(3);
    expect(factory).toHaveBeenCalledTimes(3);
    for (const [index, definition] of LUMEN_PROJECTION_CONSUMERS.entries()) {
      expect(initializers[index]).toHaveBeenCalledTimes(1);
      expect(starts[index]).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          ...definition,
          servers: "nats://nats:4222",
          authToken: "controlled-token",
          provisionTopology: false,
          handler: expect.any(Function)
        })
      );
    }

    await closeHook?.();
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });
});
