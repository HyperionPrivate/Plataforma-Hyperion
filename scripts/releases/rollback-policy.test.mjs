import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ROLLBACK_CELLS,
  loadRollbackPolicy,
  rollbackComponentPartitions,
  rollbackPolicyPath,
  validateRollbackPolicy,
  verifyProviderMigrationManifest
} from "./rollback-policy.mjs";
import { compareSemver } from "./release-model.mjs";
import { validateRepositoryReleases } from "./validate-release-manifests.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
test("validates the provider-owned rollback policy and migration manifest for every product cell", async () => {
  for (const cell of ROLLBACK_CELLS) {
    const { catalog, policy } = await readPolicyFixture(cell);
    assert.equal(catalog.rollbackPolicy, rollbackPolicyPath(cell, catalog.catalogVersion));
    const policyBytes = await readFile(path.join(repositoryRoot, catalog.rollbackPolicy));
    assert.equal(catalog.rollbackPolicySha256, createHash("sha256").update(policyBytes).digest("hex"));
    assert.deepEqual(validateRollbackPolicy(policy, catalog), []);
    const migrationEvidence = await verifyProviderMigrationManifest(policy, repositoryRoot);
    assert.equal(migrationEvidence.count, policy.migration.files.length);
    assert.match(migrationEvidence.sha256, /^[a-f0-9]{64}$/);
    const partitions = rollbackComponentPartitions(policy, catalog);
    assert.deepEqual(partitions.forwardOnlyOciComponents, [`${cell}-migrations`]);
    assert.equal(partitions.rollbackOciComponents.includes(`${cell}-migrations`), false);
  }
});

test("normalizes the sealed legacy PULSO policy without treating its migrator as rollbackable", async () => {
  const catalog = JSON.parse(await readFile(path.join(repositoryRoot, "releases/catalogs/pulso/1.1.0.json"), "utf8"));
  const policy = JSON.parse(
    await readFile(path.join(repositoryRoot, "releases/rollback-policies/pulso/1.1.0.json"), "utf8")
  );
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.ociComponents.includes("pulso-migrations"), true);
  const partitions = rollbackComponentPartitions(policy, catalog);
  assert.deepEqual(partitions.forwardOnlyOciComponents, ["pulso-migrations"]);
  assert.equal(partitions.rollbackOciComponents.includes("pulso-migrations"), false);
});

test("requires explicit rollback and forward-only partitions in the current PULSO policy", async () => {
  const { catalog, policy } = await readPolicyFixture("pulso");
  assert.equal(policy.schemaVersion, 2);
  assert.deepEqual(policy.forwardOnlyOciComponents, ["pulso-migrations"]);
  assert.equal(policy.rollbackOciComponents.includes("pulso-migrations"), false);

  const misplaced = structuredClone(policy);
  misplaced.rollbackOciComponents.push("pulso-migrations");
  assert.match(validateRollbackPolicy(misplaced, catalog).join("\n"), /rollbackable runtime OCI|disjoint/);
});

test("rejects a rollback policy whose bytes diverge from the catalog digest", async () => {
  const { catalog } = await readPolicyFixture("lumen");
  const drifted = structuredClone(catalog);
  drifted.rollbackPolicySha256 = "f".repeat(64);
  await assert.rejects(loadRollbackPolicy(drifted, repositoryRoot), /does not match the owning release catalog/);
});

test("rejects foreign OCI components and foreign migration ownership in rollback policies", async () => {
  for (const cell of ROLLBACK_CELLS) {
    const { catalog, policy } = await readPolicyFixture(cell);
    const foreignComponents = structuredClone(policy);
    const rollbackKey = policy.schemaVersion === 2 ? "rollbackOciComponents" : "ociComponents";
    foreignComponents[rollbackKey][0] = "platform-admin-console";
    assert.match(validateRollbackPolicy(foreignComponents, catalog).join("\n"), /exactly match/);

    const foreignMigration = structuredClone(policy);
    foreignMigration.migration.componentId = "audit-migrations";
    foreignMigration.migration.sourcePath = "packages/audit-migrations";
    const errors = validateRollbackPolicy(foreignMigration, catalog).join("\n");
    assert.match(errors, new RegExp(`componentId must be ${cell}-migrations`));
    assert.match(errors, new RegExp(`sourcePath must be packages/${cell}-migrations`));
  }
});

