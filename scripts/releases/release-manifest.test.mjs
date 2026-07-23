import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateManifest } from "./generate-release-manifest.mjs";
import { CELL_COMPOSE_SERVICES } from "../architecture/cell-policy.mjs";
import {
  buildServiceForComponent,
  composeServicesForComponent,
  draftImageReference,
  parseNpmPackageReference,
  parseOciImageReference,
  validateCatalog,
  validateManifest
} from "./release-model.mjs";
import {
  RETIRED_RELEASE_ARTIFACT_SOURCE_PATHS,
  isRetiredReleaseArtifact,
  validateRepositoryReleases
} from "./validate-release-manifests.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("validates every historical catalog and release manifest across all cells", async () => {
  const result = await validateRepositoryReleases(repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.catalogCount, 15);
  assert.equal(result.manifestCount, 14);
  assert.equal(result.rollbackPolicyCount, 3);
  assert.deepEqual(result.cells, ["platform", "nova", "lumen", "pulso"]);
});

test("keeps every sealed historical PULSO release artifact byte-immutable", async () => {
  const historicalArtifacts = new Map([
    ["releases/catalogs/pulso/1.0.0.json", "29bcb32c303068306c809bb493beb9499da99f6da7b9468e3693a46cb6cb7eac"],
    ["releases/manifests/pulso/0.1.0-dev.0.json", "08275d3760b0353147c273b96d873251e68bc31c577e145a8a88a0f759baa744"],
    ["releases/catalogs/pulso/1.1.0.json", "962dbbc362f0e8ee5312788228f78e60cf90cdde4119555e802a8692af4cfc69"],
    ["releases/rollback-policies/pulso/1.1.0.json", "1d2678bc86b1dc342391af7539f3cc2661e9400173a00c5f035668433681d0fe"],
    ["releases/manifests/pulso/0.2.0-dev.0.json", "5aecbc8587347df9dbe569370a26fd520c77df73279581bf2c08aa19e1e076d9"]
  ]);

  for (const [relativePath, expectedSha256] of historicalArtifacts) {
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256, relativePath);
  }
});

test("keeps the sealed NOVA 1.0.0 release evidence byte-immutable", async () => {
  const historicalArtifacts = new Map([
    ["releases/catalogs/nova/1.0.0.json", "a597c8eeb7a762d1e537313e3f84e353cd87e95d9f23bd7ad9dc55f37bbbea68"],
    ["releases/manifests/nova/0.1.0-dev.0.json", "fa13d9807ca564e43a012934dbf81b44e4149f846814e8d714df8fa1d479ce48"],
    ["releases/rollback-policies/nova/1.0.0.json", "6b04f5a6bccd4069df10b6ff43bcc866811c0d9b6661958e3af5080048c1ab52"]
  ]);

  for (const [relativePath, expectedSha256] of historicalArtifacts) {
    const bytes = await readFile(path.join(repositoryRoot, relativePath));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256, relativePath);
  }
});

test("keeps the latest catalogs complete for federated cells and provider contracts", async () => {
  const expectedByCell = {
    platform: [
      "identity-service",
      "tenant-service",
      "audit-service",
      "access-migrations",
      "audit-migrations",
      "platform-admin-bff",
      "platform-admin-console",
      "platform-contracts",
      "audit-contracts"
    ],
    nova: ["nova-bff", "nova-console", "nova-migrations", "nova-contracts"],
    lumen: ["lumen-bff", "lumen-console", "lumen-migrations", "lumen-contracts"],
    pulso: ["pulso-bff", "pulso-console", "pulso-migrations", "pulso-contracts"]
  };
  for (const [cell, expectedIds] of Object.entries(expectedByCell)) {
    const catalog = await readCatalog(cell);
    const ids = catalog.components.map((component) => component.id);
    if (cell === "platform") assert.deepEqual(ids, expectedIds);
    else {
      const idSet = new Set(ids);
      for (const id of expectedIds) assert.equal(idSet.has(id), true, `${cell} catalog is missing ${id}`);
    }
  }
});

test("preserves Platform 1.0.0 as historical traceability while 2.4.0 keeps four artifacts retired", async () => {
  const historical = JSON.parse(
    await readFile(path.join(repositoryRoot, "releases/catalogs/platform/1.0.0.json"), "utf8")
  );
  assert.equal(historical.catalogVersion, "1.0.0");
  assert.deepEqual(
    historical.components
      .map((component) => component.id)
      .filter((id) => ["api-gateway", "web-console", "legacy-global-migrations", "platform-migrations"].includes(id)),
    ["api-gateway", "web-console", "legacy-global-migrations", "platform-migrations"]
  );

  const latest = await readCatalog("platform");
  assert.equal(latest.catalogVersion, "2.4.0");
  assert.equal(latest.components.length, 9);
  assert.equal(latest.components.filter((component) => component.distribution === "oci").length, 7);
  assert.equal(latest.components.filter((component) => component.distribution === "npm").length, 2);
  assert.equal(latest.components.find((component) => component.id === "access-migrations")?.version, "1.2.0");
});

