import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractStaticModuleSpecifiers } from "../architecture/workspace-dependency-graph.mjs";
import { changedFilesFromNameStatus, resolveCellImpact } from "./resolve-cell-impact.mjs";

async function packageAt(root, directory, name, dependencies = {}) {
  await mkdir(path.join(root, directory, "src"), { recursive: true });
  await writeFile(
    path.join(root, directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", dependencies }),
    "utf8"
  );
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-cell-impact-"));
  await packageAt(root, "packages/contracts", "@hyperion/contracts");
  await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service", {
    "@hyperion/contracts": "workspace:*"
  });
  await packageAt(root, "services/lumen-service", "@hyperion/lumen-service", {
    "@hyperion/contracts": "workspace:*"
  });
  await packageAt(root, "services/pulso-iris-service", "@hyperion/pulso-iris-service");
  return root;
}

test("the dependency graph scanner recognizes static edges without treating examples as imports", () => {
  const source = [
    'import value from "@hyperion/one";',
    'import "@hyperion/two/register";',
    'export { value as other } from "@hyperion/three";',
    'const lazy = import("@hyperion/four/subpath");',
    'const legacy = require("@hyperion/five");',
    "const example = 'import ignored from \"@hyperion/not-an-edge\"';",
    '// import ignored from "@hyperion/commented";',
    'const template = `require("@hyperion/template-example")`;',
    "void value; void lazy; void legacy; void example; void template;"
  ].join("\n");
  assert.deepEqual(extractStaticModuleSpecifiers(source), [
    "@hyperion/five",
    "@hyperion/four/subpath",
    "@hyperion/one",
    "@hyperion/three",
    "@hyperion/two/register"
  ]);
});

