import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PulsoSchemaInspection } from "./schema-manifest.js";

const hooks = vi.hoisted(() => ({ inspections: [] as PulsoSchemaInspection[] }));

vi.mock("./schema-manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./schema-manifest.js")>();
  return {
    ...actual,
    assertPulsoMigratorDatabaseSecurity: vi.fn(async () => ({})),
    inspectPulsoSchema: vi.fn(async () => {
      const inspection = hooks.inspections.shift();
      if (!inspection) throw new Error("Missing mocked PULSO schema inspection");
      return inspection;
    })
  };
});

import { computePulsoMigrationChecksum, runPulsoMigrationsWithClient, type PulsoMigrationClient } from "./runner.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const baselineName = "001-pulso-autonomous-baseline.sql";
const rolesName = "002-pulso-runtime-roles.sql";
const sofiaMarkerName = "003-sofia-readiness-marker.sql";
const channelProjectionName = "004-access-channel-tenant-projection.sql";

describe("PULSO migration state recovery", () => {
  beforeEach(() => {
    hooks.inspections.length = 0;
  });

  it("atomically adopts an exact legacy closure and applies the remaining append-only migrations", async () => {
    const checksums = await migrationChecksums();
    hooks.inspections.push(
      inspection("legacy", undefined, undefined, []),
      inspection("legacy", undefined, undefined, []),
      inspection("managed", 4, channelProjectionName, ledger(checksums))
    );
    const client = new RecordingClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory, emptyManifests())).resolves.toEqual({
      applied: [rolesName, sofiaMarkerName, channelProjectionName],
      adopted: [baselineName],
      skipped: [baselineName]
    });
    expect(client.sql.filter((sql) => sql === "begin")).toHaveLength(4);
    expect(client.sql.some((sql) => sql.includes("insert into pulso_iris.migration_ledger"))).toBe(true);
  });

  it("resumes after a crash committed the baseline ledger but not later migrations", async () => {
    const checksums = await migrationChecksums();
    hooks.inspections.push(
      inspection("managed", 1, baselineName, [{ name: baselineName, checksum: checksums.get(baselineName)! }]),
      inspection("managed", 4, channelProjectionName, ledger(checksums))
    );
    const client = new RecordingClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory, emptyManifests())).resolves.toEqual({
      applied: [rolesName, sofiaMarkerName, channelProjectionName],
      adopted: [],
      skipped: [baselineName]
    });
    expect(client.sql.filter((sql) => sql === "begin")).toHaveLength(3);
  });

  it("accepts a structurally valid managed 002 database and applies 003 then 004", async () => {
    const checksums = await migrationChecksums();
    hooks.inspections.push(
      inspection("managed", 2, rolesName, ledger(checksums, [baselineName, rolesName])),
      inspection("managed", 4, channelProjectionName, ledger(checksums))
    );
    const client = new RecordingClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory, emptyManifests())).resolves.toEqual({
      applied: [sofiaMarkerName, channelProjectionName],
      adopted: [],
      skipped: [baselineName, rolesName]
    });
    expect(client.sql.filter((sql) => sql === "begin")).toHaveLength(2);
  });

  it("upgrades an exact managed 003 database only with the Channel projection", async () => {
    const checksums = await migrationChecksums();
    hooks.inspections.push(
      inspection("managed", 3, sofiaMarkerName, ledger(checksums, [baselineName, rolesName, sofiaMarkerName])),
      inspection("managed", 4, channelProjectionName, ledger(checksums))
    );
    const client = new RecordingClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory, emptyManifests())).resolves.toEqual({
      applied: [channelProjectionName],
      adopted: [],
      skipped: [baselineName, rolesName, sofiaMarkerName]
    });
    expect(client.sql.filter((sql) => sql === "begin")).toHaveLength(1);
  });
});

class RecordingClient implements PulsoMigrationClient {
  readonly sql: string[] = [];
  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
    this.sql.push(sql.replace(/\s+/g, " ").trim().toLowerCase());
    return { rows: [] };
  }
}

async function migrationChecksums(): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      [baselineName, rolesName, sofiaMarkerName, channelProjectionName].map(
        async (name) =>
          [
            name,
            computePulsoMigrationChecksum(await readFile(new URL(`../sql/${name}`, import.meta.url), "utf8"))
          ] as const
      )
    )
  );
}

function ledger(
  checksums: Map<string, string>,
  names: readonly string[] = [baselineName, rolesName, sofiaMarkerName, channelProjectionName]
) {
  return names.map((name) => ({ name, checksum: checksums.get(name)! }));
}

function inspection(
  state: PulsoSchemaInspection["state"],
  currentVersion: number | undefined,
  migrationName: string | undefined,
  ledgerEntries: PulsoSchemaInspection["ledgerEntries"]
): PulsoSchemaInspection {
  return {
    state,
    issues: [],
    catalog: [],
    categorySummaries: {},
    currentVersion,
    migrationName,
    ledgerEntries
  };
}

function emptyManifests() {
  const empty = {
    extension: { count: 0, fingerprint: "" },
    table: { count: 0, fingerprint: "" },
    column: { count: 0, fingerprint: "" },
    function: { count: 0, fingerprint: "" },
    trigger: { count: 0, fingerprint: "" },
    index: { count: 0, fingerprint: "" },
    constraint: { count: 0, fingerprint: "" },
    other_relation: { count: 0, fingerprint: "" }
  };
  return { legacy: empty, managed: empty, managedByVersion: { 2: empty, 3: empty, 4: empty } };
}
