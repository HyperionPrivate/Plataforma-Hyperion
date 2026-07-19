import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertReleaseCell, parseCellScopeArguments } from "./release-scope.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export const GLOBAL_RELEASE_TEST_FILES = Object.freeze([
  "scripts/releases/release-manifest.test.mjs",
  "scripts/releases/rollback-policy.test.mjs",
  "scripts/releases/published-release.test.mjs",
  "scripts/releases/image-producer.test.mjs",
  "scripts/releases/reconcile-github-release.test.mjs",
  "scripts/releases/provider-contract-compatibility.test.mjs",
  "scripts/releases/provider-contract-registry.test.mjs",
  "scripts/releases/check-provider-artifact-catalog.test.mjs",
  "scripts/releases/npm-artifact-publication.test.mjs",
  "scripts/releases/shared-library-publication.test.mjs",
  "scripts/releases/cell-release.test.mjs",
  "scripts/releases/release-scope.test.mjs"
]);

export const CELL_RELEASE_TEST_FILES = Object.freeze([
  "scripts/releases/cell-release.test.mjs",
  "scripts/releases/release-scope.test.mjs"
]);

export function buildReleaseTestPlan(cell = null) {
  const selectedCell = cell === null ? null : assertReleaseCell(cell);
  return {
    files: selectedCell === null ? [...GLOBAL_RELEASE_TEST_FILES] : [...CELL_RELEASE_TEST_FILES],
    environment: selectedCell === null ? {} : { HYPERION_RELEASE_TEST_CELL: selectedCell }
  };
}

export function runReleaseTests(options, execute = executeNodeTests) {
  execute(buildReleaseTestPlan(options.cell));
}

function executeNodeTests(plan) {
  const result = spawnSync(process.execPath, ["--test", ...plan.files], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env, ...plan.environment }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`release tests failed with exit ${String(result.status)}`);
}

async function main() {
  const options = parseCellScopeArguments(process.argv.slice(2));
  runReleaseTests(options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
