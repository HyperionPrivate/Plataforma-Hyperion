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

import { createSkipAccessFkContractGate } from "./access-fk-contract-gate.js";
import { computePulsoMigrationChecksum, runPulsoMigrationsWithClient, type PulsoMigrationClient } from "./runner.js";

const recordingRunnerOptions = () => ({
  manifests: emptyManifests(),
  accessFkContractGate: createSkipAccessFkContractGate()
});

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const baselineName = "001-pulso-autonomous-baseline.sql";
const rolesName = "002-pulso-runtime-roles.sql";
const sofiaMarkerName = "003-sofia-readiness-marker.sql";
const channelProjectionName = "004-access-channel-tenant-projection.sql";
const irisProjectionName = "005-access-iris-tenant-projection.sql";
const sofiaProjectionName = "006-access-sofia-tenant-projection.sql";
const integrationProjectionName = "007-access-integration-tenant-projection.sql";
const knowledgeProjectionName = "008-access-knowledge-tenant-projection.sql";
const channelContractName = "009-contract-channel-access-tenant-fks.sql";
const integrationContractName = "010-contract-integration-access-tenant-fks.sql";
const sofiaContractName = "011-contract-sofia-access-tenant-fks.sql";
const irisContractName = "012-contract-iris-access-tenant-fks.sql";
const knowledgeContractName = "013-contract-knowledge-access-tenant-fks.sql";
const nMinusOneDropName = "014-drop-n-minus-one-legacy-adapters.sql";
const sofiaGrantRevokeName = "015-revoke-sofia-pulso-iris-control-plane-grants.sql";
const accessFkAttestationName = "016-attest-access-fk-contract.sql";
const TIP_NAMES = [
  baselineName,
  rolesName,
  sofiaMarkerName,
  channelProjectionName,
  irisProjectionName,
  sofiaProjectionName,
  integrationProjectionName,
  knowledgeProjectionName,
  channelContractName,
  integrationContractName,
  sofiaContractName,
  irisContractName,
  knowledgeContractName,
  nMinusOneDropName,
  sofiaGrantRevokeName,
  accessFkAttestationName
] as const;

describe("PULSO migration state recovery", () => {
  beforeEach(() => {
    hooks.inspections.length = 0;
  });

  it("atomically adopts an exact legacy closure and applies the remaining append-only migrations", async () => {
    const checksums = await migrationChecksums();
    hooks.inspections.push(
      inspection("legacy", undefined, undefined, []),
      inspection("legacy", undefined, undefined, []),
      inspection("managed", 16, accessFkAttestationName, ledger(checksums))
    );
    const client = new RecordingClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory, recordingRunnerOptions())).resolves.toEqual({
      applied: TIP_NAMES.slice(1) as unknown as string[],
      adopted: [baselineName],
      skipped: [baselineName]
    });
    expect(client.sql.filter((sql) => sql === "begin")).toHaveLength(16);
    expect(client.sql.some((sql) => sql.includes("insert into pulso_iris.migration_ledger"))).toBe(true);
  });

  it("resumes after a crash committed the baseline ledger but not later migrations", async () => {
    const checksums = await migrationChecksums();
    hooks.inspections.push(
      inspection("managed", 1, baselineName, [{ name: baselineName, checksum: checksums.get(baselineName)! }]),
      inspection("managed", 16, accessFkAttestationName, ledger(checksums))
    );
    const client = new RecordingClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory, recordingRunnerOptions())).resolves.toEqual({
      applied: TIP_NAMES.slice(1) as unknown as string[],
      adopted: [],
      skipped: [baselineName]
    });
    expect(client.sql.filter((sql) => sql === "begin")).toHaveLength(15);
  });

  it("accepts a structurally valid managed 002 database and applies 003 through 016", async () => {
    const checksums = await migrationChecksums();
    hooks.inspections.push(
      inspection("managed", 2, rolesName, ledger(checksums, [baselineName, rolesName])),
      inspection("managed", 16, accessFkAttestationName, ledger(checksums))
    );
    const client = new RecordingClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory, recordingRunnerOptions())).resolves.toEqual({
      applied: TIP_NAMES.slice(2) as unknown as string[],
      adopted: [],
      skipped: [baselineName, rolesName]
    });
    expect(client.sql.filter((sql) => sql === "begin")).toHaveLength(14);
  });

  it("upgrades an exact managed 003 database with Channel, Iris, SOFIA, Integration and Knowledge projections", async () => {
    const checksums = await migrationChecksums();
    hooks.inspections.push(
      inspection("managed", 3, sofiaMarkerName, ledger(checksums, [baselineName, rolesName, sofiaMarkerName])),
      inspection("managed", 16, accessFkAttestationName, ledger(checksums))
    );
    const client = new RecordingClient();

    await expect(runPulsoMigrationsWithClient(client, sqlDirectory, recordingRunnerOptions())).resolves.toEqual({
      applied: TIP_NAMES.slice(3) as unknown as string[],
      adopted: [],
      skipped: [baselineName, rolesName, sofiaMarkerName]
    });
    expect(client.sql.filter((sql) => sql === "begin")).toHaveLength(13);
  });
});

class RecordingClient implements PulsoMigrationClient {
  readonly sql: string[] = [];
  private attestation?: Record<string, unknown>;
  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    this.sql.push(normalized);
    if (normalized.startsWith("insert into pulso_iris.access_fk_contract_attestations")) {
      this.attestation = {
        receipt_sha256: values?.[0],
        attestation_mode: "greenfield",
        migration_set_sha256: values?.[1],
        target_schema_version: values?.[3],
        target_migration: values?.[4],
        receipt: JSON.parse(String(values?.[5]))
      };
    }
    if (normalized.includes("from pulso_iris.access_fk_contract_attestations")) {
      return { rows: (this.attestation ? [this.attestation] : []) as T[] };
    }
    if (normalized.includes("with referenced as")) {
      return { rows: [{ referenced: 0, missing: 0 }] as T[] };
    }
    if (normalized.includes("tenant_snapshots") && normalized.includes("count(*)")) {
      return { rows: [{ count: 0 }] as T[] };
    }
    if (normalized.includes("source.product_id")) {
      return { rows: [{ referenced: 0, missing: 0 }] as T[] };
    }
    return { rows: [] };
  }
}

async function migrationChecksums(): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      TIP_NAMES.map(
        async (name) =>
          [
            name,
            computePulsoMigrationChecksum(await readFile(new URL(`../sql/${name}`, import.meta.url), "utf8"))
          ] as const
      )
    )
  );
}

function ledger(checksums: Map<string, string>, names: readonly string[] = [...TIP_NAMES]) {
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
  return {
    legacy: empty,
    managed: empty,
    managedByVersion: { 2: empty, 3: empty, 4: empty, 5: empty, 6: empty, 7: empty, 8: empty }
  };
}
