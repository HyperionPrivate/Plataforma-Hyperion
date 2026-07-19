import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_CONTRACTS,
  compareSemver,
  compareSnapshotSurface,
  compareTypeSurface,
  createContractSnapshot,
  parseSemver,
  readVersionedSnapshots,
  requiresNMinusOneTypeComparison,
  requireLatestSnapshot,
  validatePackedManifest
} from "./provider-contract-compatibility.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturesRoot = path.join(repositoryRoot, "fixtures", "contracts", "provider-owned");

function fixtureSnapshot(version, overrides = {}) {
  return createContractSnapshot({
    manifest: {
      name: "@hyperion/example-contracts",
      version,
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      files: ["dist", "!dist/**/*.test.*"]
    },
    declarationFiles: { "dist/index.d.ts": "export declare const value: string;\n" },
    runtimeSchemas: {},
    provenance: { kind: "repository-baseline", published: false, sourceRevision: null },
    ...overrides
  });
}

test("compares release SemVer including prereleases", () => {
  assert.deepEqual(parseSemver("1.2.3-rc.1"), {
    raw: "1.2.3-rc.1",
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: "rc.1"
  });
  assert.equal(compareSemver("1.2.3-rc.1", "1.2.3"), -1);
  assert.equal(compareSemver("1.3.0", "1.2.9"), 1);
  assert.equal(parseSemver("01.2.3"), null);
  assert.equal(parseSemver("1.2.3-rc.01"), null);
});

test("fails closed when no N-1 snapshot exists or the package version regresses", () => {
  assert.throws(() => requireLatestSnapshot([], "audit-contracts", "1.0.0"), /no versioned N-1 snapshot exists/);
  assert.throws(
    () => requireLatestSnapshot([fixtureSnapshot("2.0.0")], "audit-contracts", "1.9.9"),
    /older than latest snapshot 2\.0\.0/
  );
});

test("rejects workspace protocols and non-exact provider dependencies in packed artifacts", () => {
  const versions = new Map([["@hyperion/platform-contracts", "1.0.0"]]);
  const workspace = validatePackedManifest(
    {
      name: "@hyperion/audit-contracts",
      version: "1.0.0",
      dependencies: { "@hyperion/platform-contracts": "workspace:*" }
    },
    "@hyperion/audit-contracts",
    versions
  );
  assert.match(workspace.join("\n"), /workspace:/);
  assert.match(workspace.join("\n"), /must be exact 1\.0\.0/);
  assert.deepEqual(
    validatePackedManifest(
      {
        name: "@hyperion/audit-contracts",
        version: "1.0.1",
        dependencies: { "@hyperion/platform-contracts": "1.0.0", zod: "^3.24.2" }
      },
      "@hyperion/audit-contracts",
      versions
    ),
    []
  );
});

test("keeps an existing version immutable and permits additive minor surfaces", () => {
  const previous = fixtureSnapshot("1.0.0");
  const drifted = fixtureSnapshot("1.0.0", {
    declarationFiles: { "dist/index.d.ts": "export declare const value: number;\n" }
  });
  assert.match(compareSnapshotSurface(previous, drifted).errors.join("\n"), /bump SemVer/);

  const additive = fixtureSnapshot("1.1.0", {
    declarationFiles: {
      "dist/index.d.ts": "export declare const value: string;\nexport declare const extra: boolean;\n"
    }
  });
  assert.deepEqual(compareSnapshotSurface(previous, additive), { errors: [], mode: "compatible" });
});

test("rejects removed subpaths and changed wire schemas without a major bump", () => {
  const previous = fixtureSnapshot("1.0.0", {
    manifest: {
      name: "@hyperion/example-contracts",
      version: "1.0.0",
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./wire": { types: "./dist/wire.d.ts", default: "./dist/wire.js" }
      },
      files: ["dist", "!dist/**/*.test.*"]
    },
    declarationFiles: {
      "dist/index.d.ts": "export declare const value: string;\n",
      "dist/wire.d.ts": "export declare const wire: string;\n"
    },
    runtimeSchemas: { ".#messageSchema": { typeName: "ZodObject", sha256: "a".repeat(64) } }
  });
  const current = fixtureSnapshot("1.1.0", {
    runtimeSchemas: { ".#messageSchema": { typeName: "ZodObject", sha256: "b".repeat(64) } }
  });
  const errors = compareSnapshotSurface(previous, current).errors.join("\n");
  assert.match(errors, /removed public export subpath \.\/wire/);
  assert.match(errors, /changed runtime schema \.#messageSchema/);
});

test("keeps the N-1 public surface across an explicit major", () => {
  const previous = fixtureSnapshot("1.9.0", {
    manifest: {
      name: "@hyperion/example-contracts",
      version: "1.9.0",
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./legacy": { types: "./dist/legacy.d.ts", default: "./dist/legacy.js" }
      },
      files: ["dist", "!dist/**/*.test.*"]
    },
    declarationFiles: {
      "dist/index.d.ts": "export declare const value: string;\n",
      "dist/legacy.d.ts": "export declare const legacy: string;\n"
    }
  });
  const current = fixtureSnapshot("2.0.0", {
    declarationFiles: { "dist/index.d.ts": "export declare const replacement: number;\n" }
  });
  const comparison = compareSnapshotSurface(previous, current);
  assert.equal(comparison.mode, "major-compatible");
  assert.match(comparison.errors.join("\n"), /removed public export subpath \.\/legacy/);
  assert.equal(requiresNMinusOneTypeComparison(comparison.mode), true);
});

