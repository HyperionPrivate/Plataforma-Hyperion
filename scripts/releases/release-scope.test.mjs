import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectProviderArtifactCatalog, providerArtifactCell } from "./check-provider-artifact-catalog.mjs";
import { buildReleaseCheckPlan, runReleaseChecks } from "./run-release-checks.mjs";
import {
  CELL_RELEASE_TEST_FILES,
  GLOBAL_RELEASE_TEST_FILES,
  buildReleaseTestPlan,
  runReleaseTests
} from "./run-release-tests.mjs";
import {
  assertReleaseCell,
  parseCellScopeArguments,
  providerContractIdsForCell,
  selectedReleaseCells
} from "./release-scope.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const requestedCell = process.env.HYPERION_RELEASE_TEST_CELL
  ? assertReleaseCell(process.env.HYPERION_RELEASE_TEST_CELL)
  : null;
const cells = requestedCell ? [requestedCell] : ["platform", "nova", "lumen", "pulso"];

test("parses one explicit release cell and rejects ambiguous or unknown scope before execution", () => {
  for (const cell of cells) {
    assert.deepEqual(parseCellScopeArguments(["--cell", cell]), { cell });
    assert.equal(assertReleaseCell(cell), cell);
    assert.deepEqual(selectedReleaseCells(cell), [cell]);
  }
  assert.deepEqual(parseCellScopeArguments([]), { cell: null });
  assert.throws(() => parseCellScopeArguments(["--cell"]), /requires a value/);
  assert.throws(() => parseCellScopeArguments(["--cell", "nova", "--cell", "lumen"]), /only once/);
  assert.throws(() => parseCellScopeArguments(["--cell", "unknown"]), /Unknown release cell/);
  assert.throws(() => parseCellScopeArguments(["--all"]), /Unknown argument/);
});

test("builds an exact cell-scoped check plan for manifests, catalogs, rollback and contracts", () => {
  for (const cell of cells) {
    assert.deepEqual(buildReleaseCheckPlan(cell), [
      { script: "scripts/releases/validate-release-manifests.mjs", arguments: ["--cell", cell] },
      { script: "scripts/releases/check-provider-artifact-catalog.mjs", arguments: ["--cell", cell] },
      { script: "scripts/releases/check-provider-contract-compatibility.mjs", arguments: ["--cell", cell] }
    ]);
  }
  assert.ok(buildReleaseCheckPlan().every((step) => step.arguments.length === 0));
});

test("keeps global tests global and limits cell test plans to focused release ownership tests", () => {
  const global = buildReleaseTestPlan();
  assert.deepEqual(global.files, [...GLOBAL_RELEASE_TEST_FILES]);
  assert.deepEqual(global.environment, {});
  assert.ok(global.files.includes("scripts/releases/release-manifest.test.mjs"));
  assert.ok(global.files.includes("scripts/releases/rollback-policy.test.mjs"));
  assert.ok(global.files.includes("scripts/releases/published-release.test.mjs"));

  for (const cell of cells) {
    const scoped = buildReleaseTestPlan(cell);
    assert.deepEqual(scoped.files, [...CELL_RELEASE_TEST_FILES]);
    assert.deepEqual(scoped.environment, { HYPERION_RELEASE_TEST_CELL: cell });
    assert.ok(!scoped.files.includes("scripts/releases/image-producer.test.mjs"));
    assert.ok(!scoped.files.includes("scripts/releases/published-release.test.mjs"));
  }
});

test("dispatchers stop on the first child failure and preserve the selected test environment", () => {
  const checkCalls = [];
  assert.throws(
    () =>
      runReleaseChecks({ cell: "nova" }, (step) => {
        checkCalls.push(step);
        if (checkCalls.length === 2) throw new Error("catalog failed");
      }),
    /catalog failed/
  );
  assert.equal(checkCalls.length, 2);

  let testPlan;
  runReleaseTests({ cell: "lumen" }, (plan) => {
    testPlan = plan;
  });
  assert.deepEqual(testPlan.environment, { HYPERION_RELEASE_TEST_CELL: "lumen" });

  let executed = false;
  assert.throws(
    () =>
      runReleaseChecks({ cell: "sibling" }, () => {
        executed = true;
      }),
    /Unknown release cell/
  );
  assert.equal(executed, false);
  assert.throws(
    () =>
      runReleaseTests({ cell: "sibling" }, () => {
        executed = true;
      }),
    /Unknown release cell/
  );
  assert.equal(executed, false);
});

