import { describe, expect, it } from "vitest";
import { readPlatformMigratorDatabaseUrl } from "./config.js";

describe("platform migration configuration", () => {
  it("requires a platform-owned migrator URL and never falls back to the global URL", () => {
    expect(
      readPlatformMigratorDatabaseUrl({ PLATFORM_MIGRATOR_DATABASE_URL: "postgresql://admin:secret@db/platform" })
    ).toBe("postgresql://admin:secret@db/platform");
    expect(() => readPlatformMigratorDatabaseUrl({ DATABASE_URL: "postgresql://admin:secret@db/global" })).toThrow(
      "PLATFORM_MIGRATOR_DATABASE_URL is required"
    );
  });
});
