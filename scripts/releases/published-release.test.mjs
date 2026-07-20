import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./generate-release-manifest.mjs";
import { preparePublishedRelease } from "./prepare-published-release.mjs";
import { validatePublishedRelease } from "./validate-published-release.mjs";
import { verifyImageProvenance } from "./verify-image-provenance.mjs";
import { MAX_NPM_TARBALL_BYTES, verifyNpmProvenance } from "./verify-npm-provenance.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRevision = "a".repeat(40);
const generatedAt = "2026-07-17T23:00:00.000Z";
const sourceRepository = "AdministracionHyperion/Plataforma-Hyperion";
const catalogVersion = "2.3.0";

function canonicalSha256(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, normalize(entry[key])])
      );
    }
    return entry;
  };
  return createHash("sha256")
    .update(`${JSON.stringify(normalize(value))}\n`)
    .digest("hex");
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "hyperion-published-release-"));
  const catalog = await loadCatalog(repositoryRoot, "platform", catalogVersion);
  const images = Object.fromEntries(
    catalog.components
      .filter((component) => component.distribution === "oci")
      .map((component) => [
        component.id,
        `${component.imageRepository}@sha256:${createHash("sha256").update(`published:${component.id}`).digest("hex")}`
      ])
  );
  const inventory = {
    schemaVersion: 1,
    cell: "platform",
    catalogVersion,
    sourceRevision,
    images
  };
  const inventoryPath = path.join(directory, "image-inventory.json");
  const manifestPath = path.join(directory, "manifest.json");
  const attestationPath = path.join(directory, "attestation.json");
  const inventoryBytes = `${JSON.stringify(inventory, null, 2)}\n`;
  await writeFile(inventoryPath, inventoryBytes);
  const registryVerification = {
    schemaVersion: 1,
    verifier: "gh-attestation+docker-registry-readback",
    sourceRepository,
    cell: "platform",
    catalogVersion,
    sourceRevision,
    verifiedAt: generatedAt,
    imageInventorySha256: createHash("sha256").update(inventoryBytes).digest("hex"),
    images: Object.fromEntries(
      Object.entries(images).map(([id, image]) => [
        id,
        {
          image,
          sourceRevision,
          builderId: "https://github.com/AdministracionHyperion/Plataforma-Hyperion/.github/workflows/build.yml",
          registryInspectionSha256: createHash("sha256").update(`registry:${id}`).digest("hex"),
          verifiedProvenanceSha256: createHash("sha256").update(`provenance:${id}`).digest("hex")
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
    cell: "platform",
    catalogVersion,
    sourceRevision,
    verifiedAt: generatedAt,
    packages: Object.fromEntries(
      catalog.components
        .filter((component) => component.distribution === "npm")
        .map((component) => [
          component.id,
          {
            package: `${component.packageName}@${component.version}`,
            registryTarball: `https://registry.npmjs.org/${component.packageName}/-/${component.id}-${component.version}.tgz`,
            integrity: `sha512-${Buffer.from(`integrity:${component.id}`).toString("base64")}`,
            tarballSha256: createHash("sha256").update(`tarball:${component.id}`).digest("hex"),
            sourceRevision,
            builderId: `https://github.com/${sourceRepository}/.github/workflows/publish-provider-contracts.yml`,
            registryMetadataSha256: createHash("sha256").update(`metadata:${component.id}`).digest("hex"),
            verifiedProvenanceSha256: createHash("sha256").update(`npm-provenance:${component.id}`).digest("hex")
          }
        ])
    )
  };
  const npmVerificationPath = path.join(directory, "npm-verification.json");
  await writeFile(npmVerificationPath, `${JSON.stringify(npmVerification, null, 2)}\n`);
  return {
    directory,
    inventory,
    inventoryPath,
    registryVerificationPath,
    npmVerificationPath,
    manifestPath,
    attestationPath
  };
}

async function prepare(testFixture) {
  return preparePublishedRelease(
    {
      cell: "platform",
      catalogVersion,
      releaseVersion: "1.2.3",
      sourceRevision,
      sourceRepository,
      imageInventory: testFixture.inventoryPath,
      registryVerification: testFixture.registryVerificationPath,
      npmVerification: testFixture.npmVerificationPath,
      manifestOutput: testFixture.manifestPath,
      attestationOutput: testFixture.attestationPath,
      generatedAt
    },
    repositoryRoot
  );
}

test("prepares and independently validates a published manifest from exact OCI digests", async (context) => {
  const testFixture = await fixture();
  context.after(() => rm(testFixture.directory, { recursive: true, force: true }));
  const prepared = await prepare(testFixture);
  assert.equal(prepared.manifest.status, "published");
  assert.equal(prepared.manifest.imagesVerified, true);
  assert.equal(prepared.manifest.sourceRevision, sourceRevision);
  const result = await validatePublishedRelease(
    {
      manifest: testFixture.manifestPath,
      imageInventory: testFixture.inventoryPath,
      registryVerification: testFixture.registryVerificationPath,
      npmVerification: testFixture.npmVerificationPath,
      attestation: testFixture.attestationPath,
      sourceRevision,
      sourceRepository,
      publishable: true
    },
    repositoryRoot
  );
  assert.equal(result.cell, "platform");
  assert.equal(result.releaseVersion, "1.2.3");
  assert.equal(result.imageCount, Object.keys(testFixture.inventory.images).length);
});

test("rejects a missing image or a mutable image tag before preparing publication", async (context) => {
  const missing = await fixture();
  context.after(() => rm(missing.directory, { recursive: true, force: true }));
  delete missing.inventory.images[Object.keys(missing.inventory.images)[0]];
  await writeFile(missing.inventoryPath, `${JSON.stringify(missing.inventory, null, 2)}\n`);
  await assert.rejects(() => prepare(missing), /must contain exactly/);

  const tagged = await fixture();
  context.after(() => rm(tagged.directory, { recursive: true, force: true }));
  const firstId = Object.keys(tagged.inventory.images)[0];
  tagged.inventory.images[firstId] = tagged.inventory.images[firstId].split("@")[0] + ":latest";
  await writeFile(tagged.inventoryPath, `${JSON.stringify(tagged.inventory, null, 2)}\n`);
  await assert.rejects(() => prepare(tagged), /must use a non-zero OCI SHA-256 digest/);
});

test("rejects attestation or inventory bytes changed after manifest generation", async (context) => {
  const testFixture = await fixture();
  context.after(() => rm(testFixture.directory, { recursive: true, force: true }));
  await prepare(testFixture);
  const attestation = JSON.parse(await readFile(testFixture.attestationPath, "utf8"));
  attestation.imageSetSha256 = "f".repeat(64);
  await writeFile(testFixture.attestationPath, `${JSON.stringify(attestation, null, 2)}\n`);
  await assert.rejects(
    () =>
      validatePublishedRelease(
        {
          manifest: testFixture.manifestPath,
          imageInventory: testFixture.inventoryPath,
          registryVerification: testFixture.registryVerificationPath,
          npmVerification: testFixture.npmVerificationPath,
          attestation: testFixture.attestationPath,
          sourceRevision,
          sourceRepository,
          publishable: true
        },
        repositoryRoot
      ),
    /image set differs/
  );
});

test("publication validator refuses to run without the explicit publishable gate", async (context) => {
  const testFixture = await fixture();
  context.after(() => rm(testFixture.directory, { recursive: true, force: true }));
  await prepare(testFixture);
  await assert.rejects(
    () =>
      validatePublishedRelease(
        {
          manifest: testFixture.manifestPath,
          imageInventory: testFixture.inventoryPath,
          registryVerification: testFixture.registryVerificationPath,
          npmVerification: testFixture.npmVerificationPath,
          attestation: testFixture.attestationPath,
          sourceRevision,
          sourceRepository
        },
        repositoryRoot
      ),
    /--publishable is required/
  );
});

test("registry verifier reads every digest and requires signed provenance for the source commit", async (context) => {
  const testFixture = await fixture();
  context.after(() => rm(testFixture.directory, { recursive: true, force: true }));
  const output = path.join(testFixture.directory, "verified-registry.json");
  const calls = [];
  const statements = new Map();
  const execute = (command, arguments_) => {
    calls.push([command, ...arguments_]);
    if (command === "docker") {
      const image = arguments_.at(-1);
      const digest = image.split("@sha256:")[1];
      return {
        status: 0,
        stdout: `Name: ${image}\nDigest: sha256:${digest}\nRunner diagnostic: ignored\n`,
        stderr: ""
      };
    }
    const image = arguments_[2].slice("oci://".length);
    const [repository, digest] = image.split("@sha256:");
    const statement = {
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{ name: repository, digest: { sha256: digest } }],
      predicate: {
        buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: sourceRevision } }] },
        runDetails: { builder: { id: `https://github.com/${sourceRepository}/.github/workflows/build.yml` } }
      }
    };
    statements.set(image, statement);
    return {
      status: 0,
      stderr: "",
      stdout: JSON.stringify([
        {
          verificationResult: {
            runnerDiagnostic: `ignored-${calls.length}`,
            statement
          }
        }
      ])
    };
  };
  const evidence = await verifyImageProvenance(
    {
      cell: "platform",
      catalogVersion,
      sourceRevision,
      sourceRepository,
      imageInventory: testFixture.inventoryPath,
      output,
      verifiedAt: generatedAt
    },
    repositoryRoot,
    execute
  );
  assert.equal(Object.keys(evidence.images).length, Object.keys(testFixture.inventory.images).length);
  assert.equal(calls.filter(([command]) => command === "docker").length, Object.keys(evidence.images).length);
  assert.equal(calls.filter(([command]) => command === "gh").length, Object.keys(evidence.images).length);
  for (const entry of Object.values(evidence.images)) {
    const digest = entry.image.split("@sha256:")[1];
    assert.equal(entry.registryInspectionSha256, canonicalSha256({ image: entry.image, digest: `sha256:${digest}` }));
    assert.equal(entry.verifiedProvenanceSha256, canonicalSha256(statements.get(entry.image)));
  }
  for (const call of calls.filter(([command]) => command === "gh")) {
    assert.ok(call.includes("--bundle-from-oci"));
    assert.deepEqual(call.slice(call.indexOf("--signer-workflow"), call.indexOf("--signer-workflow") + 2), [
      "--signer-workflow",
      `${sourceRepository}/.github/workflows/build-attested-cell-images.yml`
    ]);
    assert.deepEqual(call.slice(call.indexOf("--source-digest"), call.indexOf("--source-digest") + 2), [
      "--source-digest",
      sourceRevision
    ]);
    assert.ok(call.includes("--deny-self-hosted-runners"));
  }
});

