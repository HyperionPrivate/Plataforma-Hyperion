import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  packPublishableNpmArtifact,
  preflightExactNpmArtifact,
  removeOwnedTemporaryDirectory,
  validatePackedFileInventory,
  validatePublishableNpmManifest,
  verifyPublishedNpmArtifact,
  verifyPublishedNpmArtifactWithRetry
} from "./npm-artifact-publication.mjs";
import { verifyNovaProviderArtifactReadback } from "./verify-provider-artifact-readback.mjs";

const packageName = "@hyperion/example-shared";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const packTemporaryPrefix = "hyperion-npm-pack-staging-";
const readbackTemporaryPrefix = "hyperion-published-npm-artifact-";
const version = "1.2.3";
const sourceRevision = "a".repeat(40);
const sourceRepository = "HyperionPrivate/Plataforma-Hyperion";
const registryOrigin = "https://registry.npmjs.org";
const signerWorkflow = ".github/workflows/publish-shared-libraries.yml";
const remoteTarball = `${registryOrigin}/${packageName}/-/example-shared-${version}.tgz`;

function sha512(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function statement(bytes, revision = sourceRevision) {
  return {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: `example-shared-${version}.tgz`, digest: { sha256: sha256(bytes) } }],
    predicate: {
      buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: revision } }] },
      runDetails: {
        builder: { id: `https://github.com/${sourceRepository}/.github/workflows/publish-shared-libraries.yml` }
      }
    }
  };
}

function successfulReadbackRunner(bytes, calls = [], overrides = {}) {
  return (command, arguments_) => {
    calls.push([command, ...arguments_]);
    if (command === "npm" && arguments_[0] === "view") {
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          name: overrides.name ?? packageName,
          version: overrides.version ?? version,
          gitHead: overrides.gitHead ?? sourceRevision,
          dist: {
            integrity: overrides.integrity ?? sha512(bytes),
            tarball: overrides.tarball ?? remoteTarball
          }
        })
      };
    }
    if (command === "npm" && arguments_[0] === "pack") {
      const filename = `example-shared-${version}.tgz`;
      const destination = arguments_[arguments_.indexOf("--pack-destination") + 1];
      writeFileSync(path.join(destination, filename), overrides.remoteBytes ?? bytes);
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([{ filename, integrity: overrides.packIntegrity ?? sha512(bytes) }])
      };
    }
    assert.equal(command, "gh");
    return {
      status: 0,
      stderr: "",
      stdout: JSON.stringify([
        { verificationResult: { statement: overrides.statement ?? statement(overrides.remoteBytes ?? bytes) } }
      ])
    };
  };
}

function readbackOptions(localTarball) {
  return {
    packageName,
    version,
    sourceRevision,
    sourceRepository,
    signerWorkflow,
    registryOrigin,
    localTarball,
    verifiedAt: "2026-07-18T12:00:00.000Z"
  };
}

test("publishable manifests reject local protocols, unknown Hyperion dependencies and install hooks", () => {
  const artifactVersions = new Map([
    [packageName, version],
    ["@hyperion/platform-contracts", "1.1.0"]
  ]);
  assert.deepEqual(
    validatePublishableNpmManifest(
      {
        name: packageName,
        version,
        dependencies: { "@hyperion/platform-contracts": "1.1.0", zod: "^3.24.2" }
      },
      { packageName, version, artifactVersions }
    ),
    []
  );
  const errors = validatePublishableNpmManifest(
    {
      name: packageName,
      version,
      dependencies: {
        "@hyperion/platform-contracts": "workspace:*",
        "@hyperion/unknown": "1.0.0",
        local: "file:../local"
      },
      devDependencies: { linked: "link:../linked" },
      scripts: { postinstall: "node install.js" },
      publishConfig: { registry: "https://evil.example" }
    },
    { packageName, version, artifactVersions }
  ).join("\n");
  assert.match(errors, /must not use workspace protocol/);
  assert.match(errors, /must use exact SemVer/);
  assert.match(errors, /@hyperion\/unknown is absent/);
  assert.match(errors, /must not use file protocol/);
  assert.match(errors, /must not use link protocol/);
  assert.match(errors, /postinstall lifecycle/);
  assert.match(errors, /must not override/);
  assert.match(
    validatePublishableNpmManifest(
      { name: packageName, version },
      { packageName, version, artifactVersions, requiredGitHead: sourceRevision }
    ).join("\n"),
    /gitHead must equal/
  );
  assert.match(
    validatePublishableNpmManifest(
      { name: packageName, version, gitHead: "b".repeat(40) },
      { packageName, version, artifactVersions, requiredGitHead: sourceRevision }
    ).join("\n"),
    /gitHead must equal/
  );
});

