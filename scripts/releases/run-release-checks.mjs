import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertReleaseCell, parseCellScopeArguments } from "./release-scope.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export function buildReleaseCheckPlan(cell = null) {
  const selectedCell = cell === null ? null : assertReleaseCell(cell);
  const scopeArguments = selectedCell === null ? [] : ["--cell", selectedCell];
  const plan = [
    { script: "scripts/releases/validate-release-manifests.mjs", arguments: scopeArguments },
    { script: "scripts/releases/check-provider-artifact-catalog.mjs", arguments: scopeArguments },
    { script: "scripts/releases/check-provider-contract-compatibility.mjs", arguments: scopeArguments }
  ];
  if (selectedCell === null) {
    plan.push({ script: "scripts/releases/verify-registry-publish-path.mjs", arguments: [] });
  }
  return plan;
}

export function runReleaseChecks(options, execute = executeNode) {
  for (const step of buildReleaseCheckPlan(options.cell)) execute(step);
}

function executeNode(step) {
  const result = spawnSync(process.execPath, [step.script, ...step.arguments], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${step.script} failed with exit ${String(result.status)}`);
  }
}

async function main() {
  const options = parseCellScopeArguments(process.argv.slice(2));
  runReleaseChecks(options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
