import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SNAPSHOT_FILE_SHA256, createContractSnapshot, validateSnapshot } from "./provider-contract-compatibility.mjs";
import {
  publishedSnapshotProvenance,
  requireSnapshotForRegistryEvidence,
  resolveExactTargetVersion,
  resolveProviderContractRegistry,
  resolvePublishedBaselineVersion,
  sha256Bytes,
  sha512Integrity,
  validateProviderContractRegistryEvidence
} from "./provider-contract-registry.mjs";

const revision = "a".repeat(40);
const registryOrigin = "https://registry.example";
const sourceRepository = "hyperion/platform";

function repositorySnapshot(version = "1.0.0") {
  return createContractSnapshot({
    manifest: {
      name: "@hyperion/nova-contracts",
      version,
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      files: ["dist", "!dist/**/*.test.*"]
    },
    declarationFiles: { "dist/index.d.ts": "export declare const value: string;\n" },
    runtimeSchemas: {},
    provenance: { kind: "repository-baseline", published: false, sourceRevision: null }
  });
}

function commandResult(status, stdout = "", stderr = "") {
  return { status, stdout, stderr, error: undefined };
}

async function temporaryRoot(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-provider-registry-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function preparePublishedSnapshot(root, version, bytes = Buffer.from("attested snapshot fixture\n")) {
  const snapshotPath = path.join(root, "fixtures", "contracts", "provider-owned", "nova-contracts", `${version}.json`);
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, bytes);
  return { bytes, snapshotPath };
}

function publishedRunner(versions, options = {}) {
  const bytes = options.bytes ?? Buffer.from("verified provider contract tarball");
  const integrity = options.integrity ?? sha512Integrity(bytes);
  const commands = [];
  const execute = (command, args) => {
    commands.push([command, args]);
    if (command === "npm" && args[0] === "whoami") return commandResult(0, "release-bot\n");
    if (command === "npm" && args[0] === "view" && args[2] === "versions") {
      return commandResult(0, JSON.stringify(versions));
    }
    if (command === "npm" && args[0] === "view") {
      const version = args[1].split("@").at(-1);
      return commandResult(
        0,
        JSON.stringify({
          name: "@hyperion/nova-contracts",
          version,
          gitHead: revision,
          dist: {
            integrity,
            tarball: `${registryOrigin}/@hyperion/nova-contracts/-/nova-contracts-${version}.tgz`
          }
        })
      );
    }
    if (command === "npm" && args[0] === "pack") {
      const destination = args[args.indexOf("--pack-destination") + 1];
      const filename = "hyperion-nova-contracts.tgz";
      writeFileSync(path.join(destination, filename), bytes);
      return commandResult(0, JSON.stringify([{ filename, integrity }]));
    }
    if (command === "gh") {
      const subjectBytes = readFileSync(args[2]);
      const isTarball = args[2].endsWith(".tgz");
      const statement = {
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [
          {
            digest: {
              sha256: isTarball && options.subjectSha256 ? options.subjectSha256 : sha256Bytes(subjectBytes)
            }
          }
        ],
        predicate: {
          buildDefinition: {
            resolvedDependencies: [{ digest: { gitCommit: options.provenanceRevision ?? revision } }]
          },
          runDetails: {
            builder: { id: `${sourceRepository}/.github/workflows/publish-provider-contracts.yml` }
          }
        }
      };
      return commandResult(0, JSON.stringify([{ verificationResult: { statement } }]));
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  return { execute, commands, bytes };
}

function resolverOptions(root, version = "2.0.0") {
  return {
    contract: "nova-contracts",
    version,
    sourceRepository,
    registryOrigin,
    verifiedAt: "2026-07-18T12:00:00.000Z",
    output: path.join(root, "resolution.json")
  };
}

test("permits a repository baseline only when an exact registry 404 proves first publication", async (context) => {
  const root = await temporaryRoot(context);
  const evidence = await resolveProviderContractRegistry(resolverOptions(root, "1.0.0"), root, (command, args) =>
    command === "npm" && args[0] === "whoami"
      ? commandResult(0, "release-bot\n")
      : commandResult(1, "", "npm error code E404: is not in this registry")
  );
  assert.equal(evidence.resolution.kind, "repository-baseline");
  assert.equal(evidence.resolution.proof, "registry-404");
  assert.equal(evidence.registryPrincipal, "release-bot");
  assert.deepEqual(evidence.publishedVersions, []);
  assert.equal(
    requireSnapshotForRegistryEvidence([repositorySnapshot()], evidence, "nova-contracts", "1.0.0").version,
    "1.0.0"
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "resolution.json"), "utf8")), evidence);
});