test("registry verifier rejects a validly shaped attestation for a different commit", async (context) => {
  const testFixture = await fixture();
  context.after(() => rm(testFixture.directory, { recursive: true, force: true }));
  const execute = (command, arguments_) => {
    if (command === "docker") {
      const image = arguments_.at(-1);
      const digest = image.split("@sha256:")[1];
      return { status: 0, stdout: `Name: ${image}\nDigest: sha256:${digest}\n`, stderr: "" };
    }
    const image = arguments_[2].slice("oci://".length);
    const [repository, digest] = image.split("@sha256:");
    return {
      status: 0,
      stderr: "",
      stdout: JSON.stringify([
        {
          verificationResult: {
            statement: {
              predicateType: "https://slsa.dev/provenance/v1",
              subject: [{ name: repository, digest: { sha256: digest } }],
              predicate: {
                buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: "b".repeat(40) } }] },
                runDetails: { builder: { id: "https://github.com/example/build" } }
              }
            }
          }
        }
      ])
    };
  };
  await assert.rejects(
    () =>
      verifyImageProvenance(
        {
          cell: "platform",
          catalogVersion,
          sourceRevision,
          sourceRepository,
          imageInventory: testFixture.inventoryPath,
          output: path.join(testFixture.directory, "wrong-source.json")
        },
        repositoryRoot,
        execute
      ),
    /does not bind .* to a{40}/
  );
});