test("retires exactly the four obsolete Platform release artifacts without weakening discovery", () => {
  assert.deepEqual(RETIRED_RELEASE_ARTIFACT_SOURCE_PATHS, [
    "apps/api-gateway",
    "apps/web-console",
    "packages/migrations",
    "packages/platform-migrations"
  ]);
  for (const sourcePath of RETIRED_RELEASE_ARTIFACT_SOURCE_PATHS) {
    assert.equal(isRetiredReleaseArtifact({ cell: "platform", sourcePath }), true);
  }
  for (const artifact of [
    { cell: "platform", sourcePath: "apps/unknown-gateway" },
    { cell: "platform", sourcePath: "packages/access-migrations" },
    { cell: "nova", sourcePath: "apps/api-gateway" }
  ]) {
    assert.equal(isRetiredReleaseArtifact(artifact), false);
  }
});

test("builds every OCI deployable from the owning cell image job", async () => {
  for (const cell of ["platform", "nova", "lumen", "pulso"]) {
    const catalog = await readCatalog(cell);
    const catalogDeployables = catalog.components
      .filter((component) => component.distribution === "oci")
      .flatMap((component) => composeServicesForComponent(component))
      .sort();
    assert.deepEqual([...CELL_COMPOSE_SERVICES[cell]].sort(), catalogDeployables, `${cell} image coverage drifted`);
  }
});

test("pins all Access migration one-shots to one provider-owned OCI component", async () => {
  const catalog = await readCatalog("platform");
  const migrator = catalog.components.find((component) => component.id === "access-migrations");
  assert.equal(migrator.sourcePath, "packages/access-migrations");
  assert.equal(buildServiceForComponent(migrator), "access-migrations");
  assert.deepEqual(composeServicesForComponent(migrator), [
    "access-database-bootstrap",
    "access-migrations",
    "access-role-bootstrap"
  ]);
  assert.equal(
    catalog.components.filter((component) => component.imageRepository === migrator.imageRepository).length,
    1
  );

  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "releases/manifests/platform/0.3.0-dev.0.json"), "utf8")
  );
  const pinned = manifest.components.filter((component) => component.id === migrator.id);
  assert.equal(pinned.length, 1);
  assert.match(pinned[0].image, /^ghcr\.io\/administracionhyperion\/access-migrations@sha256:[a-f0-9]{64}$/);
  assert.equal(
    manifest.components.some((component) =>
      ["access-database-bootstrap", "access-role-bootstrap"].includes(component.id)
    ),
    false
  );

  const composePlan = spawnSync(process.execPath, ["scripts/ci/cell-compose-plan.mjs", "platform", "services"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(composePlan.status, 0, composePlan.stderr);
  assert.deepEqual(composePlan.stdout.trim().split(/\s+/), CELL_COMPOSE_SERVICES.platform);
  assert.match(composePlan.stdout, /\baccess-database-bootstrap access-migrations access-role-bootstrap\b/);
});

test("pins all Audit migration one-shots to one provider-owned OCI component", async () => {
  const catalog = await readCatalog("platform");
  const migrator = catalog.components.find((component) => component.id === "audit-migrations");
  assert.equal(migrator.sourcePath, "packages/audit-migrations");
  assert.equal(buildServiceForComponent(migrator), "audit-migrations");
  assert.deepEqual(composeServicesForComponent(migrator), [
    "audit-database-bootstrap",
    "audit-migrations",
    "audit-role-bootstrap"
  ]);
  assert.equal(
    catalog.components.filter((component) => component.imageRepository === migrator.imageRepository).length,
    1
  );

  const generated = generateManifest(catalog, {
    releaseVersion: "0.1.0-dev.1",
    generatedAt: "2026-07-18T18:00:00Z"
  });
  assert.equal(generated.components.filter((component) => component.id === "audit-migrations").length, 1);
  assert.equal(
    generated.components.some((component) =>
      ["audit-database-bootstrap", "audit-role-bootstrap"].includes(component.id)
    ),
    false
  );
});

test("pins all LUMEN migration one-shots to one provider-owned OCI component", async () => {
  const catalog = await readCatalog("lumen");
  const migrator = catalog.components.find((component) => component.id === "lumen-migrations");
  assert.equal(migrator.sourcePath, "packages/lumen-migrations");
  assert.equal(buildServiceForComponent(migrator), "lumen-migrations");
  assert.deepEqual(composeServicesForComponent(migrator), [
    "lumen-database-bootstrap",
    "lumen-migrations",
    "lumen-role-bootstrap"
  ]);
  assert.equal(
    catalog.components.filter((component) => component.imageRepository === migrator.imageRepository).length,
    1
  );

  const generated = generateManifest(catalog, {
    releaseVersion: "1.1.0-dev.0",
    generatedAt: "2026-07-17T03:30:00Z"
  });
  assert.equal(generated.components.filter((component) => component.id === "lumen-migrations").length, 1);
  assert.equal(
    generated.components.some((component) =>
      ["lumen-database-bootstrap", "lumen-role-bootstrap"].includes(component.id)
    ),
    false
  );
});