test("does not reinterpret registry outages or successful empty histories as first publication", async (context) => {
  const outageRoot = await temporaryRoot(context);
  await assert.rejects(
    resolveProviderContractRegistry(resolverOptions(outageRoot, "1.0.0"), outageRoot, (command, args) =>
      command === "npm" && args[0] === "whoami" ? commandResult(0, "release-bot\n") : commandResult(1, "", "ECONNRESET")
    ),
    /without proving package absence/
  );
  const emptyRoot = await temporaryRoot(context);
  await assert.rejects(
    resolveProviderContractRegistry(resolverOptions(emptyRoot, "1.0.0"), emptyRoot, (command, args) =>
      command === "npm" && args[0] === "whoami" ? commandResult(0, "release-bot\n") : commandResult(0, "[]")
    ),
    /cannot prove first publication/
  );
});

test("rejects a masked 404 when registry authentication was not established", async (context) => {
  const root = await temporaryRoot(context);
  await assert.rejects(
    resolveProviderContractRegistry(resolverOptions(root, "1.0.0"), root, () =>
      commandResult(1, "", "npm error code E404: is not in this registry")
    ),
    /authenticated npm registry identity failed/
  );
});

test("selects and attests the real highest published predecessor", async (context) => {
  const root = await temporaryRoot(context);
  await preparePublishedSnapshot(root, "1.4.0");
  const runner = publishedRunner(["1.0.0", "1.4.0", "1.2.8"]);
  const evidence = await resolveProviderContractRegistry(resolverOptions(root), root, runner.execute);
  assert.deepEqual(evidence.publishedVersions, ["1.0.0", "1.2.8", "1.4.0"]);
  assert.equal(evidence.resolution.selection, "n-minus-one");
  assert.equal(evidence.resolution.baselineVersion, "1.4.0");
  assert.equal(evidence.resolution.integrity, sha512Integrity(runner.bytes));
  assert.equal(evidence.resolution.tarballSha256, sha256Bytes(runner.bytes));
  assert.deepEqual(runner.commands[0], ["npm", ["whoami", "--registry", registryOrigin]]);
  assert.ok(
    runner.commands.some(
      ([command, args]) =>
        command === "gh" &&
        args.includes("--deny-self-hosted-runners") &&
        args.includes("--source-ref") &&
        args.includes("refs/heads/main")
    )
  );
  validateProviderContractRegistryEvidence(evidence, {
    contractId: "nova-contracts",
    targetVersion: "2.0.0",
    sourceRepository,
    registryOrigin
  });
  assert.throws(
    () =>
      validateProviderContractRegistryEvidence(evidence, {
        contractId: "nova-contracts",
        targetVersion: "2.0.0",
        sourceRepository: "other/repository",
        registryOrigin
      }),
    /source repository differs/
  );
});

test("never confuses an already-published target with the real N-1", () => {
  assert.deepEqual(resolvePublishedBaselineVersion(["1.0.0", "1.1.0"], "1.1.0"), {
    baselineVersion: "1.0.0",
    selection: "n-minus-one"
  });
  assert.deepEqual(resolvePublishedBaselineVersion(["1.1.0"], "1.1.0"), {
    baselineVersion: null,
    selection: "repository-baseline",
    proof: "no-prior-published-version"
  });
  assert.deepEqual(resolveExactTargetVersion(["1.0.0", "1.1.0"], "1.1.0"), {
    baselineVersion: "1.1.0",
    selection: "exact-target"
  });
  assert.throws(
    () => resolvePublishedBaselineVersion(["1.0.0", "2.0.0"], "1.5.0"),
    /older than published registry version 2\.0\.0/
  );
});

test("allows repository baseline on a first-version replay only after proving there is no prior version", async (context) => {
  const root = await temporaryRoot(context);
  const runner = publishedRunner(["1.0.0"]);
  const evidence = await resolveProviderContractRegistry(resolverOptions(root, "1.0.0"), root, runner.execute);
  assert.equal(evidence.purpose, "compatibility");
  assert.deepEqual(evidence.resolution, {
    kind: "repository-baseline",
    proof: "no-prior-published-version"
  });
  assert.equal(
    requireSnapshotForRegistryEvidence([repositorySnapshot()], evidence, "nova-contracts", "1.0.0").version,
    "1.0.0"
  );
  assert.equal(
    runner.commands.some(([command]) => command === "gh"),
    false
  );
});

