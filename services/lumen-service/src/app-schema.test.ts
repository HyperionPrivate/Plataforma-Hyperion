import type { ServiceContext } from "@hyperion/service-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const assertLumenRuntimeDatabaseBoundary = vi.hoisted(() => vi.fn());

vi.mock("@hyperion/lumen-migrations/schema-manifest", () => ({
  assertLumenRuntimeDatabaseBoundary,
  LUMEN_CURRENT_MIGRATION: "002-lumen-runtime-role.sql",
  LUMEN_CURRENT_SCHEMA_VERSION: 40
}));

import { verifyLumenSchema } from "./app.js";

describe("LUMEN provider-owned runtime schema verification", () => {
  beforeEach(() => {
    assertLumenRuntimeDatabaseBoundary.mockReset();
  });

  it("accepts only the exact managed v40 manifest through the runtime boundary inspection", async () => {
    assertLumenRuntimeDatabaseBoundary.mockResolvedValue({
      schema: {
        state: "managed",
        currentVersion: 40,
        migrationName: "002-lumen-runtime-role.sql",
        issues: []
      },
      security: { issues: [] }
    });
    const context = contextWithDatabase();

    await expect(verifyLumenSchema(context)).resolves.toBeUndefined();

    expect(assertLumenRuntimeDatabaseBoundary).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.any(Function) })
    );
  });

  it("propagates role, membership and ACL drift before serving traffic", async () => {
    const drift = new Error("LUMEN runtime security assertion failed: runtime role has an elevated capability");
    assertLumenRuntimeDatabaseBoundary.mockImplementation(async () => {
      throw drift;
    });

    let caught: unknown;
    try {
      await verifyLumenSchema(contextWithDatabase());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(drift);
  });

  it("rejects a structurally incompatible catalog and preserves the manifest reason", async () => {
    assertLumenRuntimeDatabaseBoundary.mockResolvedValue({
      schema: {
        state: "incompatible",
        currentVersion: 40,
        migrationName: "002-lumen-runtime-role.sql",
        issues: ["function structural fingerprint mismatch"]
      },
      security: { issues: [] }
    });

    await expect(verifyLumenSchema(contextWithDatabase())).rejects.toThrow(
      "LUMEN runtime schema integrity verification failed: function structural fingerprint mismatch"
    );
  });

  it.each([
    { currentVersion: 39, migrationName: "001-lumen-autonomous-baseline.sql" },
    { currentVersion: 40, migrationName: "unexpected.sql" }
  ])(
    "rejects a catalog outside the exact current provider migration ($currentVersion/$migrationName)",
    async (state) => {
      assertLumenRuntimeDatabaseBoundary.mockResolvedValue({
        schema: { state: "managed", ...state, issues: [] },
        security: { issues: [] }
      });

      await expect(verifyLumenSchema(contextWithDatabase())).rejects.toThrow(
        "LUMEN runtime schema integrity verification failed"
      );
    }
  );
});

function contextWithDatabase(): ServiceContext {
  return { db: { query: vi.fn() } } as unknown as ServiceContext;
}
