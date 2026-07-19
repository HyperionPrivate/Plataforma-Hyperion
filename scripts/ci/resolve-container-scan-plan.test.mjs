import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveContainerScanPlan } from "./resolve-container-scan-plan.mjs";

async function packageAt(root, directory, name, dependencies = {}) {
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, directory, "package.json"), JSON.stringify({ name, dependencies }), "utf8");
}

test("a NOVA package change scans NOVA without building LUMEN or PULSO", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-container-scan-"));
  try {
    await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service");
    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service");
    await packageAt(root, "services/pulso-iris-service", "@hyperion/pulso-iris-service");
    const plan = await resolveContainerScanPlan(root, {
      changedFiles: ["services/nova-core-service/package.json"]
    });
    assert.deepEqual(plan.affectedCells, ["nova"]);
    assert.deepEqual(plan.matrix, { include: [{ cell: "nova" }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed shared dependency scans only the cells that transitively consume it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-container-scan-"));
  try {
    await packageAt(root, "packages/platform-contracts", "@hyperion/platform-contracts");
    await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service", {
      "@hyperion/platform-contracts": "workspace:*"
    });
    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service");
    await packageAt(root, "services/pulso-iris-service", "@hyperion/pulso-iris-service", {
      "@hyperion/platform-contracts": "workspace:*"
    });
    const plan = await resolveContainerScanPlan(root, {
      changedFiles: ["packages/platform-contracts/package.json"]
    });
    assert.deepEqual(plan.affectedCells, ["platform", "nova", "pulso"]);
    assert.doesNotMatch(JSON.stringify(plan.matrix), /lumen/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduled or unreliable-base scans fail safe to every cell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-container-scan-"));
  try {
    const forced = await resolveContainerScanPlan(root, { forceAll: true });
    assert.deepEqual(forced.affectedCells, ["platform", "nova", "lumen", "pulso"]);
    assert.equal(forced.hasCells, true);

    const unreliable = await resolveContainerScanPlan(root, { base: "0".repeat(40), head: "a".repeat(40) });
    assert.deepEqual(unreliable.affectedCells, forced.affectedCells);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("container scan workflow resolves affected cells and builds only its matrix services", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const workflow = await import("node:fs/promises").then(({ readFile }) =>
    readFile(path.join(root, ".github", "workflows", "container-scan.yml"), "utf8")
  );
  assert.match(workflow, /resolve-container-scan-plan\.mjs/);
  assert.match(workflow, /matrix:\s*\$\{\{ fromJSON\(needs\.impact\.outputs\.matrix\) \}\}/);
  assert.match(workflow, /generate-cell-contexts\.mjs --cell "\$CELL"/);
  assert.match(workflow, /cell-compose-plan\.mjs "\$CELL" services/);
  assert.match(workflow, /cell-compose-plan\.mjs "\$CELL" compose-file/);
  assert.match(workflow, /cell-compose-plan\.mjs "\$CELL" env-file/);
  assert.match(workflow, /-f "\$COMPOSE_FILE"/);
  assert.match(workflow, /build --pull "\$\{services\[@\]\}"/);
  assert.doesNotMatch(workflow, /Build every deployable image/);
  assert.doesNotMatch(workflow, /docker compose[^\n]* build --pull\s*$/m);
  assert.match(workflow, /COMPOSE_PARALLEL_LIMIT:\s*2/);
});