test("uses exact-target evidence only for post-readback snapshot capture", async (context) => {
  const root = await temporaryRoot(context);
  const runner = publishedRunner(["1.0.0", "1.1.0"]);
  const evidence = await resolveProviderContractRegistry(
    { ...resolverOptions(root, "1.1.0"), exactTarget: true },
    root,
    runner.execute
  );
  assert.equal(evidence.purpose, "snapshot-capture");
  assert.equal(evidence.resolution.selection, "exact-target");
  assert.equal(evidence.resolution.baselineVersion, "1.1.0");
  assert.throws(
    () => requireSnapshotForRegistryEvidence([], evidence, "nova-contracts", "1.1.0"),
    /snapshot-capture evidence cannot authorize/
  );
});

test("rejects tarball bytes that do not match registry integrity", async (context) => {
  const root = await temporaryRoot(context);
  const runner = publishedRunner(["1.0.0"], {
    integrity: sha512Integrity(Buffer.from("different bytes"))
  });
  await assert.rejects(
    resolveProviderContractRegistry(resolverOptions(root), root, runner.execute),
    /tarball bytes do not match/
  );
});

test("rejects successful-looking provenance that does not bind bytes and source revision", async (context) => {
  const wrongSourceRoot = await temporaryRoot(context);
  const wrongSource = publishedRunner(["1.0.0"], { provenanceRevision: "b".repeat(40) });
  await assert.rejects(
    resolveProviderContractRegistry(resolverOptions(wrongSourceRoot), wrongSourceRoot, wrongSource.execute),
    /does not bind the tarball/
  );
  const wrongSubjectRoot = await temporaryRoot(context);
  const wrongSubject = publishedRunner(["1.0.0"], { subjectSha256: "c".repeat(64) });
  await assert.rejects(
    resolveProviderContractRegistry(resolverOptions(wrongSubjectRoot), wrongSubjectRoot, wrongSubject.execute),
    /does not bind the tarball/
  );
});

test("requires a published-registry snapshot whose evidence matches byte-for-byte", async (context) => {
  const root = await temporaryRoot(context);
  await preparePublishedSnapshot(root, "1.0.0");
  const runner = publishedRunner(["1.0.0"]);
  const evidence = await resolveProviderContractRegistry(resolverOptions(root, "1.1.0"), root, runner.execute);
  const repositoryOnly = repositorySnapshot();
  Object.defineProperty(repositoryOnly, SNAPSHOT_FILE_SHA256, {
    value: evidence.resolution.snapshotSha256,
    enumerable: false
  });
  assert.throws(
    () => requireSnapshotForRegistryEvidence([repositoryOnly], evidence, "nova-contracts", "1.1.0"),
    /provenance does not match/
  );
  const base = repositorySnapshot();
  const published = createContractSnapshot({
    manifest: base.manifest,
    declarationFiles: base.declarationFiles,
    runtimeSchemas: base.runtimeSchemas,
    provenance: publishedSnapshotProvenance(evidence)
  });
  Object.defineProperty(published, SNAPSHOT_FILE_SHA256, {
    value: evidence.resolution.snapshotSha256,
    enumerable: false
  });
  assert.deepEqual(validateSnapshot(published, "@hyperion/nova-contracts"), []);
  assert.equal(requireSnapshotForRegistryEvidence([published], evidence, "nova-contracts", "1.1.0").version, "1.0.0");
  const forgedSurface = createContractSnapshot({
    manifest: base.manifest,
    declarationFiles: { "dist/index.d.ts": "export declare const forged: number;\n" },
    runtimeSchemas: base.runtimeSchemas,
    provenance: publishedSnapshotProvenance(evidence)
  });
  Object.defineProperty(forgedSurface, SNAPSHOT_FILE_SHA256, {
    value: sha256Bytes(Buffer.from(`${JSON.stringify(forgedSurface, null, 2)}\n`)),
    enumerable: false
  });
  assert.throws(
    () => requireSnapshotForRegistryEvidence([forgedSurface], evidence, "nova-contracts", "1.1.0"),
    /bytes differ from the verified snapshot attestation/
  );
  const tampered = structuredClone(published);
  Object.defineProperty(tampered, SNAPSHOT_FILE_SHA256, {
    value: evidence.resolution.snapshotSha256,
    enumerable: false
  });
  tampered.provenance.tarballSha256 = "f".repeat(64);
  assert.throws(
    () => requireSnapshotForRegistryEvidence([tampered], evidence, "nova-contracts", "1.1.0"),
    /provenance does not match/
  );
});
