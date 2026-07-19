import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCellInstallPlan } from "./cell-install-plan.mjs";

async function packageAt(root, directory, name, dependencies = {}) {
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, directory, "package.json"), JSON.stringify({ name, dependencies }), "utf8");
}

test("NOVA install selects exact cell roots, the root toolchain and only allowed dependency importers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-cell-install-"));
  try {
    await packageAt(root, "packages/platform-contracts", "@hyperion/platform-contracts");
    await packageAt(root, "packages/nova-contracts", "@hyperion/nova-contracts", {
      "@hyperion/platform-contracts": "workspace:*"
    });
    await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service", {
      "@hyperion/nova-contracts": "workspace:*"
    });
    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service");
    await packageAt(root, "services/pulso-iris-service", "@hyperion/pulso-iris-service");
    await packageAt(root, "apps/coopfuturo-console", "@hyperion/coopfuturo-console");

    const plan = await createCellInstallPlan(root, "nova");
    assert.equal(plan.rootImporter, ".");
    assert.deepEqual(plan.rootPackages, ["@hyperion/nova-contracts", "@hyperion/nova-core-service"]);
    assert.deepEqual(plan.filters, ["@hyperion/nova-contracts...", "@hyperion/nova-core-service..."]);
    assert.deepEqual(plan.dependencyClosure, [
      "@hyperion/nova-contracts",
      "@hyperion/nova-core-service",
      "@hyperion/platform-contracts"
    ]);
    assert.deepEqual(plan.excludedStandalone, ["apps/coopfuturo-console"]);
    assert.deepEqual(plan.command.args.slice(0, 4), ["install", "--frozen-lockfile", "--filter", "."]);
    assert.doesNotMatch(JSON.stringify(plan), /lumen-service|pulso-iris-service/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unrelated LUMEN and PULSO dependency changes do not enter a NOVA dry-run plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-cell-install-"));
  try {
    await packageAt(root, "packages/platform-contracts", "@hyperion/platform-contracts");
    await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service", {
      "@hyperion/platform-contracts": "workspace:*"
    });
    await packageAt(root, "packages/lumen-contracts", "@hyperion/lumen-contracts");
    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service", {
      "@hyperion/lumen-contracts": "workspace:*"
    });
    await packageAt(root, "services/pulso-iris-service", "@hyperion/pulso-iris-service");

    const before = await createCellInstallPlan(root, "nova");
    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service", {
      "@hyperion/lumen-contracts": "workspace:*",
      "@hyperion/pulso-iris-service": "workspace:*"
    });
    const after = await createCellInstallPlan(root, "nova");
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a sibling-cell dependency in the selected closure fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-cell-install-"));
  try {
    await packageAt(root, "packages/lumen-contracts", "@hyperion/lumen-contracts");
    await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service", {
      "@hyperion/lumen-contracts": "workspace:*"
    });
    await assert.rejects(() => createCellInstallPlan(root, "nova"), /crosses into sibling lumen/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a package-limited install must name a root owned by the requested cell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-cell-install-"));
  try {
    await packageAt(root, "packages/nova-migrations", "@hyperion/nova-migrations");
    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service");
    const plan = await createCellInstallPlan(root, "nova", ["@hyperion/nova-migrations"]);
    assert.deepEqual(plan.filters, ["@hyperion/nova-migrations..."]);
    await assert.rejects(
      () => createCellInstallPlan(root, "nova", ["@hyperion/lumen-service"]),
      /belongs to lumen, not nova/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
