import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkProviderArtifactCatalog,
  inspectProviderArtifactCatalog,
  validateNovaDependencySpec
} from "./check-provider-artifact-catalog.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const catalogPath = path.join(repositoryRoot, "releases", "registry", "provider-artifacts.v1.json");

async function catalogFixture() {
  return JSON.parse(await readFile(catalogPath, "utf8"));
}

test("catalogs a distinct N-1 for every provider contract and an exact NOVA extraction closure", async () => {
  const result = await inspectProviderArtifactCatalog({ repositoryRoot, catalogPath });
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.providerContracts, 5);
  assert.equal(result.summary.novaSourcePackages, 12);
  assert.deepEqual(result.summary.novaExternalArtifacts, [
    "@hyperion/audit-contracts",
    "@hyperion/database",
    "@hyperion/logger",
    "@hyperion/platform-contracts"
  ]);

  const workspace = await readFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /^linkWorkspacePackages: true$/m);
  assert.match(workspace, /^preferWorkspacePackages: true$/m);
});

test("fails closed if an N-1 catalog entry points at the current version", async () => {
  const catalog = await catalogFixture();
  const nova = catalog.artifacts.find((artifact) => artifact.packageName === "@hyperion/nova-contracts");
  nova.nMinusOneVersion = nova.currentVersion;
  const result = await inspectProviderArtifactCatalog({ repositoryRoot, catalog });
  assert.match(result.errors.join("\n"), /N-1 1\.1\.0 must be strictly older than current 1\.1\.0/);
  assert.match(result.errors.join("\n"), /exact N-1 snapshot 1\.1\.0 is missing/);
});

test("rejects cross-repository workspace protocols and non-exact SemVer", () => {
  const ownedPackages = new Map([["@hyperion/nova-config", "1.0.0"]]);
  const artifacts = new Map([
    ["@hyperion/platform-contracts", { currentVersion: "1.1.0" }],
    ["@hyperion/database", { currentVersion: "0.1.0" }]
  ]);
  assert.deepEqual(
    validateNovaDependencySpec({
      dependencyName: "@hyperion/nova-config",
      dependencySpec: "workspace:*",
      ownedPackages,
      artifacts
    }),
    []
  );
  assert.match(
    validateNovaDependencySpec({
      dependencyName: "@hyperion/platform-contracts",
      dependencySpec: "workspace:*",
      ownedPackages,
      artifacts
    }).join("\n"),
    /must use exact 1\.1\.0/
  );
  assert.match(
    validateNovaDependencySpec({
      dependencyName: "@hyperion/database",
      dependencySpec: "^0.1.0",
      ownedPackages,
      artifacts
    }).join("\n"),
    /must use exact 0\.1\.0/
  );
  assert.match(
    validateNovaDependencySpec({
      dependencyName: "@hyperion/unknown-shared",
      dependencySpec: "1.0.0",
      ownedPackages,
      artifacts
    }).join("\n"),
    /absent from the registry catalog/
  );
});

test("the extraction gate remains explicitly closed until registry readback is recorded", async () => {
  const inspected = await inspectProviderArtifactCatalog({ repositoryRoot, catalogPath, requirePublished: true });
  const errors = inspected.errors.join("\n");
  assert.match(errors, /blocked until @hyperion\/platform-contracts has verified published state/);
  assert.match(errors, /blocked until @hyperion\/audit-contracts has verified published state/);
  assert.match(errors, /blocked until @hyperion\/database has verified published state/);
  assert.match(errors, /blocked until @hyperion\/logger has verified published state/);
  await assert.rejects(
    checkProviderArtifactCatalog({ repositoryRoot, catalogPath, requirePublished: true }),
    /Provider artifact registry check failed/
  );
});

test("the extraction gate opens only with registry-bound evidence for every external artifact", async () => {
  const catalog = await catalogFixture();
  const required = new Set(catalog.novaExtraction.requiredExternalArtifacts);
  for (const artifact of catalog.artifacts.filter((candidate) => required.has(candidate.packageName))) {
    const packageId = artifact.packageName.split("/").at(-1);
    artifact.publication.state = "published";
    artifact.publication.registryEvidence = {
      schemaVersion: 1,
      verifier: "npm-registry-sha512+gh-attestation",
      packageName: artifact.packageName,
      version: artifact.currentVersion,
      sourceRepository: "HyperionPrivate/Plataforma-Hyperion",
      sourceRevision: "a".repeat(40),
      signerWorkflow: artifact.publication.workflow,
      registryOrigin: catalog.registryOrigin,
      integrity: "sha512-dmVyaWZpZWQ=",
      registryTarball: `${catalog.registryOrigin}/${artifact.packageName}/-/${packageId}-${artifact.currentVersion}.tgz`,
      tarballSha256: "b".repeat(64),
      builderId: "https://github.com/HyperionPrivate/Plataforma-Hyperion/.github/workflows/publish.yml",
      registryMetadataSha256: "c".repeat(64),
      verifiedProvenanceSha256: "d".repeat(64),
      verifiedAt: "2026-07-18T12:00:00.000Z"
    };
  }
  const result = await inspectProviderArtifactCatalog({ repositoryRoot, catalog, requirePublished: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.requirePublished, true);
});

test("requires the exact workflow and canonical tag pattern for each artifact kind", async () => {
  const catalog = await catalogFixture();
  const database = catalog.artifacts.find((artifact) => artifact.packageName === "@hyperion/database");
  database.publication.workflow = ".github/workflows/publish-provider-contracts.yml";
  database.publication.tagPattern = "contracts/database/v{version}";
  const result = await inspectProviderArtifactCatalog({ repositoryRoot, catalog });
  const errors = result.errors.join("\n");
  assert.match(errors, /publication workflow must equal \.github\/workflows\/publish-shared-libraries\.yml/);
  assert.match(errors, /publication tagPattern must equal shared\/database\/v\{version\}/);
});

test("published catalog evidence is cryptographically complete even though the offline gate does no network I/O", async () => {
  const catalog = await catalogFixture();
  const database = catalog.artifacts.find((artifact) => artifact.packageName === "@hyperion/database");
  database.publication.state = "published";
  database.publication.registryEvidence = {
    sourceRevision: "a".repeat(40),
    integrity: "sha512-dmVyaWZpZWQ=",
    registryTarball: `${catalog.registryOrigin}/@hyperion/database/-/database-0.1.0.tgz`,
    verifiedAt: "2026-07-18T12:00:00.000Z"
  };
  const result = await inspectProviderArtifactCatalog({ repositoryRoot, catalog });
  assert.match(result.errors.join("\n"), /exact registry readback fields/);
  assert.match(result.errors.join("\n"), /tarballSha256/);
  assert.match(result.errors.join("\n"), /verifiedProvenanceSha256/);
});