test("publishable manifests reject every pack/publish hook and unsafe publishConfig transformation", () => {
  const artifactVersions = new Map([[packageName, version]]);
  assert.deepEqual(
    validatePublishableNpmManifest(
      { name: packageName, version, publishConfig: { access: "public", tag: "latest" } },
      { packageName, version, artifactVersions }
    ),
    []
  );
  for (const lifecycle of [
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "prepare",
    "prepack",
    "postpack",
    "prepublishOnly",
    "publish",
    "postpublish"
  ]) {
    const errors = validatePublishableNpmManifest(
      { name: packageName, version, scripts: { [lifecycle]: "node mutate.js" } },
      { packageName, version, artifactVersions }
    ).join("\n");
    assert.match(errors, new RegExp(`${lifecycle} lifecycle script`));
  }
  const errors = validatePublishableNpmManifest(
    {
      name: packageName,
      version,
      publishConfig: {
        registry: "https://evil.example",
        directory: "dist",
        executable: "node",
        provenance: true,
        access: "restricted",
        tag: "1.2.3"
      }
    },
    { packageName, version, artifactVersions }
  ).join("\n");
  assert.match(errors, /must not override the workflow-controlled registry/);
  assert.match(errors, /publishConfig\.directory is not allowed/);
  assert.match(errors, /publishConfig\.executable is not allowed/);
  assert.match(errors, /publishConfig\.provenance is not allowed/);
  assert.match(errors, /publishConfig\.access must equal public/);
  assert.match(errors, /publishConfig\.tag must be a safe lowercase npm tag/);
});

test("packed inventory is restricted to package.json and non-test dist outputs", () => {
  assert.deepEqual(
    validatePackedFileInventory([{ path: "package.json" }, { path: "dist/index.js" }, { path: "dist/index.d.ts" }]),
    []
  );
  const errors = validatePackedFileInventory([
    { path: "package.json" },
    { path: "dist/index.test.js" },
    { path: ".npmrc" },
    { path: "../secret.pem" }
  ]).join("\n");
  assert.match(errors, /sensitive or test path/);
  assert.match(errors, /non-publishable path: \.npmrc/);
  assert.match(errors, /unsafe path/);
});

test("all dependency groups reject npm aliases to Hyperion packages", () => {
  const artifactVersions = new Map([
    [packageName, version],
    ["@hyperion/platform-contracts", "1.1.0"]
  ]);
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
    assert.deepEqual(
      validatePublishableNpmManifest(
        {
          name: packageName,
          version,
          [group]: { "@hyperion/platform-contracts": "1.1.0" }
        },
        { packageName, version, artifactVersions }
      ),
      [],
      `${group} must accept the canonical package at its exact catalog version`
    );
    for (const alias of [
      "npm:@hyperion/platform-contracts@1.1.0",
      "npm:@hyperion/platform-contracts@^1.1.0",
      "npm:@hyperion/unknown@1.0.0",
      "npm:%40hyperion%2Fplatform-contracts@1.1.0"
    ]) {
      const errors = validatePublishableNpmManifest(
        { name: packageName, version, [group]: { platform: alias } },
        { packageName, version, artifactVersions }
      ).join("\n");
      assert.match(errors, new RegExp(`${group}\\.platform must not alias a Hyperion package`));
    }
  }
});

test("packs one real tarball and inspects the manifest outside the repository", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), packTemporaryPrefix));
  context.after(() => removeOwnedTemporaryDirectory(root, packTemporaryPrefix));
  const directory = path.join(root, "packages", "example-shared");
  const outputDirectory = path.join(root, "output");
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await writeFile(path.join(directory, "dist", "index.js"), "export const value = 1;\n");
  await writeFile(path.join(directory, "dist", "index.d.ts"), "export declare const value: number;\n");
  await writeFile(path.join(directory, "dist", "index.test.d.ts"), "export {};\n");
  const sourceManifestBytes = `${JSON.stringify(
    {
      name: packageName,
      version,
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      files: ["dist", "!dist/**/*.test.*"]
    },
    null,
    2
  )}\n`;
  await writeFile(path.join(directory, "package.json"), sourceManifestBytes);
  const catalog = {
    artifacts: [
      {
        packageName,
        kind: "shared-library",
        sourcePath: "packages/example-shared",
        currentVersion: version
      }
    ]
  };
  const result = await packPublishableNpmArtifact(
    {
      packageDirectory: "packages/example-shared",
      packageName,
      version,
      sourceRevision,
      outputDirectory,
      catalog
    },
    root
  );
  assert.equal(result.packedManifest.name, packageName);
  assert.equal(result.packedManifest.version, version);
  assert.equal(result.packedManifest.gitHead, sourceRevision);
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), sourceManifestBytes);
  assert.equal(
    result.packedFiles.some((file) => /\.test\./i.test(file)),
    false
  );
  assert.match(result.tarballSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.tarballBytes > 0);
  assert.equal((await readFile(result.tarballPath)).length, result.tarballBytes);

  await writeFile(path.join(directory, "dist", ".env"), "SECRET=must-not-pack\n");
  await assert.rejects(
    () =>
      packPublishableNpmArtifact(
        {
          packageDirectory: "packages/example-shared",
          packageName,
          version,
          sourceRevision,
          outputDirectory: path.join(root, "secret-output"),
          catalog
        },
        root
      ),
    /sensitive or test path/
  );
});

