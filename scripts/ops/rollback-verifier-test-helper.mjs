import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preparePublishedRelease } from "../releases/prepare-published-release.mjs";
import { compareSemver } from "../releases/release-model.mjs";
import { rollbackComponentPartitions } from "../releases/rollback-policy.mjs";
import { verifyCellRollback } from "./verify-cell-rollback-core.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const siblingCells = Object.freeze({ nova: "lumen", lumen: "pulso", pulso: "nova" });
const sourceRepository = "AdministracionHyperion/Plataforma-Hyperion";
const generatedAt = "2026-07-17T18:00:00.000Z";
const bundleEvidenceFiles = Object.freeze([
  "manifest.json",
  "image-inventory.json",
  "registry-verification.json",
  "npm-verification.json",
  "attestation.json"
]);

export function registerRollbackVerifierTests({ cell, expectedImageCount, expectedMigrationCount }) {
  const label = cell.toUpperCase();
  const verifier = path.join(repositoryRoot, "scripts", "ops", `verify-${cell}-rollback.mjs`);

  test(`verifies sealed published ${label} bundles while keeping the current control plane`, async (context) => {
    const fixture = await rollbackFixture(context, cell);
    const result = runVerifier(verifier, fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${label}_ROLLBACK_RUNTIME_RELEASE_VERSION=2\\.4\\.0`));
    assert.match(result.stdout, new RegExp(`${label}_ROLLBACK_CURRENT_RELEASE_VERSION=2\\.5\\.0`));
    assert.match(result.stdout, new RegExp(`${label}_ROLLBACK_RUNTIME_IMAGE_COUNT=${expectedImageCount}`));
    assert.match(result.stdout, new RegExp(`${label}_ROLLBACK_FORWARD_ONLY_IMAGE_COUNT=1`));
    assert.match(result.stdout, new RegExp(`${label}_ROLLBACK_CURRENT_MIGRATION_COUNT=${expectedMigrationCount}`));
    assert.match(result.stdout, new RegExp(`${label}_ROLLBACK_CURRENT_POLICY_SHA256=[a-f0-9]{64}`));
    assert.match(result.stdout, new RegExp(`${label}_ROLLBACK_RUNTIME_BUNDLE_INDEX_SHA256=[a-f0-9]{64}`));
    assert.match(result.stdout, new RegExp(`${label}_ROLLBACK_FORWARD_ONLY_IMAGE_SET_SHA256=[a-f0-9]{64}`));
  });

  test(`rejects mutable tags and divergent ${label} runtime digests`, async (context) => {
    const tagged = await rollbackFixture(context, cell, (observation, catalog, partitions) => {
      const id = partitions.rollbackOciComponents[0];
      const component = catalog.components.find((entry) => entry.id === id);
      observation.rollbackImages[id] = `${component.imageRepository}:2.4.0`;
    });
    assert.match(runVerifier(verifier, tagged).stderr, /not pinned by an OCI SHA-256 digest/);

    const drifted = await rollbackFixture(context, cell, (observation, _catalog, partitions) => {
      observation.rollbackImages[partitions.rollbackOciComponents[0]] =
        `ghcr.io/administracionhyperion/forged@sha256:${"f".repeat(64)}`;
    });
    assert.match(runVerifier(verifier, drifted).stderr, /repository .* is not owned|does not match its sealed/);
  });

  test(`rejects foreign and incomplete ${label} runtime inventories`, async (context) => {
    const foreign = await rollbackFixture(context, cell, (observation) => {
      observation.rollbackImages["platform-admin-console"] =
        `ghcr.io/administracionhyperion/platform-admin-console@sha256:${"e".repeat(64)}`;
    });
    assert.match(runVerifier(verifier, foreign).stderr, /non-allowlisted component/);

    const incomplete = await rollbackFixture(context, cell, (observation) => {
      delete observation.rollbackImages[Object.keys(observation.rollbackImages)[0]];
    });
    assert.match(runVerifier(verifier, incomplete).stderr, /rollback runtime image inventory is missing/);
  });

  test(`never rolls back the ${label} migrator or role-bootstrap image`, async (context) => {
    const drifted = await rollbackFixture(context, cell, (observation, _catalog, partitions) => {
      const id = partitions.forwardOnlyOciComponents[0];
      observation.forwardOnlyImages[id] = observation.forwardOnlyImages[id].replace(/[a-f0-9]{64}$/, "f".repeat(64));
    });
    assert.match(runVerifier(verifier, drifted).stderr, /current forward-only control-plane image digest/);

    const misplaced = await rollbackFixture(context, cell, (observation, _catalog, partitions) => {
      const id = partitions.forwardOnlyOciComponents[0];
      observation.rollbackImages[id] = observation.forwardOnlyImages[id];
    });
    assert.match(runVerifier(verifier, misplaced).stderr, /rollback runtime image inventory contains non-allowlisted/);
  });

  test(`rejects a changed bundle checksum index or non-exact ${label} confirmation`, async (context) => {
    const fixture = await rollbackFixture(context, cell);
    const checksumPath = path.join(fixture.rollbackBundlePath, "SHA256SUMS");
    const checksum = await readFile(checksumPath, "utf8");
    await writeFile(checksumPath, checksum.replace(/^[a-f0-9]{64}/, "e".repeat(64)));
    const wrongChecksum = runVerifier(verifier, fixture);
    assert.notEqual(wrongChecksum.status, 0);
    assert.match(wrongChecksum.stderr, /SHA256SUMS does not seal manifest\.json/);

    await writeBundleChecksums(fixture.rollbackBundlePath);
    const wrongConfirmation = runVerifier(verifier, { ...fixture, confirm: `ROLLBACK ${label}` });
    assert.notEqual(wrongConfirmation.status, 0);
    assert.match(wrongConfirmation.stderr, /--confirm must equal/);
  });

  test(`rejects a forged ${label} manifest even when its local checksum index is rewritten`, async (context) => {
    const fixture = await rollbackFixture(context, cell);
    const manifestPath = path.join(fixture.rollbackBundlePath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const runtime = manifest.components.find((component) => fixture.runtimeIds.includes(component.id));
    runtime.image = runtime.image.replace(/[a-f0-9]{64}$/, "f".repeat(64));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeBundleChecksums(fixture.rollbackBundlePath);
    const result = runVerifier(verifier, fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release attestation manifestSha256 does not match the manifest bytes/);
  });

  test(`rejects a draft ${label} manifest even when all bundle checksums are exact`, async (context) => {
    const fixture = await rollbackFixture(context, cell);
    const manifestPath = path.join(fixture.rollbackBundlePath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.status = "draft";
    manifest.imagesVerified = false;
    delete manifest.releasedAt;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeBundleChecksums(fixture.rollbackBundlePath);
    const result = runVerifier(verifier, fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /status is not published/);
  });

  test(`rejects extra or foreign migration changes outside the current ${label} provider manifest`, async (context) => {
    const fixture = await rollbackFixture(context, cell);
    const isolatedRoot = await copyRollbackRoot(context, fixture, cell);
    const migrationSql = path.join(isolatedRoot, "packages", `${cell}-migrations`, "sql");
    await writeFile(path.join(migrationSql, `999-${siblingCells[cell]}-foreign-change.sql`), "select 1;\n");
    await assert.rejects(
      verifyCellRollback(cell, fixtureOptions(fixture), isolatedRoot),
      /migration inventory differs from the rollback policy/
    );

    const foreignRoot = await copyRollbackRoot(context, fixture, cell);
    const catalogPath = catalogFile(foreignRoot, cell, fixture.catalogVersion);
    const policyPath = policyFile(foreignRoot, cell, fixture.catalogVersion);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    const migrator = catalog.components.find((component) => component.kind === "migrations");
    migrator.sourcePath = `packages/${siblingCells[cell]}-migrations`;
    migrator.versionSource = `${migrator.sourcePath}/package.json`;
    policy.migration.sourcePath = migrator.sourcePath;
    const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
    catalog.rollbackPolicySha256 = createHash("sha256").update(policyBytes).digest("hex");
    await mkdir(path.join(foreignRoot, migrator.sourcePath), { recursive: true });
    await writeFile(
      path.join(foreignRoot, migrator.versionSource),
      `${JSON.stringify({ version: migrator.version })}\n`
    );
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    await writeFile(policyPath, policyBytes);
    await assert.rejects(
      verifyCellRollback(cell, fixtureOptions(fixture), foreignRoot),
      new RegExp(`sourcePath must be packages/${cell}-migrations`)
    );
  });
}

async function rollbackFixture(context, cell, mutateObservation = () => {}) {
  const catalogVersion = await latestCatalogVersion(cell);
  const catalog = JSON.parse(await readFile(catalogFile(repositoryRoot, cell, catalogVersion), "utf8"));
  const policy = JSON.parse(await readFile(policyFile(repositoryRoot, cell, catalogVersion), "utf8"));
  const partitions = rollbackComponentPartitions(policy, catalog);
  const rollbackBundle = await createPublishedBundle(context, cell, catalog, "2.4.0", "b".repeat(40), "rollback");
  const currentBundle = await createPublishedBundle(context, cell, catalog, "2.5.0", "c".repeat(40), "current");
  const rollbackById = new Map(rollbackBundle.manifest.components.map((component) => [component.id, component]));
  const currentById = new Map(currentBundle.manifest.components.map((component) => [component.id, component]));
  const observation = {
    schemaVersion: 2,
    cell,
    rollbackReleaseVersion: rollbackBundle.manifest.releaseVersion,
    currentReleaseVersion: currentBundle.manifest.releaseVersion,
    rollbackImages: Object.fromEntries(partitions.rollbackOciComponents.map((id) => [id, rollbackById.get(id).image])),
    forwardOnlyImages: Object.fromEntries(
      partitions.forwardOnlyOciComponents.map((id) => [id, currentById.get(id).image])
    )
  };
  mutateObservation(observation, catalog, partitions);
  const observationPath = path.join(rollbackBundle.parentDirectory, "observed.json");
  await writeFile(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
  const rollbackManifestSha256 = sha256(await readFile(path.join(rollbackBundle.directory, "manifest.json")));
  const currentManifestSha256 = sha256(await readFile(path.join(currentBundle.directory, "manifest.json")));
  return {
    rollbackBundlePath: rollbackBundle.directory,
    currentBundlePath: currentBundle.directory,
    observationPath,
    catalogVersion,
    runtimeIds: [...partitions.rollbackOciComponents],
    confirm:
      `ROLLBACK ${cell.toUpperCase()} RUNTIMES ${rollbackBundle.manifest.releaseVersion} ` +
      `MANIFEST SHA256 ${rollbackManifestSha256} KEEP CONTROL PLANE ` +
      `${currentBundle.manifest.releaseVersion} MANIFEST SHA256 ${currentManifestSha256}`
  };
}

async function createPublishedBundle(context, cell, catalog, releaseVersion, sourceRevision, seed) {
  const parentDirectory = await mkdtemp(path.join(os.tmpdir(), `hyperion-${cell}-${seed}-bundle-`));
  context.after(() => rm(parentDirectory, { recursive: true, force: true }));
  const directory = path.join(parentDirectory, "release");
  await mkdir(directory);
  const images = Object.fromEntries(
    catalog.components
      .filter((component) => component.distribution === "oci")
      .map((component) => [
        component.id,
        `${component.imageRepository}@sha256:${createHash("sha256")
          .update(`${seed}:${cell}:${component.id}`)
          .digest("hex")}`
      ])
  );
  const inventory = {
    schemaVersion: 1,
    cell,
    catalogVersion: catalog.catalogVersion,
    sourceRevision,
    images
  };
  const inventoryPath = path.join(directory, "image-inventory.json");
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(inventoryPath, inventoryBytes);
  const registryVerification = {
    schemaVersion: 1,
    verifier: "gh-attestation+docker-registry-readback",
    sourceRepository,
    cell,
    catalogVersion: catalog.catalogVersion,
    sourceRevision,
    verifiedAt: generatedAt,
    imageInventorySha256: sha256(inventoryBytes),
    images: Object.fromEntries(
      Object.entries(images).map(([id, image]) => [
        id,
        {
          image,
          sourceRevision,
          builderId: `https://github.com/${sourceRepository}/.github/workflows/build-attested-cell-images.yml`,
          registryInspectionSha256: sha256(Buffer.from(`registry:${seed}:${id}`)),
          verifiedProvenanceSha256: sha256(Buffer.from(`provenance:${seed}:${id}`))
        }
      ])
    )
  };
  const registryVerificationPath = path.join(directory, "registry-verification.json");
  await writeFile(registryVerificationPath, `${JSON.stringify(registryVerification, null, 2)}\n`);
  const npmVerification = {
    schemaVersion: 1,
    verifier: "npm-registry-sha512+gh-attestation",
    sourceRepository,
    registryOrigin: "https://registry.npmjs.org",
    cell,
    catalogVersion: catalog.catalogVersion,
    sourceRevision,
    verifiedAt: generatedAt,
    packages: Object.fromEntries(
      catalog.components
        .filter((component) => component.distribution === "npm")
        .map((component) => [
          component.id,
          {
            package: `${component.packageName}@${component.version}`,
            registryTarball:
              `https://registry.npmjs.org/${component.packageName}/-/` + `${component.id}-${component.version}.tgz`,
            integrity: `sha512-${Buffer.from(`integrity:${seed}:${component.id}`).toString("base64")}`,
            tarballSha256: sha256(Buffer.from(`tarball:${seed}:${component.id}`)),
            sourceRevision,
            builderId: `https://github.com/${sourceRepository}/.github/workflows/publish-provider-contracts.yml`,
            registryMetadataSha256: sha256(Buffer.from(`metadata:${seed}:${component.id}`)),
            verifiedProvenanceSha256: sha256(Buffer.from(`npm-provenance:${seed}:${component.id}`))
          }
        ])
    )
  };
  const npmVerificationPath = path.join(directory, "npm-verification.json");
  await writeFile(npmVerificationPath, `${JSON.stringify(npmVerification, null, 2)}\n`);
  const prepared = await preparePublishedRelease(
    {
      cell,
      catalogVersion: catalog.catalogVersion,
      releaseVersion,
      sourceRevision,
      sourceRepository,
      imageInventory: inventoryPath,
      registryVerification: registryVerificationPath,
      npmVerification: npmVerificationPath,
      manifestOutput: path.join(directory, "manifest.json"),
      attestationOutput: path.join(directory, "attestation.json"),
      generatedAt,
      releasedAt: generatedAt
    },
    repositoryRoot
  );
  await writeBundleChecksums(directory);
  return { directory, parentDirectory, manifest: prepared.manifest };
}

