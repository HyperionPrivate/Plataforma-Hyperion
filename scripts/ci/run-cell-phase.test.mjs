import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCellPhasePlan } from "./run-cell-phase.mjs";

async function packageAt(root, directory, name) {
  await mkdir(path.join(root, directory, "src"), { recursive: true });
  await writeFile(path.join(root, directory, "package.json"), JSON.stringify({ name }), "utf8");
}

test("build plans contain only the selected cell roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-cell-phase-"));
  try {
    await packageAt(root, "packages/contracts", "@hyperion/contracts");
    await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service");
    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service");
    const plan = await createCellPhasePlan(root, "nova", "build");
    assert.deepEqual(plan.packages, ["@hyperion/nova-core-service"]);
    assert.match(plan.commands[0].args.join(" "), /@hyperion\/nova-core-service\.\.\./);
    assert.doesNotMatch(plan.commands[0].args.join(" "), /lumen/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typecheck plans materialize package types on a clean checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-cell-phase-"));
  try {
    await packageAt(root, "packages/nova-contracts", "@hyperion/nova-contracts");
    const plan = await createCellPhasePlan(root, "nova", "typecheck");
    assert.equal(plan.commands.length, 2);
    assert.equal(plan.commands[0].args.at(-1), "build");
    assert.equal(plan.commands[1].args.at(-1), "typecheck");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("integration plans select explicit integration files from the owning cell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-cell-phase-"));
  try {
    await packageAt(root, "services/pulso-iris-service", "@hyperion/pulso-iris-service");
    await writeFile(
      path.join(root, "services", "pulso-iris-service", "src", "flow.integration.test.ts"),
      "export {};",
      "utf8"
    );
    await writeFile(path.join(root, "services", "pulso-iris-service", "src", "unit.test.ts"), "export {};", "utf8");
    const plan = await createCellPhasePlan(root, "pulso", "integration");
    assert.equal(plan.commands.length, 1);
    assert.match(plan.commands[0].args.join(" "), /flow\.integration\.test\.ts/);
    assert.doesNotMatch(plan.commands[0].args.join(" "), /unit\.test\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
