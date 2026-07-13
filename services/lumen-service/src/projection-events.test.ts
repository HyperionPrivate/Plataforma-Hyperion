import type { DatabaseClient } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/service-runtime";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createLumenProjectionJetStreamHandler,
  lumenProjectionEventSchema,
  registerLumenProjectionEventRoutes,
  sha256CanonicalJson,
  type LumenProjectionReceiver,
  type LumenProjectionResult
} from "./projection-events.js";

const TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const EVENT = {
  id: "a56e320f-cbce-4e96-b7fc-c79e52970a52",
  type: "access.lumen.tenant-snapshot.v1",
  version: 1,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: TENANT_ID,
  payload: {
    tenantId: TENANT_ID,
    status: "active",
    isDemo: true,
    sourceVersion: 1,
    sourceUpdatedAt: "2026-07-13T14:59:00.000Z"
  }
} as const;

describe("LUMEN projection event contract", () => {
  it("accepts the strict minimal contract and hashes canonical key order", () => {
    expect(lumenProjectionEventSchema.safeParse(EVENT).success).toBe(true);
    expect(sha256CanonicalJson({ b: 2, a: 1 })).toBe(sha256CanonicalJson({ a: 1, b: 2 }));
  });

  it("rejects cross-tenant, unsupported and sensitive fields", () => {
    expect(
      lumenProjectionEventSchema.safeParse({
        ...EVENT,
        tenantId: "7fba9ced-2c1a-4bbd-b2ee-72c379a56143"
      }).success
    ).toBe(false);
    expect(
      lumenProjectionEventSchema.safeParse({ ...EVENT, payload: { ...EVENT.payload, transcript: "forbidden" } }).success
    ).toBe(false);
    expect(lumenProjectionEventSchema.safeParse({ ...EVENT, unexpected: true }).success).toBe(false);
  });

  it("protects the internal endpoint and rejects a strict cross-tenant envelope", async () => {
    const app = Fastify();
    await registerLumenProjectionEventRoutes(app, {
      db: {} as DatabaseClient,
      config: { internalServiceToken: "controlled-token" },
      logger: { error: vi.fn() }
    } as unknown as ServiceContext);
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/internal/v1/events/lumen-projections",
        headers: { authorization: "Bearer wrong-token" },
        payload: EVENT
      });
      expect(unauthorized.statusCode).toBe(401);

      const crossTenant = await app.inject({
        method: "POST",
        url: "/internal/v1/events/lumen-projections",
        headers: { authorization: "Bearer controlled-token" },
        payload: { ...EVENT, tenantId: "7fba9ced-2c1a-4bbd-b2ee-72c379a56143" }
      });
      expect(crossTenant.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("LUMEN projection JetStream handler", () => {
  it.each(["accepted", "duplicate", "stale"] as const)("maps %s to ack", async (status) => {
    await expect(
      createLumenProjectionJetStreamHandler(database(), receiverReturning({ status, projection: "tenant_snapshot" }))(
        EVENT,
        context()
      )
    ).resolves.toEqual({ action: "ack" });
  });

  it("maps source conflicts, frozen snapshots and invalid envelopes to term", async () => {
    await expect(
      createLumenProjectionJetStreamHandler(
        database(),
        receiverReturning({ status: "conflict", projection: "tenant_snapshot", reason: "source_version" })
      )(EVENT, context())
    ).resolves.toEqual({ action: "term" });
    await expect(
      createLumenProjectionJetStreamHandler(
        database(),
        receiverReturning({ status: "frozen", projection: "encounter_reference" })
      )(EVENT, context())
    ).resolves.toEqual({ action: "term" });
    await expect(
      createLumenProjectionJetStreamHandler(
        database(),
        receiverReturning({ status: "accepted", projection: "tenant_snapshot" })
      )({ ...EVENT, payload: { ...EVENT.payload, audioBase64: "forbidden" } }, context())
    ).resolves.toEqual({ action: "term" });
  });

  it("maps a transient database failure to retry", async () => {
    const receiver = vi.fn<LumenProjectionReceiver>(async () =>
      Promise.reject(new Error("temporary database failure"))
    );
    await expect(createLumenProjectionJetStreamHandler(database(), receiver)(EVENT, context())).resolves.toEqual({
      action: "retry"
    });
  });
});

function receiverReturning(result: LumenProjectionResult): LumenProjectionReceiver {
  return vi.fn(async () => result);
}

function database(): DatabaseClient {
  return {} as DatabaseClient;
}

function context() {
  return { subject: `hyperion.events.${EVENT.type}`, deliveryCount: 1 } as const;
}