test(
  "all seven real catalog artifacts build and pack without compiled tests",
  { timeout: 120_000 },
  async (context) => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), packTemporaryPrefix));
    context.after(() => removeOwnedTemporaryDirectory(temporaryRoot, packTemporaryPrefix));
    const catalog = JSON.parse(
      await readFile(path.join(repositoryRoot, "releases", "registry", "provider-artifacts.v1.json"), "utf8")
    );
    assert.equal(catalog.artifacts.length, 7);
    for (const artifact of catalog.artifacts) {
      const build = spawnSync("pnpm", ["--filter", artifact.packageName, "build"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        shell: false,
        maxBuffer: 16 * 1024 * 1024
      });
      assert.ifError(build.error);
      assert.equal(build.status, 0, `${artifact.packageName} build failed:\n${build.stderr || build.stdout}`);
      const sourceManifestPath = path.join(repositoryRoot, artifact.sourcePath, "package.json");
      const sourceManifestBytes = await readFile(sourceManifestPath, "utf8");
      const result = await packPublishableNpmArtifact(
        {
          packageDirectory: artifact.sourcePath,
          packageName: artifact.packageName,
          version: artifact.currentVersion,
          sourceRevision,
          outputDirectory: path.join(temporaryRoot, artifact.packageName.split("/").at(-1)),
          catalog
        },
        repositoryRoot
      );
      assert.equal(result.packedManifest.gitHead, sourceRevision);
      assert.equal(
        result.packedFiles.some((file) => /\.test\./i.test(file)),
        false
      );
      assert.equal(await readFile(sourceManifestPath, "utf8"), sourceManifestBytes);
    }
  }
);

test("pack requires an exact non-zero lowercase source revision before touching the package", async () => {
  const base = {
    packageDirectory: "packages/does-not-exist",
    packageName,
    version,
    outputDirectory: "output"
  };
  await assert.rejects(() => packPublishableNpmArtifact(base), /--source-revision is required/);
  await assert.rejects(
    () => packPublishableNpmArtifact({ ...base, sourceRevision: "A".repeat(40) }),
    /non-zero lowercase 40-character Git SHA/
  );
  await assert.rejects(
    () => packPublishableNpmArtifact({ ...base, sourceRevision: "0".repeat(40) }),
    /non-zero lowercase 40-character Git SHA/
  );
});