test("a malformed sibling registry artifact cannot fail the selected product, but fails its owner", async () => {
  const catalog = JSON.parse(
    await readFile(path.join(repositoryRoot, "releases", "registry", "provider-artifacts.v1.json"), "utf8")
  );
  const selectedCell = requestedCell ?? "nova";
  const sibling = catalog.artifacts.find((artifact) => {
    const owner = providerArtifactCell(artifact);
    return owner !== null && owner !== "platform" && owner !== selectedCell;
  });
  assert.ok(sibling, `expected a product sibling artifact for ${selectedCell}`);
  const siblingCell = providerArtifactCell(sibling);
  sibling.currentVersion = "not-semver";
  const selectedResult = await inspectProviderArtifactCatalog({ repositoryRoot, catalog, cell: selectedCell });
  assert.deepEqual(selectedResult.errors, []);
  if (requestedCell === null) {
    const siblingResult = await inspectProviderArtifactCatalog({ repositoryRoot, catalog, cell: siblingCell });
    assert.match(siblingResult.errors.join("\n"), /currentVersion must be SemVer|source version must equal/);
  }
});

test("all release CLIs fail closed for an invalid cell before running child release gates", () => {
  for (const script of [
    "scripts/releases/run-release-tests.mjs",
    "scripts/releases/run-release-checks.mjs",
    "scripts/releases/validate-release-manifests.mjs",
    "scripts/releases/check-provider-artifact-catalog.mjs",
    "scripts/releases/check-provider-contract-compatibility.mjs"
  ]) {
    const result = spawnSync(process.execPath, [script, "--cell", "sibling"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0, script);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unknown (?:release )?cell/i, script);
  }
});

// Temporary: full-stack is manual-only while Actions minutes are exhausted.
// Cell CI still scopes release gates; the global workflow keeps unscoped gates.
test("cell CI passes scope to both release commands while manual full-stack retains global gates", async () => {
  const cellWorkflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "_cell-ci.yml"), "utf8");
  assert.match(cellWorkflow, /pnpm release:test -- --cell "\$\{\{ inputs\.cell \}\}"/);
  assert.match(cellWorkflow, /pnpm release:check -- --cell "\$\{\{ inputs\.cell \}\}"/);

  const fullWorkflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "check.yml"), "utf8");
  const triggerBlock = fullWorkflow.slice(0, fullWorkflow.indexOf("permissions:"));
  assert.match(triggerBlock, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(triggerBlock, /^\s+schedule:/m);
  assert.doesNotMatch(triggerBlock, /^\s+push:/m);
  assert.match(fullWorkflow, /run: pnpm release:test\s*$/m);
  assert.match(fullWorkflow, /run: pnpm release:check\s*$/m);
  assert.doesNotMatch(fullWorkflow, /release:(?:test|check) -- --cell/);

  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["release:test"], "node scripts/releases/run-release-tests.mjs");
  assert.equal(packageJson.scripts["release:check"], "node scripts/releases/run-release-checks.mjs");
  assert.match(packageJson.scripts.check, /pnpm release:test/);
  assert.match(packageJson.scripts.check, /pnpm release:check/);
});

test("provider contract selection contains only contracts owned by the requested cell", () => {
  const expected = {
    platform: ["platform-contracts", "audit-contracts"],
    nova: ["nova-contracts"],
    lumen: ["lumen-contracts"],
    pulso: ["pulso-contracts"]
  };
  for (const cell of cells) assert.deepEqual(providerContractIdsForCell(cell), expected[cell]);
});