test("a product-only change affects only its dependency closure", async () => {
  const root = await fixture();
  try {
    const impact = await resolveCellImpact(root, ["services/nova-core-service/src/app.ts"]);
    assert.deepEqual(impact.cells, { platform: false, nova: true, lumen: false, pulso: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a provider contract change does not drag the legacy platform gateway into CI", async () => {
  const root = await fixture();
  try {
    await packageAt(root, "packages/platform-contracts", "@hyperion/platform-contracts");
    await packageAt(root, "packages/nova-contracts", "@hyperion/nova-contracts", {
      "@hyperion/platform-contracts": "1.1.0"
    });
    await packageAt(root, "apps/nova-bff", "@hyperion/nova-bff", {
      "@hyperion/nova-contracts": "1.1.0",
      "@hyperion/platform-contracts": "1.1.0"
    });
    await packageAt(root, "apps/api-gateway", "@hyperion/api-gateway", {
      "@hyperion/contracts": "workspace:*",
      "@hyperion/platform-contracts": "1.1.0"
    });

    const impact = await resolveCellImpact(root, ["packages/nova-contracts/src/index.ts"]);
    assert.deepEqual(impact.cells, { platform: false, nova: true, lumen: false, pulso: false });
    assert.equal(impact.affectedPackages.includes("@hyperion/nova-bff"), true);
    assert.equal(impact.affectedPackages.includes("@hyperion/api-gateway"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rename and copy records affect both their old and new cell paths", async () => {
  const root = await fixture();
  try {
    const changedFiles = changedFilesFromNameStatus(
      [
        "R100",
        "services/nova-core-service/src/legacy.ts",
        "services/lumen-service/src/moved.ts",
        "C087",
        "services/lumen-service/src/template.ts",
        "services/pulso-iris-service/src/copied.ts",
        ""
      ].join("\0")
    );
    assert.deepEqual(changedFiles, [
      "services/nova-core-service/src/legacy.ts",
      "services/lumen-service/src/moved.ts",
      "services/lumen-service/src/template.ts",
      "services/pulso-iris-service/src/copied.ts"
    ]);
    const impact = await resolveCellImpact(root, changedFiles);
    assert.deepEqual(impact.cells, { platform: false, nova: true, lumen: true, pulso: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed name-status records fail closed", () => {
  assert.throws(() => changedFilesFromNameStatus("R100\0services/nova-core-service/src/old.ts\0"), /Truncated/);
  assert.throws(() => changedFilesFromNameStatus("X\0unknown.ts\0"), /Unexpected git diff status/);
});

test("a shared package change follows reverse workspace dependencies", async () => {
  const root = await fixture();
  try {
    const impact = await resolveCellImpact(root, ["packages/contracts/src/index.ts"]);
    assert.deepEqual(impact.cells, { platform: true, nova: true, lumen: true, pulso: false });
    assert.deepEqual(impact.affectedPackages, [
      "@hyperion/contracts",
      "@hyperion/lumen-service",
      "@hyperion/nova-core-service"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the transitional global migrator exercises every cell until schema ownership is separated", async () => {
  const root = await fixture();
  try {
    await packageAt(root, "packages/migrations", "@hyperion/migrations");
    const impact = await resolveCellImpact(root, ["packages/migrations/src/service-database-roles.ts"]);
    assert.deepEqual(impact.cells, { platform: true, nova: true, lumen: true, pulso: true });
    for (const cell of Object.keys(impact.cells)) {
      assert.match(impact.reasons[cell].join("\n"), /transitional global package @hyperion\/migrations/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an undeclared internal import fails closed before calculating affected cells", async () => {
  const root = await fixture();
  try {
    await writeFile(
      path.join(root, "services/nova-core-service/src/app.ts"),
      [
        "const documentationExample = 'from \"@hyperion/lumen-service\"';",
        'import { lumen } from "@hyperion/lumen-service";',
        "void documentationExample;",
        "void lumen;"
      ].join("\n"),
      "utf8"
    );
    await assert.rejects(
      resolveCellImpact(root, ["packages/contracts/src/index.ts"]),
      /@hyperion\/nova-core-service imports undeclared workspace edge @hyperion\/lumen-service/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unresolved workspace protocol dependency fails closed", async () => {
  const root = await fixture();
  try {
    await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service", {
      "@hyperion/contracts": "workspace:*",
      "@hyperion/missing-contracts": "workspace:*"
    });
    await assert.rejects(
      resolveCellImpact(root, ["services/nova-core-service/src/app.ts"]),
      /declares unresolved dependencies edge @hyperion\/missing-contracts@workspace:\*/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dependent product is included even when a forbidden cross-cell edge exists", async () => {
  const root = await fixture();
  try {
    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service", {
      "@hyperion/nova-core-service": "workspace:*"
    });
    const impact = await resolveCellImpact(root, ["services/nova-core-service/src/app.ts"]);
    assert.equal(impact.cells.nova, true);
    assert.equal(impact.cells.lumen, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global build and infrastructure files conservatively affect every cell", async () => {
  const root = await fixture();
  try {
    for (const changedFile of ["pnpm-lock.yaml", "infra/docker/node-service.Dockerfile"]) {
      const impact = await resolveCellImpact(root, [changedFile]);
      assert.deepEqual(impact.cells, { platform: true, nova: true, lumen: true, pulso: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deleted shared package absent from the current graph fails safe to every cell", async () => {
  const root = await fixture();
  try {
    const impact = await resolveCellImpact(root, ["packages/removed-shared/package.json"]);
    assert.deepEqual(impact.cells, { platform: true, nova: true, lumen: true, pulso: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("product documentation affects its owning cell while shared product docs remain global", async () => {
  const root = await fixture();
  try {
    for (const [changedFile, expectedCell] of [
      ["docs/products/NOVA.md", "nova"],
      ["docs/products/nova/VOICE-E2E-CHECKLIST.md", "nova"],
      ["docs/products/LUMEN.md", "lumen"],
      ["docs/products/PULSO-IRIS.md", "pulso"]
    ]) {
      const impact = await resolveCellImpact(root, [changedFile]);
      assert.equal(impact.cells[expectedCell], true, changedFile);
      assert.equal(Object.values(impact.cells).filter(Boolean).length, 1, changedFile);
    }
    for (const changedFile of [
      "docs/products/README.md",
      "docs/products/REQUIREMENTS-TRACEABILITY.md",
      "docs/ARCHITECTURE.md"
    ]) {
      const impact = await resolveCellImpact(root, [changedFile]);
      assert.deepEqual(impact.cells, { platform: true, nova: true, lumen: true, pulso: true }, changedFile);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