test("pack rejects a lifecycle hook before any runner can execute or mutate dist", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), packTemporaryPrefix));
  context.after(() => removeOwnedTemporaryDirectory(root, packTemporaryPrefix));
  const directory = path.join(root, "packages", "hooked");
  const distPath = path.join(directory, "dist", "index.js");
  const markerPath = path.join(directory, "hook-ran");
  await mkdir(path.dirname(distPath), { recursive: true });
  await writeFile(distPath, "export const reviewed = true;\n");
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify({
      name: packageName,
      version,
      files: ["dist", "!dist/**/*.test.*"],
      scripts: {
        prepack:
          "node -e \"const fs=require('node:fs');fs.writeFileSync('hook-ran','yes');fs.writeFileSync('dist/index.js','mutated')\""
      }
    })}\n`
  );
  let runnerCalled = false;
  await assert.rejects(
    () =>
      packPublishableNpmArtifact(
        {
          packageDirectory: "packages/hooked",
          packageName,
          version,
          sourceRevision,
          outputDirectory: path.join(root, "output"),
          catalog: {
            artifacts: [
              {
                packageName,
                kind: "shared-library",
                sourcePath: "packages/hooked",
                currentVersion: version
              }
            ]
          }
        },
        root,
        () => {
          runnerCalled = true;
          throw new Error("runner must remain unreachable");
        }
      ),
    /prepack lifecycle script/
  );
  assert.equal(runnerCalled, false);
  assert.equal(await readFile(distPath, "utf8"), "export const reviewed = true;\n");
  await assert.rejects(() => lstat(markerPath), { code: "ENOENT" });
});

test("temporary cleanup accepts an owned mkdtemp basename and rejects a prefix collision", async (context) => {
  const owned = await mkdtemp(path.join(os.tmpdir(), packTemporaryPrefix));
  await removeOwnedTemporaryDirectory(owned, packTemporaryPrefix);
  await assert.rejects(() => lstat(owned), { code: "ENOENT" });

  const collision = await mkdtemp(path.join(os.tmpdir(), "hyperion-npm-pack-staging-collision-"));
  context.after(async () => {
    try {
      await rmdir(collision);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  });
  await assert.rejects(
    () => removeOwnedTemporaryDirectory(collision, packTemporaryPrefix),
    /refusing unsafe temporary cleanup/
  );
  assert.equal((await lstat(collision)).isDirectory(), true);
});

test("preflight authenticates first and treats only an unambiguous E404 as absent", () => {
  const calls = [];
  const absent = preflightExactNpmArtifact({ packageName, version, registryOrigin }, (command, arguments_) => {
    calls.push([command, ...arguments_]);
    if (arguments_[0] === "whoami") return { status: 0, stdout: "publisher\n", stderr: "" };
    return { status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" };
  });
  assert.equal(absent.alreadyPublished, false);
  assert.equal(calls[0][1], "whoami");
  assert.equal(calls[1][1], "view");
  assert.throws(
    () =>
      preflightExactNpmArtifact({ packageName, version, registryOrigin }, () => ({
        status: 1,
        stdout: "",
        stderr: "npm error code E401"
      })),
    /authenticated registry preflight failed/
  );
  assert.throws(
    () =>
      preflightExactNpmArtifact({ packageName, version, registryOrigin }, (_command, arguments_) =>
        arguments_[0] === "whoami"
          ? { status: 0, stdout: "publisher", stderr: "" }
          : { status: 1, stdout: "", stderr: "npm error code E403; upstream says 404 Not Found" }
      ),
    /without proving exact package absence/
  );
  assert.equal(
    preflightExactNpmArtifact({ packageName, version, registryOrigin }, (_command, arguments_) =>
      arguments_[0] === "whoami"
        ? { status: 0, stdout: "publisher", stderr: "" }
        : { status: 0, stdout: JSON.stringify(version), stderr: "" }
    ).alreadyPublished,
    true
  );
});

test("readback binds exact bytes, SHA-512, metadata and protected-main provenance", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), readbackTemporaryPrefix));
  context.after(() => removeOwnedTemporaryDirectory(directory, readbackTemporaryPrefix));
  const bytes = Buffer.from("immutable-shared-library-tarball");
  const localTarball = path.join(directory, "local.tgz");
  await writeFile(localTarball, bytes);
  const calls = [];
  const evidence = await verifyPublishedNpmArtifact(
    readbackOptions(localTarball),
    successfulReadbackRunner(bytes, calls)
  );
  assert.equal(evidence.registryTarball, remoteTarball);
  assert.equal(evidence.integrity, sha512(bytes));
  assert.equal(evidence.tarballSha256, sha256(bytes));
  assert.equal(evidence.signerWorkflow, signerWorkflow);
  const ghCall = calls.find(([command]) => command === "gh");
  assert.deepEqual(ghCall.slice(ghCall.indexOf("--signer-workflow"), ghCall.indexOf("--signer-workflow") + 2), [
    "--signer-workflow",
    `${sourceRepository}/${signerWorkflow}`
  ]);
  assert.ok(ghCall.includes("--deny-self-hosted-runners"));
  assert.deepEqual(ghCall.slice(ghCall.indexOf("--source-ref"), ghCall.indexOf("--source-ref") + 2), [
    "--source-ref",
    "refs/heads/main"
  ]);
});

test("readback rejects byte drift, wrong gitHead, cross-origin tarballs and irrelevant attestations", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), readbackTemporaryPrefix));
  context.after(() => removeOwnedTemporaryDirectory(directory, readbackTemporaryPrefix));
  const bytes = Buffer.from("expected-tarball");
  const localTarball = path.join(directory, "local.tgz");
  await writeFile(localTarball, bytes);
  await assert.rejects(
    () =>
      verifyPublishedNpmArtifact(
        readbackOptions(localTarball),
        successfulReadbackRunner(bytes, [], { remoteBytes: Buffer.from("different-tarball") })
      ),
    /bytes do not match SHA-512|differs byte-for-byte/
  );
  await assert.rejects(
    () =>
      verifyPublishedNpmArtifact(
        readbackOptions(localTarball),
        successfulReadbackRunner(bytes, [], { gitHead: "b".repeat(40) })
      ),
    /gitHead differs/
  );
  await assert.rejects(
    () =>
      verifyPublishedNpmArtifact(
        readbackOptions(localTarball),
        successfulReadbackRunner(bytes, [], { tarball: "https://evil.example/example-shared-1.2.3.tgz" })
      ),
    /exact version on the authorized HTTPS origin/
  );
  await assert.rejects(
    () =>
      verifyPublishedNpmArtifact(
        readbackOptions(localTarball),
        successfulReadbackRunner(bytes, [], { statement: statement(bytes, "b".repeat(40)) })
      ),
    /does not bind the tarball/
  );
});

test("bounded retry recovers from eventual registry consistency and then stops", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), readbackTemporaryPrefix));
  context.after(() => removeOwnedTemporaryDirectory(directory, readbackTemporaryPrefix));
  const bytes = Buffer.from("retry-tarball");
  const localTarball = path.join(directory, "local.tgz");
  await writeFile(localTarball, bytes);
  let metadataAttempts = 0;
  const success = successfulReadbackRunner(bytes);
  const waits = [];
  const evidence = await verifyPublishedNpmArtifactWithRetry(
    { ...readbackOptions(localTarball), attempts: 2, retryDelayMs: 7 },
    (command, arguments_) => {
      if (command === "npm" && arguments_[0] === "view" && metadataAttempts++ === 0) {
        return { status: 1, stdout: "", stderr: "npm error 404 Not Found" };
      }
      return success(command, arguments_);
    },
    async (milliseconds) => waits.push(milliseconds)
  );
  assert.equal(evidence.packageName, packageName);
  assert.deepEqual(waits, [7]);
  await assert.rejects(
    () =>
      verifyPublishedNpmArtifactWithRetry(
        { ...readbackOptions(localTarball), attempts: 2, retryDelayMs: 0 },
        () => ({ status: 1, stdout: "", stderr: "ECONNRESET registry unavailable" }),
        async () => undefined
      ),
    /failed after 2 attempt/
  );
});

test("NOVA live gate derives every signer from published catalog evidence and detects drift", async () => {
  const baseEvidence = {
    schemaVersion: 1,
    verifier: "npm-registry-sha512+gh-attestation",
    packageName,
    version,
    sourceRepository,
    sourceRevision,
    signerWorkflow,
    registryOrigin,
    registryTarball: remoteTarball,
    integrity: "sha512-ZXZpZGVuY2U=",
    tarballSha256: "b".repeat(64),
    builderId: "https://github.com/example/builder",
    registryMetadataSha256: "c".repeat(64),
    verifiedProvenanceSha256: "d".repeat(64),
    verifiedAt: "2026-07-18T12:00:00.000Z"
  };
  const catalog = {
    catalogVersion: "1.0.0",
    registryOrigin,
    artifacts: [
      {
        packageName,
        currentVersion: version,
        publication: { state: "published", workflow: signerWorkflow, registryEvidence: baseEvidence }
      }
    ],
    novaExtraction: { requiredExternalArtifacts: [packageName] }
  };
  const observed = await verifyNovaProviderArtifactReadback(
    { catalog, attempts: 1, retryDelayMs: 0 },
    async (options) => ({ ...baseEvidence, signerWorkflow: options.signerWorkflow })
  );
  assert.deepEqual(Object.keys(observed.artifacts), [packageName]);
  await assert.rejects(
    () =>
      verifyNovaProviderArtifactReadback({ catalog, attempts: 1, retryDelayMs: 0 }, async () => ({
        ...baseEvidence,
        tarballSha256: "e".repeat(64)
      })),
    /tarballSha256 differs/
  );
  await assert.rejects(
    () =>
      verifyNovaProviderArtifactReadback(
        {
          catalog: {
            ...catalog,
            artifacts: [
              { ...catalog.artifacts[0], publication: { ...catalog.artifacts[0].publication, state: "ready" } }
            ]
          }
        },
        async () => baseEvidence
      ),
    /not marked published/
  );
});
