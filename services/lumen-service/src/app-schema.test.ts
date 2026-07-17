import type { ServiceContext } from "@hyperion/service-runtime";
import { describe, expect, it, vi } from "vitest";
import { verifyLumenSchema } from "./app.js";

describe("LUMEN local schema verification", () => {
  it("accepts local schema version 39 without consulting platform migrations", async () => {
    const query = vi.fn(async (_text: string) => ({
      rows: [{ encounters: "lumen.encounters", records: "lumen.clinical_records", currentVersion: 39 }]
    }));
    await expect(verifyLumenSchema(contextWithQuery(query))).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toContain("lumen.schema_version");
    expect(query.mock.calls[0]![0]).not.toContain("platform.schema_migrations");
  });

  it.each([38, null])("rejects an incomplete local schema version %s", async (currentVersion) => {
    const query = vi.fn(async (_text: string) => ({
      rows: [{ encounters: "lumen.encounters", records: "lumen.clinical_records", currentVersion }]
    }));
    await expect(verifyLumenSchema(contextWithQuery(query))).rejects.toThrow("LUMEN schema is incomplete");
  });
});

function contextWithQuery(query: ReturnType<typeof vi.fn>): ServiceContext {
  return { db: { query } } as unknown as ServiceContext;
}