test("npm verifier downloads exact registry bytes and requires signed provenance for the source commit", async (context) => {
  const testFixture = await fixture();
  context.after(() => rm(testFixture.directory, { recursive: true, force: true }));
  const catalog = await loadCatalog(repositoryRoot, "platform", catalogVersion);
  const components = new Map(
    catalog.components
      .filter((component) => component.distribution === "npm")
      .map((component) => [`${component.packageName}@${component.version}`, component])
  );
  const calls = [];
  const statements = new Map();
  const execute = (command, arguments_) => {
    calls.push([command, ...arguments_]);
    if (command === "npm" && arguments_[0] === "view") {
      const component = components.get(arguments_[1]);
      const tarballBytes = Buffer.from(`registry-tarball:${component.id}`);
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          name: component.packageName,
          version: component.version,
          gitHead: sourceRevision,
          dist: {
            integrity: `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`,
            tarball: `https://registry.npmjs.org/${component.packageName}/-/${component.id}-${component.version}.tgz`
          }
        })
      };
    }
    if (command === "npm" && arguments_[0] === "pack") {
      const component = components.get(arguments_[1]);
      const tarballBytes = Buffer.from(`registry-tarball:${component.id}`);
      const filename = `${component.id}-${component.version}.tgz`;
      const directory = arguments_[arguments_.indexOf("--pack-destination") + 1];
      writeFileSync(path.join(directory, filename), tarballBytes);
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            filename,
            integrity: `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`
          }
        ])
      };
    }
    assert.equal(command, "gh");
    const tarballPath = arguments_[2];
    const digest = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    const statement = {
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [{ name: path.basename(tarballPath), digest: { sha256: digest } }],
      predicate: {
        buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: sourceRevision } }] },
        runDetails: {
          builder: {
            id: `https://github.com/${sourceRepository}/.github/workflows/publish-provider-contracts.yml`
          }
        }
      }
    };
    statements.set(path.basename(tarballPath), statement);
    return {
      status: 0,
      stderr: "",
      stdout: JSON.stringify([
        {
          verificationResult: {
            runnerDiagnostic: `ignored-${calls.length}`,
            statement
          }
        }
      ])
    };
  };
  const output = path.join(testFixture.directory, "verified-npm.json");
  const evidence = await verifyNpmProvenance(
    {
      cell: "platform",
      catalogVersion,
      sourceRevision,
      sourceRepository,
      registryOrigin: "https://registry.npmjs.org",
      output,
      verifiedAt: generatedAt
    },
    repositoryRoot,
    execute
  );
  assert.equal(Object.keys(evidence.packages).length, components.size);
  assert.equal(
    calls.filter(([command, operation]) => command === "npm" && operation === "view").length,
    components.size
  );
  assert.equal(
    calls.filter(([command, operation]) => command === "npm" && operation === "pack").length,
    components.size
  );
  assert.equal(calls.filter(([command]) => command === "gh").length, components.size);
  for (const [id, entry] of Object.entries(evidence.packages)) {
    const component = [...components.values()].find((candidate) => candidate.id === id);
    assert.equal(
      entry.verifiedProvenanceSha256,
      canonicalSha256(statements.get(`${component.id}-${component.version}.tgz`))
    );
  }
  for (const call of calls.filter(([command]) => command === "gh")) {
    assert.deepEqual(call.slice(call.indexOf("--signer-workflow"), call.indexOf("--signer-workflow") + 2), [
      "--signer-workflow",
      `${sourceRepository}/.github/workflows/publish-provider-contracts.yml`
    ]);
    assert.ok(call.includes("--source-digest"));
    assert.ok(call.includes("--deny-self-hosted-runners"));
  }
});

