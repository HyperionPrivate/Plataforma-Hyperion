import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import {
  readIntegrationTenantSnapshot,
  requireIntegrationTenantAccess,
  type IntegrationTenantSnapshotStatus
} from "./access-tenant-projections.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";

describe("readIntegrationTenantSnapshot", () => {
  it("returns null when the local projection is missing", async () => {
    const db = database(vi.fn(async () => ({ rows: [], rowCount: 0 })));
    await expect(readIntegrationTenantSnapshot(db, TENANT_ID)).resolves.toBeNull();
  });

  it("returns status and source version from tenant_snapshots", async () => {
    const db = database(
      vi.fn(async () => ({
        rows: [{ status: "active", sourceVersion: "12" }],
        rowCount: 1
      }))
    );
    await expect(readIntegrationTenantSnapshot(db, TENANT_ID)).resolves.toEqual({
      status: "active",
      sourceVersion: 12
    });
  });
});

describe("requireIntegrationTenantAccess", () => {
  it("returns 503 when the database is unavailable", async () => {
    const reply = captureReply();
    await expect(
      requireIntegrationTenantAccess(undefined, TENANT_ID, reply, "req-1", "exists")
    ).resolves.toBeUndefined();
    expect(reply.statusCode).toBe(503);
    expect(reply.payload).toMatchObject({ data: { error: "DATABASE_URL is required" } });
  });

  it("returns 404 when the snapshot is missing", async () => {
    const reply = captureReply();
    const db = database(vi.fn(async () => ({ rows: [], rowCount: 0 })));
    await expect(requireIntegrationTenantAccess(db, TENANT_ID, reply, "req-2", "exists")).resolves.toBeUndefined();
    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toMatchObject({
      data: { error: "Tenant snapshot not found; bootstrap required" }
    });
  });

  it("allows reads for paused and archived tenants", async () => {
    for (const status of ["paused", "archived"] as const) {
      const reply = captureReply();
      const db = snapshotDb(status);
      await expect(requireIntegrationTenantAccess(db, TENANT_ID, reply, "req-read", "exists")).resolves.toEqual({
        status,
        sourceVersion: 3
      });
      expect(reply.statusCode).toBeUndefined();
    }
  });

  it("rejects mutations when the tenant is paused or archived", async () => {
    for (const status of ["paused", "archived"] as const) {
      const reply = captureReply();
      const db = snapshotDb(status);
      await expect(requireIntegrationTenantAccess(db, TENANT_ID, reply, "req-mut", "active")).resolves.toBeUndefined();
      expect(reply.statusCode).toBe(403);
      expect(reply.payload).toMatchObject({
        data: {
          error: "Tenant is not active for integration operations",
          status
        }
      });
    }
  });

  it("allows mutations when the tenant is active", async () => {
    const reply = captureReply();
    const db = snapshotDb("active");
    await expect(requireIntegrationTenantAccess(db, TENANT_ID, reply, "req-ok", "active")).resolves.toEqual({
      status: "active",
      sourceVersion: 3
    });
    expect(reply.statusCode).toBeUndefined();
  });
});

function snapshotDb(status: IntegrationTenantSnapshotStatus): DatabaseClient {
  return database(
    vi.fn(async () => ({
      rows: [{ status, sourceVersion: "3" }],
      rowCount: 1
    }))
  );
}

function database(query: ReturnType<typeof vi.fn>): DatabaseClient {
  return { query } as unknown as DatabaseClient;
}

function captureReply(): {
  statusCode: number | undefined;
  payload: unknown;
  code(statusCode: number): { send(payload: unknown): unknown };
} {
  const state: { statusCode: number | undefined; payload: unknown } = {
    statusCode: undefined,
    payload: undefined
  };
  return {
    get statusCode() {
      return state.statusCode;
    },
    get payload() {
      return state.payload;
    },
    code(statusCode: number) {
      state.statusCode = statusCode;
      return {
        send(payload: unknown) {
          state.payload = payload;
          return payload;
        }
      };
    }
  };
}
