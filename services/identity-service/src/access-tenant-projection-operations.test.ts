import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_TENANT_PROJECTION_REPLAY_CONFIRMATION,
  ACCESS_TENANT_PROJECTION_REDRIVE_CONFIRMATION,
  parseAccessTenantProjectionOperation,
  runAccessTenantProjectionOperation
} from "./access-tenant-projection-operations.js";

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

describe("Access tenant projection operations", () => {
  it("parses only bounded reconciliation and exact confirmed redrive", () => {
    expect(parseAccessTenantProjectionOperation(["reconcile", "--limit", "25"])).toEqual({
      command: "reconcile",
      limit: 25
    });
    expect(
      parseAccessTenantProjectionOperation([
        "redrive",
        "--event-id",
        EVENT_ID,
        "--tenant-id",
        TENANT_ID,
        "--confirm",
        ACCESS_TENANT_PROJECTION_REDRIVE_CONFIRMATION
      ])
    ).toEqual({
      command: "redrive",
      eventId: EVENT_ID,
      tenantId: TENANT_ID,
      confirmation: ACCESS_TENANT_PROJECTION_REDRIVE_CONFIRMATION
    });
    expect(() =>
      parseAccessTenantProjectionOperation([
        "redrive",
        "--event-id",
        EVENT_ID,
        "--tenant-id",
        TENANT_ID,
        "--confirm",
        "yes"
      ])
    ).toThrow("--confirm must equal");
    expect(() => parseAccessTenantProjectionOperation(["reconcile", "--limit", "1001"])).toThrow("between 1 and 1000");
    expect(
      parseAccessTenantProjectionOperation([
        "replay",
        "--tenant-id",
        TENANT_ID,
        "--confirm",
        ACCESS_TENANT_PROJECTION_REPLAY_CONFIRMATION
      ])
    ).toEqual({
      command: "replay",
      tenantId: TENANT_ID,
      confirmation: ACCESS_TENANT_PROJECTION_REPLAY_CONFIRMATION
    });
    expect(() =>
      parseAccessTenantProjectionOperation([
        "replay",
        "--tenant-id",
        TENANT_ID,
        "--confirm",
        ACCESS_TENANT_PROJECTION_REDRIVE_CONFIRMATION
      ])
    ).toThrow("--confirm must equal REPLAY ACCESS TENANT SNAPSHOT");
  });

  it("validates the Access runtime boundary and always closes the database", async () => {
    const close = vi.fn(async () => undefined);
    const assertRuntimeBoundary = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ rows: [] }));
    const createDatabase = vi.fn(() => ({ query, close }) as never);

    await expect(
      runAccessTenantProjectionOperation(
        { command: "reconcile", limit: 1 },
        { DATABASE_URL: "postgres://identity:secret@db/access" },
        { createDatabase, assertRuntimeBoundary }
      )
    ).resolves.toEqual({
      command: "reconcile",
      candidatesProcessed: 0,
      eventsEnqueued: 0,
      hasMore: false
    });
    expect(assertRuntimeBoundary).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    assertRuntimeBoundary.mockRejectedValueOnce(new Error("wrong database boundary"));
    await expect(
      runAccessTenantProjectionOperation(
        { command: "reconcile", limit: 1 },
        { DATABASE_URL: "postgres://identity:secret@db/access" },
        { createDatabase, assertRuntimeBoundary }
      )
    ).rejects.toThrow("wrong database boundary");
    expect(close).toHaveBeenCalledTimes(2);
  });
});