test("npm publication fails closed when an exact registry package is unavailable", async (context) => {
  const testFixture = await fixture();
  context.after(() => rm(testFixture.directory, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      verifyNpmProvenance(
        {
          cell: "platform",
          catalogVersion,
          sourceRevision,
          sourceRepository,
          registryOrigin: "https://registry.npmjs.org",
          output: path.join(testFixture.directory, "must-not-exist.json")
        },
        repositoryRoot,
        () => ({ status: 1, stdout: "", stderr: "npm ERR! 404 Not Found" })
      ),
    /registry metadata .* failed.*404 Not Found/
  );
});

test("npm publication rejects an oversized registry tarball before reading it into memory", async (context) => {
  const testFixture = await fixture();
  context.after(() => rm(testFixture.directory, { recursive: true, force: true }));
  const catalog = await loadCatalog(repositoryRoot, "platform", catalogVersion);
  const component = catalog.components.find((candidate) => candidate.distribution === "npm");
  const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  const execute = (command, arguments_) => {
    if (command === "npm" && arguments_[0] === "view") {
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          name: component.packageName,
          version: component.version,
          gitHead: sourceRevision,
          dist: {
            integrity,
            tarball: `https://registry.npmjs.org/${component.packageName}/-/${component.id}-${component.version}.tgz`
          }
        })
      };
    }
    if (command === "npm" && arguments_[0] === "pack") {
      const filename = `${component.id}-${component.version}.tgz`;
      const directory = arguments_[arguments_.indexOf("--pack-destination") + 1];
      const tarballPath = path.join(directory, filename);
      writeFileSync(tarballPath, Buffer.alloc(1));
      truncateSync(tarballPath, MAX_NPM_TARBALL_BYTES + 1);
      return { status: 0, stderr: "", stdout: JSON.stringify([{ filename, integrity }]) };
    }
    throw new Error(`unexpected command after oversized tarball: ${command}`);
  };
  await assert.rejects(
    () =>
      verifyNpmProvenance(
        {
          cell: "platform",
          catalogVersion,
          sourceRevision,
          sourceRepository,
          registryOrigin: "https://registry.npmjs.org",
          output: path.join(testFixture.directory, "must-not-exist.json")
        },
        repositoryRoot,
        execute
      ),
    /exceeds the 64 MiB safety limit/
  );
});