test("uses TypeScript assignability to allow additions and reject removed or narrowed exports", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "hyperion-contract-types-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const previousRoot = path.join(temporaryRoot, "previous");
  const currentRoot = path.join(temporaryRoot, "current");
  await mkdir(path.join(previousRoot, "dist"), { recursive: true });
  await mkdir(path.join(currentRoot, "dist"), { recursive: true });
  const manifest = {
    name: "@hyperion/example-contracts",
    version: "1.0.0",
    type: "module",
    types: "dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }
  };
  await writeFile(
    path.join(previousRoot, "dist", "index.d.ts"),
    'export interface Result { value: string }\nexport interface Box<T> { value: T }\nexport declare function parse(input: string): Result;\nexport declare const marker: "v1";\n'
  );
  await writeFile(
    path.join(currentRoot, "dist", "index.d.ts"),
    'export interface Result { value: string; detail?: string }\nexport interface Box<T> { value: T; detail?: string }\nexport declare function parse(input: string): Result;\nexport declare const marker: "v1";\nexport declare const extra: boolean;\n'
  );
  assert.deepEqual(
    await compareTypeSurface({ previousRoot, currentRoot, previousManifest: manifest, currentManifest: manifest }),
    []
  );

  await writeFile(
    path.join(currentRoot, "dist", "index.d.ts"),
    'export interface Result { detail: string }\nexport interface Box<T> { value: number }\nexport declare function parse(input: number): Result;\nexport declare const marker: "v2";\n'
  );
  const errors = await compareTypeSurface({
    previousRoot,
    currentRoot,
    previousManifest: manifest,
    currentManifest: manifest
  });
  assert.match(errors.join("\n"), /Result|parse/);
  assert.match(errors.join("\n"), /Box/);
  assert.match(errors.join("\n"), /marker/);
});

test("ships one immutable and genuinely older N-1 baseline for every provider contract", async () => {
  for (const [id, provider] of Object.entries(PROVIDER_CONTRACTS)) {
    const snapshots = await readVersionedSnapshots(fixturesRoot, id, provider.packageName);
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, provider.directory, "package.json"), "utf8"));
    assert.equal(snapshots.length, 1, `${id} must start with exactly one baseline`);
    assert.equal(snapshots[0].version, "1.0.0");
    assert.equal(manifest.version, "1.1.0");
    assert.equal(compareSemver(snapshots[0].version, manifest.version), -1, `${id} must compare N-1 to current`);
    assert.equal(snapshots[0].provenance.kind, "repository-baseline");
    assert.equal(snapshots[0].provenance.published, false);
    assert.ok(Object.keys(snapshots[0].runtimeSchemas).length > 0);
    assert.ok(Object.keys(snapshots[0].declarationFiles).length > 0);
  }
});

test("publishing resolves the registry predecessor before compatibility and cell CI keeps the local gate", async () => {
  const publisher = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "publish-provider-contracts.yml"),
    "utf8"
  );
  const compatibilityChecker = await readFile(
    path.join(repositoryRoot, "scripts", "releases", "check-provider-contract-compatibility.mjs"),
    "utf8"
  );
  const cellCi = await readFile(path.join(repositoryRoot, ".github", "workflows", "_cell-ci.yml"), "utf8");
  assert.match(publisher, /provider-contract-registry\.mjs/);
  assert.match(publisher, /check-provider-artifact-catalog\.mjs/);
  assert.match(
    publisher,
    /Require exact provider dependencies already published[\s\S]*?npm[\s\S]*?view[\s\S]*?publish \$\{name\}@\$\{version\} and verify registry readback first/
  );
  assert.match(publisher, /REGISTRY_ORIGIN" != "https:\/\/registry\.npmjs\.org"/);
  assert.match(publisher, /--registry-resolution "\$N_MINUS_ONE_RESOLUTION"/);
  assert.match(
    publisher,
    /Enforce provider contract N\/N-1 compatibility[\s\S]*?SOURCE_REPOSITORY:\s*\$\{\{ github\.repository \}\}[\s\S]*?REGISTRY_ORIGIN:\s*\$\{\{ inputs\.registry_origin \}\}/
  );
  assert.match(publisher, /--record-published-snapshot/);
  assert.match(
    publisher,
    /Capture the exact published-registry snapshot candidate[\s\S]*?provider-contract-registry\.mjs[\s\S]*?--exact-target/
  );
  assert.match(publisher, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(
    publisher,
    /Attest the exact published-registry snapshot candidate[\s\S]*?actions\/attest@[0-9a-f]{40}[\s\S]*?subject-path:\s*\$\{\{ env\.PUBLISHED_SNAPSHOT \}\}/
  );
  assert.ok(
    publisher.indexOf("Require exact provider dependencies already published") <
      publisher.indexOf("provider-contract-registry.mjs") &&
      publisher.indexOf("provider-contract-registry.mjs") <
        publisher.indexOf("check-provider-contract-compatibility.mjs") &&
      publisher.indexOf("check-provider-contract-compatibility.mjs") <
        publisher.indexOf("Attest the exact contract tarball")
  );
  assert.match(cellCi, /pnpm release:check -- --cell "\$\{\{ inputs\.cell \}\}"/);
  assert.match(cellCi, /pnpm release:test -- --cell "\$\{\{ inputs\.cell \}\}"/);
  assert.match(compatibilityChecker, /capturedSurfaceTarballBytes\.equals\(tarballBytes\)/);
});

test("provider tarball allowlists exclude compiled tests", async () => {
  for (const provider of Object.values(PROVIDER_CONTRACTS)) {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, provider.directory, "package.json"), "utf8"));
    assert.ok(manifest.files.includes("!dist/**/*.test.*"), `${manifest.name} must exclude compiled tests`);
  }
});