test("pins all PULSO migration one-shots to one provider-owned OCI component", async () => {
  const catalog = await readCatalog("pulso");
  const migrator = catalog.components.find((component) => component.id === "pulso-migrations");
  assert.equal(migrator.sourcePath, "packages/pulso-migrations");
  assert.equal(buildServiceForComponent(migrator), "pulso-migrations");
  assert.deepEqual(composeServicesForComponent(migrator), [
    "pulso-database-bootstrap",
    "pulso-migrations",
    "pulso-role-bootstrap"
  ]);
  assert.equal(
    catalog.components.filter((component) => component.imageRepository === migrator.imageRepository).length,
    1
  );

  const generated = generateManifest(catalog, {
    releaseVersion: "1.1.0-dev.0",
    generatedAt: "2026-07-18T10:00:00Z"
  });
  assert.equal(generated.components.filter((component) => component.id === "pulso-migrations").length, 1);
  assert.equal(
    generated.components.some((component) =>
      ["pulso-database-bootstrap", "pulso-role-bootstrap"].includes(component.id)
    ),
    false
  );
});

test("keeps both JSON schemas parseable and closed to unknown properties", async () => {
  for (const name of ["release-catalog.schema.json", "release-manifest.schema.json"]) {
    const schema = JSON.parse(await readFile(path.join(repositoryRoot, "releases", "schemas", name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.$defs.component.additionalProperties, false);
  }
});

test("runs release tests and validation in pull-request and full-stack CI", async () => {
  for (const workflow of ["_cell-ci.yml", "check.yml"]) {
    const contents = await readFile(path.join(repositoryRoot, ".github", "workflows", workflow), "utf8");
    assert.match(contents, /run: pnpm release:test/);
    assert.match(contents, /run: pnpm release:check/);
  }
});

test("requires every image to use an OCI sha256 digest instead of a tag", async () => {
  const catalog = await readCatalog("lumen");
  const manifest = generateManifest(catalog, {
    releaseVersion: "0.2.0-dev.0",
    generatedAt: "2026-07-17T01:00:00Z"
  });
  manifest.components[0].image = "ghcr.io/administracionhyperion/lumen-service:0.1.0";
  const errors = validateManifest(manifest, catalog);
  assert.match(errors.join("\n"), /pinned by sha256 digest/);
  assert.equal(parseOciImageReference(manifest.components[0].image), null);
});

test("requires an explicit SemVer for every component and matches the catalog", async () => {
  const catalog = await readCatalog("lumen");
  const missing = generateManifest(catalog, {
    releaseVersion: "0.2.0-dev.0",
    generatedAt: "2026-07-17T01:00:00Z"
  });
  delete missing.components[0].version;
  assert.match(validateManifest(missing, catalog).join("\n"), /version must be SemVer/);

  const drifted = generateManifest(catalog, {
    releaseVersion: "0.2.0-dev.0",
    generatedAt: "2026-07-17T01:00:00Z"
  });
  drifted.components[0].version = "9.9.9";
  assert.match(validateManifest(drifted, catalog).join("\n"), /must equal catalog version 0\.1\.0/);
});

test("draft sentinels cannot be promoted as published image evidence", async () => {
  const catalog = await readCatalog("lumen");
  const manifest = generateManifest(catalog, {
    releaseVersion: "0.2.0-dev.0",
    generatedAt: "2026-07-17T01:00:00Z"
  });
  manifest.status = "published";
  manifest.imagesVerified = true;
  manifest.sourceRevision = "a".repeat(40);
  manifest.releasedAt = "2026-07-17T01:05:00Z";
  const errors = validateManifest(manifest, catalog);
  assert.match(errors.join("\n"), /unpublished draft digest/);
  assert.equal(
    manifest.components[0].image,
    draftImageReference(catalog.cell, catalog.catalogVersion, catalog.components[0])
  );
});

test("generates a publishable manifest only from explicit verified image digests", async () => {
  const catalog = await readCatalog("nova");
  const images = new Map(
    catalog.components
      .filter((component) => component.distribution === "oci")
      .map((component) => [
        component.id,
        `${component.imageRepository}@sha256:${createHash("sha256").update(`published:${component.id}`).digest("hex")}`
      ])
  );
  const manifest = generateManifest(catalog, {
    releaseVersion: "1.2.3",
    status: "published",
    generatedAt: "2026-07-17T02:00:00Z",
    releasedAt: "2026-07-17T02:05:00Z",
    sourceRevision: "b".repeat(40),
    imagesVerified: true,
    images
  });
  assert.deepEqual(validateManifest(manifest, catalog, { publishable: true }), []);
  assert.deepEqual(
    manifest.components.map((component) => component.id),
    catalog.components.map((component) => component.id)
  );
  assert.equal(
    manifest.components.find((component) => component.id === "nova-contracts")?.package,
    "@hyperion/nova-contracts@1.1.0"
  );
  assert.throws(
    () =>
      generateManifest(catalog, {
        releaseVersion: "1.2.3",
        status: "published",
        generatedAt: "2026-07-17T02:00:00Z",
        sourceRevision: "b".repeat(40),
        imagesVerified: true,
        images: new Map()
      }),
    /requires --image/
  );
});

test("pins provider-owned npm contracts to the catalog package and exact SemVer", async () => {
  const catalog = await readCatalog("platform");
  const manifest = generateManifest(catalog, {
    releaseVersion: "0.2.0-dev.0",
    generatedAt: "2026-07-17T02:30:00Z"
  });
  const contract = manifest.components.find((component) => component.id === "platform-contracts");
  assert.deepEqual(parseNpmPackageReference(contract.package), {
    packageName: "@hyperion/platform-contracts",
    version: "1.1.0"
  });

  contract.package = "@hyperion/platform-contracts@1.2.0";
  assert.match(validateManifest(manifest, catalog).join("\n"), /package version must be 1\.1\.0/);
});

test("matches catalog component and npm package versions to their package.json source", async () => {
  const catalog = structuredClone(await readCatalog("nova"));
  const contract = catalog.components.find((component) => component.id === "nova-contracts");
  contract.version = "9.9.9";
  const errors = validateCatalog(catalog, { root: repositoryRoot });
  assert.match(errors.join("\n"), /version must match packages\/nova-contracts\/package\.json \(1\.1\.0\)/);
});

test("keeps historical catalogs valid after the current source version advances", async () => {
  const historical = structuredClone(await readCatalog("nova"));
  historical.components.find((component) => component.id === "nova-contracts").version = "0.9.0";
  assert.deepEqual(validateCatalog(historical), []);
  assert.match(
    validateCatalog(historical, { root: repositoryRoot }).join("\n"),
    /version must match packages\/nova-contracts\/package\.json \(1\.1\.0\)/
  );
});

test("rejects catalog paths that escape the repository and unknown properties", async () => {
  const catalog = structuredClone(await readCatalog("lumen"));
  catalog.components[0].sourcePath = "../lumen-service";
  catalog.unreviewed = true;
  const errors = validateCatalog(catalog, { root: repositoryRoot });
  assert.match(errors.join("\n"), /unsupported property unreviewed/);
  assert.match(errors.join("\n"), /normalized repository-relative path/);
});

test("rejects duplicate OCI repositories and Compose aliases instead of publishing alias digests twice", async () => {
  const catalog = structuredClone(await readCatalog("platform"));
  const duplicate = structuredClone(catalog.components.find((component) => component.id === "access-migrations"));
  duplicate.id = "duplicate-migrations-alias";
  duplicate.buildService = "audit-role-bootstrap";
  duplicate.composeServices = ["audit-role-bootstrap"];
  duplicate.imageRepository = "ghcr.io/hyperionprivate/audit-migrations";
  catalog.components.push(duplicate);

  const errors = validateCatalog(catalog);
  assert.match(errors.join("\n"), /imageRepository duplicates audit-migrations/);
  assert.match(errors.join("\n"), /composeServices duplicates audit-role-bootstrap/);
});

test("generator and validator CLIs expose deterministic automation entrypoints", () => {
  const generated = spawnSync(
    process.execPath,
    [
      "scripts/releases/generate-release-manifest.mjs",
      "--cell",
      "lumen",
      "--catalog-version",
      "1.0.0",
      "--release-version",
      "0.3.0-dev.0",
      "--generated-at",
      "2026-07-17T03:00:00Z"
    ],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  assert.equal(generated.status, 0, generated.stderr);
  const manifest = JSON.parse(generated.stdout);
  assert.equal(manifest.cell, "lumen");
  assert.match(manifest.components[0].image, /@sha256:[0-9a-f]{64}$/);

  const validated = spawnSync(process.execPath, ["scripts/releases/validate-release-manifests.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /Validated 15 catalog\(s\) and 14 manifest\(s\)/);
});

async function readCatalog(cell) {
  const version = cell === "platform" ? "2.4.0" : cell === "pulso" ? "1.4.0" : "1.1.0";
  return JSON.parse(await readFile(path.join(repositoryRoot, "releases", "catalogs", cell, `${version}.json`), "utf8"));
}
