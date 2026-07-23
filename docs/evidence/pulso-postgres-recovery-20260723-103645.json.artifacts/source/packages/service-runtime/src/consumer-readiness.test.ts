import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const servicesDirectory = fileURLToPath(new URL("../../../services/", import.meta.url));
const READINESS_REQUIREMENTS = [
  "requiredMigrationLedger:",
  "requiredLegacyMigrationNames:",
  "requiredSchemaVersion:"
] as const;
const RETIRED_GENERIC_MIGRATION_OPTION = ["required", "Migrations:"].join("");
const PULSO_RUNTIME_SERVICES = new Set([
  "integration-service",
  "knowledge-service",
  "pulso-iris-service",
  "whatsapp-channel-service"
]);
const SOFIA_RUNTIME_SERVICES = new Set(["agent-service", "prompt-flow-service"]);
const ACCESS_RUNTIME_SERVICES = new Set(["identity-service", "tenant-service"]);

async function serviceEntrypoints(): Promise<Array<{ name: string; source: string }>> {
  const directories = await readdir(servicesDirectory, { withFileTypes: true });
  const entries = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const filename = path.join(servicesDirectory, entry.name, "src", "index.ts");
        try {
          return { name: entry.name, source: await readFile(filename, "utf8") };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      })
  );
  return entries.filter((entry): entry is { name: string; source: string } => entry !== undefined);
}

describe("service-runtime production consumers", () => {
  it("does not expose the retired generic migration readiness option", async () => {
    for (const entry of await serviceEntrypoints()) {
      expect(entry.source, entry.name).not.toContain(RETIRED_GENERIC_MIGRATION_OPTION);
    }
  });

  it("requires every database-backed generic runtime entrypoint to declare its schema authority", async () => {
    for (const entry of await serviceEntrypoints()) {
      if (
        !entry.source.includes('from "@hyperion/service-runtime"') ||
        !entry.source.includes("databaseRequired: true")
      ) {
        continue;
      }
      const configured = READINESS_REQUIREMENTS.filter((requirement) => entry.source.includes(requirement));
      expect(configured, entry.name).toHaveLength(1);
    }
  });

  it("has no runtime consumer left on the legacy global migration gate", async () => {
    const consumers = (await serviceEntrypoints())
      .filter((entry) => entry.source.includes("requiredLegacyMigrationNames:"))
      .map((entry) => entry.name);
    expect(consumers).toEqual([]);
  });

  it("pins Audit readiness to its provider-owned manifest", async () => {
    const audit = (await serviceEntrypoints()).find((entry) => entry.name === "audit-service");
    expect(audit?.source).toContain('from "@hyperion/audit-migrations/schema-manifest"');
    expect(audit?.source).toContain("requiredMigrationLedger: AUDIT_RUNTIME_MIGRATION_REQUIREMENT");
    expect(audit?.source).not.toContain("requiredLegacyMigrationNames:");
  });

  it("pins the SOFIA runtimes to their provider-local readiness marker", async () => {
    for (const entry of await serviceEntrypoints()) {
      if (!SOFIA_RUNTIME_SERVICES.has(entry.name)) continue;
      expect(entry.source, entry.name).toContain('from "@hyperion/pulso-migrations/schema-manifest"');
      expect(entry.source, entry.name).toContain("requiredSchemaVersion: PULSO_RUNTIME_SCHEMA_REQUIREMENTS.sofia");
      expect(entry.source, entry.name).not.toContain("PULSO_CURRENT_SCHEMA_VERSION");
      expect(entry.source, entry.name).not.toContain('schema: "pulso_iris"');
      expect(entry.source, entry.name).not.toContain('serviceName: "pulso"');
    }
  });

  it("keeps the remaining PULSO runtimes on the shared 8..16 compatibility window", async () => {
    for (const entry of await serviceEntrypoints()) {
      if (!PULSO_RUNTIME_SERVICES.has(entry.name)) continue;
      expect(entry.source, entry.name).toContain('from "@hyperion/pulso-migrations/schema-manifest"');
      expect(entry.source, entry.name).toContain("requiredSchemaVersion: PULSO_RUNTIME_SCHEMA_REQUIREMENTS.pulso");
      expect(entry.source, entry.name).not.toContain("PULSO_CURRENT_SCHEMA_VERSION");
    }
  });

  it("pins Access runtimes to the provider manifest instead of duplicating its terminal migration", async () => {
    for (const entry of await serviceEntrypoints()) {
      if (!ACCESS_RUNTIME_SERVICES.has(entry.name)) continue;
      expect(entry.source, entry.name).toContain('from "@hyperion/access-migrations/schema-manifest"');
      expect(entry.source, entry.name).toContain("requiredMigrationLedger: ACCESS_RUNTIME_MIGRATION_REQUIREMENT");
    }
  });

  it("pins LUMEN readiness to the provider manifest", async () => {
    const lumen = (await serviceEntrypoints()).find((entry) => entry.name === "lumen-service");
    expect(lumen?.source).toContain('from "@hyperion/lumen-migrations/schema-manifest"');
    expect(lumen?.source).toContain('schema: "lumen"');
    expect(lumen?.source).toContain('serviceName: "lumen"');
    expect(lumen?.source).toContain("minimumVersion: LUMEN_CURRENT_SCHEMA_VERSION");
  });
});