test("rejects incomplete, reordered, duplicate and mutable migration manifests", async () => {
  const { catalog, policy } = await readPolicyFixture("nova");
  const missing = structuredClone(policy);
  missing.migration.files.pop();
  await assert.rejects(
    verifyProviderMigrationManifest(missing, repositoryRoot),
    /migration inventory differs from the rollback policy/
  );

  const reordered = structuredClone(policy);
  reordered.migration.files.reverse();
  assert.match(validateRollbackPolicy(reordered, catalog).join("\n"), /must be sorted by path/);

  const duplicate = structuredClone(policy);
  duplicate.migration.files.push(structuredClone(duplicate.migration.files.at(-1)));
  assert.match(validateRollbackPolicy(duplicate, catalog).join("\n"), /duplicate path/);

  const mutable = structuredClone(policy);
  mutable.migration.files[0].sha256 = "0".repeat(64);
  assert.match(validateRollbackPolicy(mutable, catalog).join("\n"), /non-zero lowercase SHA-256/);
});

test("release validation gates the three rollback policies and their checked-in migration bytes", async () => {
  const result = await validateRepositoryReleases(repositoryRoot);
  assert.equal(result.rollbackPolicyCount, 3);
  assert.deepEqual(
    result.errors.filter((error) => /(?:nova|lumen|pulso).*rollback policy/i.test(error)),
    []
  );
});

test("keeps the rollback policy JSON schema closed", async () => {
  const schema = JSON.parse(
    await readFile(path.join(repositoryRoot, "releases", "schemas", "rollback-policy.schema.json"), "utf8")
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.schemaVersion.enum, [1, 2]);
  assert.ok(schema.properties.rollbackOciComponents);
  assert.ok(schema.properties.forwardOnlyOciComponents);
  assert.equal(schema.oneOf.length, 2);
  assert.equal(schema.properties.migration.additionalProperties, false);
  assert.equal(schema.properties.migration.properties.files.items.additionalProperties, false);
});

test("wires each product rollback verifier into npm, scoped recovery tests and cell CI", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const dispatcher = await readFile(
    path.join(repositoryRoot, "scripts", "ops", "run-postgres-backup-tests.mjs"),
    "utf8"
  );
  for (const cell of ROLLBACK_CELLS) {
    assert.equal(packageJson.scripts[`ops:${cell}:rollback:verify`], `node scripts/ops/verify-${cell}-rollback.mjs`);
    assert.equal(
      packageJson.scripts[`ops:${cell}:rollback:test`],
      `node --test scripts/ops/verify-${cell}-rollback.test.mjs`
    );
    assert.match(dispatcher, new RegExp(`scripts/ops/verify-${cell}-rollback\\.test\\.mjs`));
  }
  assert.equal(packageJson.scripts["release:test"], "node scripts/releases/run-release-tests.mjs");
  const releaseTestRunner = await readFile(
    path.join(repositoryRoot, "scripts", "releases", "run-release-tests.mjs"),
    "utf8"
  );
  assert.match(releaseTestRunner, /scripts\/releases\/rollback-policy\.test\.mjs/);
  const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "_cell-ci.yml"), "utf8");
  assert.match(workflow, /if: inputs\.cell != 'platform'/);
  assert.match(workflow, /pnpm backup:test --cell "\$\{\{ inputs\.cell \}\}"/);
});

async function readPolicyFixture(cell) {
  const catalogDirectory = path.join(repositoryRoot, "releases", "catalogs", cell);
  const version = (await readdir(catalogDirectory))
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -5))
    .sort(compareSemver)
    .at(-1);
  const catalog = JSON.parse(
    await readFile(path.join(repositoryRoot, "releases", "catalogs", cell, `${version}.json`), "utf8")
  );
  const policy = JSON.parse(
    await readFile(path.join(repositoryRoot, "releases", "rollback-policies", cell, `${version}.json`), "utf8")
  );
  return { catalog, policy };
}