test("manual publication workflow pins source, validates publishable evidence, and uploads the sealed bundle", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/publish-release.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
  for (const input of [
    "cell",
    "catalog_version",
    "release_version",
    "source_revision",
    "image_inventory_json",
    "npm_registry_origin"
  ]) {
    assert.match(workflow, new RegExp(`^      ${input}:`, "m"));
  }
  assert.match(workflow, /REF_PROTECTED:\s*\$\{\{ github\.ref_protected \}\}/);
  assert.match(workflow, /REF_PROTECTED" != "true"/);
  assert.match(workflow, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(workflow, /GITHUB_SHA" != "\$SOURCE_REVISION"/);
  assert.match(workflow, /NPM_REGISTRY_ORIGIN:\s*\$\{\{ inputs\.npm_registry_origin \}\}/);
  assert.match(workflow, /url\.protocol!=="https:"/);
  const sourceGate = workflow.indexOf("Require the selected protected-main source");
  assert.ok(sourceGate < workflow.indexOf("Checkout exact release source"));
  assert.ok(sourceGate < workflow.indexOf("Setup Node"));
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.source_revision \}\}/);
  assert.match(workflow, /prepare-published-release\.mjs/);
  assert.match(workflow, /verify-image-provenance\.mjs/);
  assert.match(workflow, /verify-npm-provenance\.mjs/);
  assert.match(workflow, /docker login ghcr\.io/);
  assert.match(workflow, /registry-verification\.json/);
  assert.match(workflow, /npm-verification\.json/);
  const provenanceTool = await readFile(
    path.join(repositoryRoot, "scripts/releases/verify-image-provenance.mjs"),
    "utf8"
  );
  assert.match(provenanceTool, /"docker", \["buildx", "imagetools", "inspect", image\]/);
  assert.match(provenanceTool, /"gh", \[\s*"attestation",\s*"verify"/);
  assert.match(provenanceTool, /"--bundle-from-oci"/);
  assert.match(provenanceTool, /"--signer-workflow"/);
  assert.match(provenanceTool, /build-attested-cell-images\.yml/);
  assert.match(provenanceTool, /"--source-digest"/);
  assert.match(provenanceTool, /"--deny-self-hosted-runners"/);
  assert.match(provenanceTool, /resolvedDependencies/);
  assert.match(workflow, /validate-published-release\.mjs/);
  assert.match(workflow, /--publishable/);
  assert.match(workflow, /sha256sum --check SHA256SUMS/);
  assert.match(workflow, /reconcile-github-release\.mjs/);
  assert.match(workflow, /--source-repository "\$SOURCE_REPOSITORY"/);
  assert.match(workflow, /steps\.source\.outputs\.timestamp/);
  assert.doesNotMatch(workflow, /gh release delete/);
  const reconciler = await readFile(path.join(repositoryRoot, "scripts/releases/reconcile-github-release.mjs"), "utf8");
  assert.match(reconciler, /repos\/\$\{sourceRepository\}\/git\/ref\/tags/);
  assert.match(reconciler, /--verify-tag/);
  assert.match(reconciler, /release .* asset .* differs from the sealed local candidate/);
  assert.match(reconciler, /published release .* is missing immutable assets/);
  assert.doesNotMatch(reconciler, /--clobber|release", "delete/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /packages:\s*write/);
});
