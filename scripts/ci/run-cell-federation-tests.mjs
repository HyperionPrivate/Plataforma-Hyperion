import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const COMMON_FEDERATION_TESTS = Object.freeze([
  "scripts/architecture/check-federation-boundaries.test.mjs",
  "scripts/architecture/check-federated-ci.test.mjs",
  "scripts/autonomy/access-channel-projection.test.mjs",
  "scripts/ci/resolve-cell-impact.test.mjs",
  "scripts/ci/resolve-access-channel-impact.test.mjs",
  "scripts/ci/resolve-compose-image-reference.test.mjs",
  "scripts/ci/resolve-container-scan-plan.test.mjs",
  "scripts/ci/run-cell-phase.test.mjs",
  "scripts/ci/smoke-cell-bff-image.test.mjs",
  "scripts/ci/verify-required-cell-result.test.mjs",
  "scripts/docker/hostname-edge.test.mjs",
  "scripts/docker/nginx-federation.test.mjs"
]);

export const CELL_FEDERATION_TESTS = Object.freeze({
  platform: Object.freeze([
    "scripts/docker/audit-autonomy.test.mjs",
    "scripts/docker/platform-standalone-compose.test.mjs"
  ]),
  nova: Object.freeze([
    "scripts/autonomy/nova-audit-http.test.mjs",
    "scripts/autonomy/nova-smoke.test.mjs",
    "scripts/ci/cell-install-plan.test.mjs",
    "scripts/ci/nova-migration-autonomy.test.mjs",
    "scripts/docker/nova-migration-artifacts.test.mjs",
    "scripts/docker/nova-standalone-compose.test.mjs"
  ]),
  lumen: Object.freeze(["scripts/ci/verify-n-minus-one-lumen-audio.test.mjs"]),
  pulso: Object.freeze(["scripts/ci/run-pulso-runtime-integrations.test.mjs"])
});

export function federationTestsForCell(cell) {
  const owned = CELL_FEDERATION_TESTS[cell];
  if (!owned) throw new Error(`Unknown cell ${JSON.stringify(cell)}`);
  return Object.freeze([...COMMON_FEDERATION_TESTS, ...owned]);
}

export function parseCellFederationArguments(argv) {
  let cell;
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--cell") cell = argv[++index];
    else if (argument === "--list") list = true;
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
  }
  if (!cell) throw new Error("--cell is required");
  federationTestsForCell(cell);
  return { cell, list };
}

export async function runCellFederationTests(cell, dependencies = {}) {
  const tests = federationTestsForCell(cell);
  const launch = dependencies.spawn ?? spawn;
  const child = launch(process.execPath, ["--test", ...tests], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit"
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) throw new Error(`${cell} federation tests terminated by ${result.signal}`);
  if (result.code !== 0) throw new Error(`${cell} federation tests failed with exit code ${result.code}`);
  return tests;
}

async function main() {
  const options = parseCellFederationArguments(process.argv.slice(2));
  const tests = federationTestsForCell(options.cell);
  if (options.list) {
    process.stdout.write(`${tests.join("\n")}\n`);
    return;
  }
  await runCellFederationTests(options.cell);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