async function writeBundleChecksums(directory) {
  const lines = [];
  for (const filename of bundleEvidenceFiles) {
    lines.push(`${sha256(await readFile(path.join(directory, filename)))}  ${filename}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

async function copyRollbackRoot(context, fixture, cell) {
  const root = await mkdtemp(path.join(os.tmpdir(), `hyperion-${cell}-rollback-root-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const catalogSource = catalogFile(repositoryRoot, cell, fixture.catalogVersion);
  const policySource = policyFile(repositoryRoot, cell, fixture.catalogVersion);
  const catalogTarget = catalogFile(root, cell, fixture.catalogVersion);
  const policyTarget = policyFile(root, cell, fixture.catalogVersion);
  const catalog = JSON.parse(await readFile(catalogSource, "utf8"));
  await mkdir(path.dirname(catalogTarget), { recursive: true });
  await mkdir(path.dirname(policyTarget), { recursive: true });
  await copyFile(catalogSource, catalogTarget);
  await copyFile(policySource, policyTarget);
  for (const component of catalog.components) {
    const sourceDirectory = path.join(repositoryRoot, component.sourcePath);
    const targetDirectory = path.join(root, component.sourcePath);
    await mkdir(targetDirectory, { recursive: true });
    await copyFile(path.join(sourceDirectory, "package.json"), path.join(targetDirectory, "package.json"));
  }
  const sqlSource = path.join(repositoryRoot, "packages", `${cell}-migrations`, "sql");
  const sqlTarget = path.join(root, "packages", `${cell}-migrations`, "sql");
  await mkdir(sqlTarget, { recursive: true });
  for (const entry of await readdir(sqlSource, { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(path.join(sqlSource, entry.name), path.join(sqlTarget, entry.name));
  }
  return root;
}

async function latestCatalogVersion(cell) {
  const entries = await readdir(path.join(repositoryRoot, "releases", "catalogs", cell), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort(compareSemver)
    .at(-1);
}

function catalogFile(root, cell, version) {
  return path.join(root, "releases", "catalogs", cell, `${version}.json`);
}

function policyFile(root, cell, version) {
  return path.join(root, "releases", "rollback-policies", cell, `${version}.json`);
}

function fixtureOptions(fixture) {
  return {
    rollbackBundle: fixture.rollbackBundlePath,
    currentBundle: fixture.currentBundlePath,
    observedImages: fixture.observationPath,
    confirm: fixture.confirm
  };
}

function runVerifier(verifier, fixture) {
  return spawnSync(
    process.execPath,
    [
      verifier,
      "--rollback-bundle",
      fixture.rollbackBundlePath,
      "--current-bundle",
      fixture.currentBundlePath,
      "--observed-images",
      fixture.observationPath,
      "--confirm",
      fixture.confirm
    ],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
