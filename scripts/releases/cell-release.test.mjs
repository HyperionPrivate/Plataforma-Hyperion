import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectProviderArtifactCatalog } from "./check-provider-artifact-catalog.mjs";
import {
  compareSemver,
  PROVIDER_CONTRACTS,
  readVersionedSnapshots,
  requireLatestSnapshot
} from "./provider-contract-compatibility.mjs";
import { loadRollbackPolicy, ROLLBACK_CELLS, verifyProviderMigrationManifest } from "./rollback-policy.mjs";
import { RELEASE_CELLS } from "./release-model.mjs";
import { assertReleaseCell, providerContractIdsForCell } from "./release-scope.mjs";
import { validateRepositoryReleases } from "./validate-release-manifests.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const requestedCell = process.env.HYPERION_RELEASE_TEST_CELL
  ? assertReleaseCell(process.env.HYPERION_RELEASE_TEST_CELL)
  : null;
const cells = requestedCell ? [requestedCell] : [...RELEASE_CELLS];
const expectedCounts = Object.freeze({
  platform: { catalogs: 5, manifests: 5, rollback: 0 },
  nova: { catalogs: 2, manifests: 2, rollback: 1 },
  lumen: { catalogs: 2, manifests: 2, rollback: 1 },
  pulso: { catalogs: 5, manifests: 5, rollback: 1 }
});

for (const cell of cells) {
  test(`${cell}: validates only its release catalogs, manifests and rollback inventory`, async () => {
    const result = await validateRepositoryReleases(repositoryRoot, { cell });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.cells, [cell]);
    assert.equal(result.catalogCount, expectedCounts[cell].catalogs);
    assert.equal(result.manifestCount, expectedCounts[cell].manifests);
    assert.equal(result.rollbackPolicyCount, expectedCounts[cell].rollback);

    const catalog = await latestCatalog(cell);
    if (ROLLBACK_CELLS.includes(cell)) {
      const loaded = await loadRollbackPolicy(catalog, repositoryRoot);
      const migration = await verifyProviderMigrationManifest(loaded.policy, repositoryRoot);
      assert.ok(migration.count > 0);
      assert.match(migration.sha256, /^[a-f0-9]{64}$/);
    } else {
      assert.equal(catalog.rollbackPolicy, undefined);
      assert.equal(catalog.rollbackPolicySha256, undefined);
    }
  });

  test(`${cell}: validates only its provider artifact catalog ownership`, async () => {
    const result = await inspectProviderArtifactCatalog({ cell });
    assert.deepEqual(result.errors, []);
    assert.equal(result.summary.cell, cell);
    assert.equal(result.summary.providerContracts, providerContractIdsForCell(cell).length);
    if (cell !== "nova") {
      assert.equal(result.summary.novaSourcePackages, 0);
      assert.deepEqual(result.summary.novaExternalArtifacts, []);
    }
  });

  test(`${cell}: owns an immutable older N-1 snapshot for each selected contract`, async () => {
    const ids = providerContractIdsForCell(cell);
    assert.ok(ids.length > 0);
    assert.ok(ids.every((id) => PROVIDER_CONTRACTS[id].cell === cell));
    for (const id of ids) {
      const provider = PROVIDER_CONTRACTS[id];
      const manifest = JSON.parse(
        await readFile(path.join(repositoryRoot, provider.directory, "package.json"), "utf8")
      );
      const snapshots = await readVersionedSnapshots(
        path.join(repositoryRoot, "fixtures", "contracts", "provider-owned"),
        id,
        provider.packageName
      );
      const previous = requireLatestSnapshot(snapshots, id, manifest.version);
      assert.equal(compareSemver(previous.version, manifest.version), -1);
    }
  });
}

async function latestCatalog(cell) {
  const directory = path.join(repositoryRoot, "releases", "catalogs", cell);
  const versions = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .sort(compareSemver);
  return JSON.parse(await readFile(path.join(directory, `${versions.at(-1)}.json`), "utf8"));
}
