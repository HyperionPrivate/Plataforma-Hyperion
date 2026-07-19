import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCellInstallPlan } from "./cell-install-plan.mjs";
import { accessChannelBoundaryReason, resolveAccessChannelImpact } from "./resolve-access-channel-impact.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("selects the policy, install planner, root toolchain, and every compiled boundary layer", () => {
  for (const changedFile of [
    ".github/workflows/access-channel-projection.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "scripts/architecture/cell-policy.mjs",
    "scripts/ci/cell-install-plan.mjs",
    "scripts/ci/cell-install-plan.test.mjs",
    "scripts/ci/resolve-access-channel-impact.mjs",
    "scripts/ci/resolve-access-channel-impact.test.mjs",
    "scripts/ci/resolve-cell-impact.mjs",
    "scripts/ci/resolve-cell-impact.test.mjs",
    "packages/access-migrations/package.json",
    "packages/access-migrations/tsconfig.json",
    "packages/access-migrations/src/index.ts",
    "packages/access-migrations/sql/001-access-schema.sql",
    "packages/config/package.json",
    "packages/config/tsconfig.json",
    "packages/config/src/index.ts",
    "packages/database/package.json",
    "packages/database/tsconfig.json",
    "packages/database/src/index.ts",
    "packages/durable-events/package.json",
    "packages/durable-events/tsconfig.json",
    "packages/durable-events/src/index.ts",
    "packages/logger/package.json",
    "packages/logger/tsconfig.json",
    "packages/logger/src/index.ts",
    "packages/platform-contracts/package.json",
    "packages/platform-contracts/tsconfig.json",
    "packages/platform-contracts/src/access-tenant-snapshot.ts",
    "packages/platform-contracts/src/index.ts",
    "packages/pulso-contracts/package.json",
    "packages/pulso-contracts/tsconfig.json",
    "packages/pulso-contracts/src/index.ts",
    "packages/pulso-migrations/package.json",
    "packages/pulso-migrations/tsconfig.json",
    "packages/pulso-migrations/src/index.ts",
    "packages/pulso-migrations/sql/001-pulso-schema.sql",
    "packages/service-runtime/package.json",
    "packages/service-runtime/tsconfig.json",
    "packages/service-runtime/src/internal-auth.ts",
    "packages/service-runtime/src/operator-assertion.test.ts",
    "packages/service-runtime/src/nested/future-runtime-module.ts",
    "services/identity-service/package.json",
    "services/identity-service/tsconfig.json",
    "services/identity-service/src/index.ts",
    "services/identity-service/src/access-token.ts",
    "services/identity-service/src/access-tenant-projections.ts",
    "services/identity-service/src/access-tenant-projections.integration.test.ts",
    "services/identity-service/src/access-tenant-projection-operations.ts",
    "services/whatsapp-channel-service/package.json",
    "services/whatsapp-channel-service/tsconfig.json",
    "services/whatsapp-channel-service/src/index.ts",
    "services/whatsapp-channel-service/src/app.ts",
    "services/whatsapp-channel-service/src/provider-config.ts",
    "services/whatsapp-channel-service/src/access-tenant-projections.ts",
    "services/whatsapp-channel-service/src/access-tenant-projections.integration.test.ts",
    "services/whatsapp-channel-service/src/access-tenant-projection-jetstream.ts",
    "packages/access-migrations/sql/003-access-tenant-projection.sql",
    "packages/access-migrations/sql/004-access-tenant-lifecycle-integrity.sql",
    "packages/access-migrations/src/roles.ts",
    "packages/pulso-migrations/sql/004-access-channel-tenant-projection.sql",
    "packages/pulso-migrations/src/schema-manifest.ts",
    "scripts/autonomy/access-channel-projection.e2e.mjs",
    "scripts/autonomy/access-channel-projection.test.mjs"
  ]) {
    assert.ok(accessChannelBoundaryReason(changedFile), changedFile);
    assert.equal(resolveAccessChannelImpact([changedFile]).affected, true, changedFile);
  }

  assert.ok(accessChannelBoundaryReason("packages\\service-runtime\\src\\runtime-config.ts"));
});

test("the allowlist stays aligned with both package-limited install closures", async () => {
  const platform = await createCellInstallPlan(repositoryRoot, "platform", [
    "@hyperion/access-migrations",
    "@hyperion/identity-service"
  ]);
  const pulso = await createCellInstallPlan(repositoryRoot, "pulso", [
    "@hyperion/pulso-migrations",
    "@hyperion/whatsapp-channel-service"
  ]);
  assert.deepEqual([...new Set([...platform.dependencyClosure, ...pulso.dependencyClosure])].sort(), [
    "@hyperion/access-migrations",
    "@hyperion/config",
    "@hyperion/database",
    "@hyperion/durable-events",
    "@hyperion/identity-service",
    "@hyperion/logger",
    "@hyperion/platform-contracts",
    "@hyperion/pulso-contracts",
    "@hyperion/pulso-migrations",
    "@hyperion/service-runtime",
    "@hyperion/whatsapp-channel-service"
  ]);
});

test("does not run the cross-cell rehearsal for unrelated product changes", () => {
  for (const changedFile of [
    "services/agent-service/src/app.ts",
    "apps/pulso-console/src/App.tsx",
    "services/nova-core-service/src/app.ts",
    "services/lumen-service/src/app.ts",
    "apps/platform-admin-console/src/App.tsx",
    "docs/products/PULSO-IRIS.md",
    "packages/audit-migrations/sql/001-audit-schema.sql",
    "packages/lumen-contracts/src/index.ts",
    "packages/nova-service-runtime/src/index.ts",
    "services/identity-service/README.md",
    "services/whatsapp-channel-service/README.md"
  ]) {
    assert.equal(accessChannelBoundaryReason(changedFile), undefined, changedFile);
    assert.equal(resolveAccessChannelImpact([changedFile]).affected, false, changedFile);
  }
});

test("combines paths deterministically and fails safe without a reliable base", () => {
  assert.deepEqual(
    resolveAccessChannelImpact(["apps/pulso-console/src/App.tsx", "services/identity-service/src/app.ts"]),
    {
      affected: true,
      changedFiles: ["apps/pulso-console/src/App.tsx", "services/identity-service/src/app.ts"],
      reasons: ["services/identity-service/src/app.ts is compiled in the Access→Channel producer or consumer closure"]
    }
  );
  assert.deepEqual(resolveAccessChannelImpact([], { forceAll: true }), {
    affected: true,
    changedFiles: [],
    reasons: ["no reliable base revision; fail-safe Access→Channel boundary acceptance"]
  });
});

test("the workflow independently rejects a skipped boundary-policy change", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/access-channel-projection.yml"), "utf8");
  assert.match(
    workflow,
    /node --test scripts\/ci\/resolve-access-channel-impact\.test\.mjs\s+scripts\/ci\/cell-install-plan\.test\.mjs/
  );
  assert.match(workflow, /name: Reject a skipped boundary-policy change/);
  assert.match(workflow, /AFFECTED: \$\{\{ steps\.impact\.outputs\.affected \}\}/);
  for (const policyFile of [
    "scripts/ci/resolve-access-channel-impact.mjs",
    "scripts/ci/resolve-access-channel-impact.test.mjs",
    "scripts/ci/cell-install-plan.mjs",
    "scripts/ci/cell-install-plan.test.mjs",
    "scripts/ci/resolve-cell-impact.mjs",
    "scripts/architecture/cell-policy.mjs"
  ]) {
    assert.match(workflow, new RegExp(policyFile.replaceAll(".", "\\.").replaceAll("/", "\\/")));
  }
});
