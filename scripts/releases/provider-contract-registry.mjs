import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_CONTRACTS,
  SNAPSHOT_FILE_SHA256,
  compareSemver,
  parseSemver,
  stableJson
} from "./provider-contract-compatibility.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_REVISION = /^(?!0{40}$)[a-f0-9]{40}$/;
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const VERIFIER = "npm-registry-history+sha512+gh-attestation";
const REPOSITORY_RESOLUTION_KEYS = ["kind", "proof"];
const PUBLISHED_RESOLUTION_KEYS = [
  "kind",
  "selection",
  "baselineVersion",
  "sourceRevision",
  "registryTarball",
  "integrity",
  "tarballSha256",
  "registryMetadataSha256",
  "builderId",
  "verifiedProvenanceSha256",
  "snapshotSha256",
  "verifiedSnapshotProvenanceSha256"
];
const EVIDENCE_KEYS = [
  "schemaVersion",
  "verifier",
  "purpose",
  "contractId",
  "packageName",
  "targetVersion",
  "sourceRepository",
  "registryOrigin",
  "registryPrincipal",
  "verifiedAt",
  "publishedVersions",
  "publishedVersionsSha256",
  "resolution"
];

export async function resolveProviderContractRegistry(options, root = repositoryRoot, execute = executeCommand) {
  validateOptions(options);
  const provider = PROVIDER_CONTRACTS[options.contract];
  const registryOrigin = normalizeRegistryOrigin(options.registryOrigin);
  const authenticationResult = execute("npm", ["whoami", "--registry", registryOrigin]);
  assertCommand(authenticationResult, "authenticated npm registry identity");
  const registryPrincipal = String(authenticationResult.stdout ?? "").trim();
  if (!validRegistryPrincipal(registryPrincipal)) {
    throw new Error("authenticated npm registry identity returned an invalid principal");
  }
  const historyResult = execute("npm", [
    "view",
    provider.packageName,
    "versions",
    "--json",
    "--registry",
    registryOrigin
  ]);

  let publishedVersions;
  let resolution;
  if (historyResult.status !== 0) {
    if (historyResult.error) {
      throw new Error(`registry history lookup could not execute: ${historyResult.error.message}`, {
        cause: historyResult.error
      });
    }
    if (!isRegistryNotFound(historyResult)) {
      throw new Error(
        `registry history lookup failed without proving package absence: ${commandDetail(historyResult)}`
      );
    }
    if (options.exactTarget) {
      throw new Error("exact-target snapshot capture requires the target version to exist in the registry");
    }
    publishedVersions = [];
    resolution = { kind: "repository-baseline", proof: "registry-404" };
  } else {
    publishedVersions = parsePublishedVersions(historyResult.stdout, provider.packageName);
    if (publishedVersions.length === 0) {
      throw new Error("a successful registry history response with no versions cannot prove first publication");
    }
    const selected = options.exactTarget
      ? resolveExactTargetVersion(publishedVersions, options.version)
      : resolvePublishedBaselineVersion(publishedVersions, options.version);
    if (selected.baselineVersion === null) {
      resolution = { kind: "repository-baseline", proof: selected.proof };
    } else {
      resolution = await verifyPublishedVersion(
        {
          contractId: options.contract,
          packageName: provider.packageName,
          version: selected.baselineVersion,
          selection: selected.selection,
          sourceRepository: options.sourceRepository,
          registryOrigin
        },
        root,
        execute
      );
    }
  }

  const evidence = {
    schemaVersion: 1,
    verifier: VERIFIER,
    purpose: options.exactTarget ? "snapshot-capture" : "compatibility",
    contractId: options.contract,
    packageName: provider.packageName,
    targetVersion: options.version,
    sourceRepository: options.sourceRepository,
    registryOrigin,
    registryPrincipal,
    verifiedAt: options.verifiedAt ?? new Date().toISOString(),
    publishedVersions,
    publishedVersionsSha256: sha256Bytes(canonicalJsonBytes(publishedVersions)),
    resolution
  };
  validateProviderContractRegistryEvidence(evidence, {
    contractId: options.contract,
    targetVersion: options.version,
    sourceRepository: options.sourceRepository,
    registryOrigin
  });

  const outputPath = path.resolve(root, options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.force ? "w" : "wx",
    mode: 0o600
  });
  return evidence;
}

export function resolvePublishedBaselineVersion(versions, targetVersion) {
  if (!parseSemver(targetVersion)) throw new Error(`target version ${String(targetVersion)} is not SemVer`);
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("published registry history must contain at least one version");
  }
  const normalized = normalizePublishedVersions(versions);
  const newer = normalized.filter((version) => compareSemver(version, targetVersion) > 0);
  if (newer.length > 0) {
    throw new Error(
      `target ${targetVersion} is older than published registry version ${newer.at(-1)}; versions cannot regress`
    );
  }
  const equalPrecedence = normalized.filter((version) => compareSemver(version, targetVersion) === 0);
  if (equalPrecedence.length > 0 && !normalized.includes(targetVersion)) {
    throw new Error(`registry contains a version with ambiguous SemVer precedence for ${targetVersion}`);
  }
  const previous = normalized.filter((version) => compareSemver(version, targetVersion) < 0).at(-1);
  if (!previous) {
    if (normalized.length === 1 && normalized[0] === targetVersion) {
      return {
        baselineVersion: null,
        selection: "repository-baseline",
        proof: "no-prior-published-version"
      };
    }
    throw new Error(`registry has versions but none is a valid predecessor of ${targetVersion}`);
  }
  return { baselineVersion: previous, selection: "n-minus-one" };
}

export function resolveExactTargetVersion(versions, targetVersion) {
  if (!parseSemver(targetVersion)) throw new Error(`target version ${String(targetVersion)} is not SemVer`);
  const normalized = normalizePublishedVersions(versions);
  const newer = normalized.filter((version) => compareSemver(version, targetVersion) > 0);
  if (newer.length > 0) {
    throw new Error(
      `target ${targetVersion} is older than published registry version ${newer.at(-1)}; versions cannot regress`
    );
  }
  if (!normalized.includes(targetVersion)) {
    throw new Error(`exact target ${targetVersion} is not published in the registry`);
  }
  return { baselineVersion: targetVersion, selection: "exact-target" };
}

export function validateProviderContractRegistryEvidence(evidence, expected = {}) {
  exactKeys(evidence, EVIDENCE_KEYS, "provider registry resolution");
  const provider = PROVIDER_CONTRACTS[evidence.contractId];
  if (
    evidence.schemaVersion !== 1 ||
    evidence.verifier !== VERIFIER ||
    !["compatibility", "snapshot-capture"].includes(evidence.purpose) ||
    !provider ||
    evidence.packageName !== provider.packageName ||
    !parseSemver(evidence.targetVersion) ||
    !SOURCE_REPOSITORY.test(evidence.sourceRepository ?? "") ||
    !validRegistryPrincipal(evidence.registryPrincipal) ||
    !Number.isFinite(Date.parse(evidence.verifiedAt))
  ) {
    throw new Error("provider registry resolution identity is invalid");
  }
  const registryOrigin = normalizeRegistryOrigin(evidence.registryOrigin);
  if (expected.contractId && evidence.contractId !== expected.contractId) {
    throw new Error(`registry resolution belongs to ${evidence.contractId}, not ${expected.contractId}`);
  }
  if (expected.targetVersion && evidence.targetVersion !== expected.targetVersion) {
    throw new Error(`registry resolution targets ${evidence.targetVersion}, not current ${expected.targetVersion}`);
  }
  if (expected.sourceRepository && evidence.sourceRepository !== expected.sourceRepository) {
    throw new Error("registry resolution source repository differs from the release input");
  }
  if (expected.registryOrigin && registryOrigin !== normalizeRegistryOrigin(expected.registryOrigin)) {
    throw new Error("registry resolution origin differs from the release input");
  }
  const publishedVersions = normalizePublishedVersions(evidence.publishedVersions);
  if (stableJson(publishedVersions) !== stableJson(evidence.publishedVersions)) {
    throw new Error("registry resolution publishedVersions must be unique and sorted by SemVer");
  }
  if (evidence.publishedVersionsSha256 !== sha256Bytes(canonicalJsonBytes(publishedVersions))) {
    throw new Error("registry resolution publishedVersionsSha256 does not match registry history");
  }

  let selected;
  if (evidence.purpose === "snapshot-capture") {
    selected = resolveExactTargetVersion(publishedVersions, evidence.targetVersion);
  } else if (publishedVersions.length === 0) {
    selected = { baselineVersion: null, selection: "repository-baseline", proof: "registry-404" };
  } else {
    selected = resolvePublishedBaselineVersion(publishedVersions, evidence.targetVersion);
  }
  if (selected.baselineVersion === null) {
    exactKeys(evidence.resolution, REPOSITORY_RESOLUTION_KEYS, "repository-baseline resolution");
    if (
      evidence.purpose !== "compatibility" ||
      evidence.resolution.kind !== "repository-baseline" ||
      evidence.resolution.proof !== selected.proof
    ) {
      throw new Error(
        "repository baseline is allowed only when authenticated registry history proves no prior published version"
      );
    }
    return evidence;
  }

  exactKeys(evidence.resolution, PUBLISHED_RESOLUTION_KEYS, "published-registry resolution");
  if (
    evidence.resolution.kind !== "published-registry" ||
    evidence.resolution.baselineVersion !== selected.baselineVersion ||
    evidence.resolution.selection !== selected.selection ||
    !SOURCE_REVISION.test(evidence.resolution.sourceRevision ?? "") ||
    !INTEGRITY.test(evidence.resolution.integrity ?? "") ||
    !SHA256.test(evidence.resolution.tarballSha256 ?? "") ||
    !SHA256.test(evidence.resolution.registryMetadataSha256 ?? "") ||
    !SHA256.test(evidence.resolution.verifiedProvenanceSha256 ?? "") ||
    typeof evidence.resolution.builderId !== "string" ||
    !evidence.resolution.builderId ||
    (selected.selection === "n-minus-one" &&
      (!SHA256.test(evidence.resolution.snapshotSha256 ?? "") ||
        !SHA256.test(evidence.resolution.verifiedSnapshotProvenanceSha256 ?? ""))) ||
    (selected.selection === "exact-target" &&
      (evidence.resolution.snapshotSha256 !== null || evidence.resolution.verifiedSnapshotProvenanceSha256 !== null))
  ) {
    throw new Error("published-registry resolution is invalid or does not select the real registry predecessor");
  }
  validateTarballUrl(evidence.resolution.registryTarball, registryOrigin);
  return evidence;
}

export function requireSnapshotForRegistryEvidence(snapshots, evidence, contractId, currentVersion) {
  validateProviderContractRegistryEvidence(evidence, { contractId, targetVersion: currentVersion });
  if (evidence.purpose !== "compatibility") {
    throw new Error(`${contractId}: snapshot-capture evidence cannot authorize an N-1 compatibility check`);
  }
  if (evidence.resolution.kind === "repository-baseline") {
    const repositories = snapshots.filter((snapshot) => snapshot.provenance?.kind === "repository-baseline");
    if (repositories.length !== snapshots.length || repositories.length === 0) {
      throw new Error(`${contractId}: first publication requires an immutable repository-baseline snapshot`);
    }
    const latest = [...repositories].sort((left, right) => compareSemver(left.version, right.version)).at(-1);
    if (compareSemver(latest.version, currentVersion) > 0) {
      throw new Error(`${contractId}: repository baseline ${latest.version} is newer than ${currentVersion}`);
    }
    return latest;
  }

  const expectedVersion = evidence.resolution.baselineVersion;
  const snapshot = snapshots.find((candidate) => candidate.version === expectedVersion);
  if (!snapshot) {
    throw new Error(`${contractId}: published-registry snapshot ${expectedVersion}.json is required`);
  }
  if (snapshot[SNAPSHOT_FILE_SHA256] !== evidence.resolution.snapshotSha256) {
    throw new Error(`${contractId}: snapshot ${expectedVersion} bytes differ from the verified snapshot attestation`);
  }
  const expectedProvenance = publishedSnapshotProvenance(evidence);
  if (stableJson(snapshot.provenance) !== stableJson(expectedProvenance)) {
    throw new Error(
      `${contractId}: snapshot ${expectedVersion} provenance does not match verified registry metadata/integrity/provenance`
    );
  }
  return snapshot;
}

export function publishedSnapshotProvenance(evidence) {
  validateProviderContractRegistryEvidence(evidence);
  if (evidence.resolution.kind !== "published-registry") {
    throw new Error("published snapshot provenance requires a verified published-registry resolution");
  }
  return {
    kind: "published-registry",
    published: true,
    sourceRepository: evidence.sourceRepository,
    sourceRevision: evidence.resolution.sourceRevision,
    registryOrigin: evidence.registryOrigin,
    registryTarball: evidence.resolution.registryTarball,
    integrity: evidence.resolution.integrity,
    tarballSha256: evidence.resolution.tarballSha256,
    registryMetadataSha256: evidence.resolution.registryMetadataSha256,
    builderId: evidence.resolution.builderId,
    verifiedProvenanceSha256: evidence.resolution.verifiedProvenanceSha256
  };
}

export function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyPublishedVersion(options, root, execute) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hyperion-provider-nminus1-"));
  try {
    const packageReference = `${options.packageName}@${options.version}`;
    const metadataResult = execute("npm", ["view", packageReference, "--json", "--registry", options.registryOrigin]);
    assertCommand(metadataResult, `registry metadata for ${packageReference}`);
    const metadata = parseJson(metadataResult.stdout, `${packageReference} registry metadata`);
    validateRegistryMetadata(metadata, options.packageName, options.version, options.registryOrigin);

    const packResult = execute("npm", [
      "pack",
      packageReference,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      directory,
      "--registry",
      options.registryOrigin
    ]);
    assertCommand(packResult, `download immutable tarball for ${packageReference}`);
    const packOutput = parseJson(packResult.stdout, `${packageReference} npm pack output`);
    if (!Array.isArray(packOutput) || packOutput.length !== 1) {
      throw new Error(`${packageReference} npm pack must return exactly one tarball`);
    }
    const packed = packOutput[0];
    if (
      !packed ||
      typeof packed.filename !== "string" ||
      path.basename(packed.filename) !== packed.filename ||
      packed.integrity !== metadata.dist.integrity
    ) {
      throw new Error(`${packageReference} npm pack output differs from registry integrity metadata`);
    }
    const tarballPath = path.join(directory, packed.filename);
    const tarballBytes = await readRegularFile(tarballPath, `${packageReference} tarball`);
    if (sha512Integrity(tarballBytes) !== metadata.dist.integrity) {
      throw new Error(`${packageReference} tarball bytes do not match registry SHA-512 integrity`);
    }
    const tarballSha256 = sha256Bytes(tarballBytes);

    const provenanceResult = execute("gh", [
      "attestation",
      "verify",
      tarballPath,
      "--repo",
      options.sourceRepository,
      "--signer-workflow",
      `${options.sourceRepository}/.github/workflows/publish-provider-contracts.yml`,
      "--signer-digest",
      metadata.gitHead,
      "--source-digest",
      metadata.gitHead,
      "--source-ref",
      "refs/heads/main",
      "--deny-self-hosted-runners",
      "--format",
      "json"
    ]);
    assertCommand(provenanceResult, `GitHub provenance for ${packageReference}`);
    const verified = selectVerifiedStatement(
      parseJson(provenanceResult.stdout, `${packageReference} GitHub provenance`),
      tarballSha256,
      metadata.gitHead
    );
    let snapshotSha256 = null;
    let verifiedSnapshotProvenanceSha256 = null;
    if (options.selection === "n-minus-one") {
      const snapshotPath = path.join(
        root,
        "fixtures",
        "contracts",
        "provider-owned",
        options.contractId,
        `${options.version}.json`
      );
      const snapshotBytes = await readRegularFile(snapshotPath, `${packageReference} published snapshot`);
      snapshotSha256 = sha256Bytes(snapshotBytes);
      const snapshotProvenanceResult = execute("gh", [
        "attestation",
        "verify",
        snapshotPath,
        "--repo",
        options.sourceRepository,
        "--signer-workflow",
        `${options.sourceRepository}/.github/workflows/publish-provider-contracts.yml`,
        "--signer-digest",
        metadata.gitHead,
        "--source-digest",
        metadata.gitHead,
        "--source-ref",
        "refs/heads/main",
        "--deny-self-hosted-runners",
        "--format",
        "json"
      ]);
      assertCommand(snapshotProvenanceResult, `GitHub snapshot provenance for ${packageReference}`);
      const verifiedSnapshot = selectVerifiedStatement(
        parseJson(snapshotProvenanceResult.stdout, `${packageReference} GitHub snapshot provenance`),
        snapshotSha256,
        metadata.gitHead
      );
      verifiedSnapshotProvenanceSha256 = sha256Bytes(canonicalJsonBytes(verifiedSnapshot.statement));
    }
    return {
      kind: "published-registry",
      selection: options.selection,
      baselineVersion: options.version,
      sourceRevision: metadata.gitHead,
      registryTarball: metadata.dist.tarball,
      integrity: metadata.dist.integrity,
      tarballSha256,
      registryMetadataSha256: sha256Bytes(canonicalRegistryMetadata(metadata)),
      builderId: verified.predicate.runDetails.builder.id,
      verifiedProvenanceSha256: sha256Bytes(canonicalJsonBytes(verified.statement)),
      snapshotSha256,
      verifiedSnapshotProvenanceSha256
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validateOptions(options) {
  if (!PROVIDER_CONTRACTS[options.contract]) throw new Error(`unknown provider contract: ${options.contract}`);
  if (!parseSemver(options.version)) throw new Error("--version must be exact SemVer");
  if (!SOURCE_REPOSITORY.test(options.sourceRepository ?? "")) {
    throw new Error("--source-repository must use owner/repository syntax");
  }
  normalizeRegistryOrigin(options.registryOrigin);
  if (typeof options.output !== "string" || !options.output) throw new Error("--output is required");
}

function parsePublishedVersions(stdout, packageName) {
  const parsed = parseJson(stdout, `${packageName} registry version history`);
  if (!Array.isArray(parsed)) {
    throw new Error(`${packageName} registry version history must be an array`);
  }
  return normalizePublishedVersions(parsed);
}

function normalizePublishedVersions(versions) {
  if (!Array.isArray(versions)) throw new Error("publishedVersions must be an array");
  const normalized = [];
  for (const version of versions) {
    if (typeof version !== "string" || !parseSemver(version)) {
      throw new Error(`registry history contains invalid SemVer ${String(version)}`);
    }
    if (normalized.includes(version)) throw new Error(`registry history contains duplicate version ${version}`);
    normalized.push(version);
  }
  return normalized.sort(compareSemver);
}

function validateRegistryMetadata(metadata, packageName, version, registryOrigin) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${packageName}@${version} registry metadata must be an object`);
  }
  if (metadata.name !== packageName || metadata.version !== version || !SOURCE_REVISION.test(metadata.gitHead ?? "")) {
    throw new Error(`${packageName}@${version} registry identity or gitHead is invalid`);
  }
  if (!INTEGRITY.test(metadata.dist?.integrity ?? "")) {
    throw new Error(`${packageName}@${version} registry metadata must provide SHA-512 integrity`);
  }
  validateTarballUrl(metadata.dist?.tarball, registryOrigin);
}

function validateTarballUrl(value, registryOrigin) {
  let tarball;
  try {
    tarball = new URL(value);
  } catch {
    throw new Error("registry tarball URL is invalid");
  }
  if (
    tarball.protocol !== "https:" ||
    tarball.username ||
    tarball.password ||
    tarball.search ||
    tarball.hash ||
    tarball.origin !== registryOrigin
  ) {
    throw new Error("registry tarball must stay on the authorized credential-free HTTPS registry origin");
  }
}

function selectVerifiedStatement(output, tarballSha256, sourceRevision) {
  const entries = Array.isArray(output) ? output : [output];
  for (const entry of entries) {
    const statement = (entry?.verificationResult ?? entry)?.statement;
    if (!statement || statement.predicateType !== "https://slsa.dev/provenance/v1") continue;
    if (!statement.subject?.some((subject) => subject?.digest?.sha256 === tarballSha256)) continue;
    const predicate = statement.predicate;
    if (
      !predicate?.buildDefinition?.resolvedDependencies?.some(
        (dependency) => dependency?.digest?.gitCommit === sourceRevision
      )
    ) {
      continue;
    }
    if (typeof predicate?.runDetails?.builder?.id !== "string" || !predicate.runDetails.builder.id) continue;
    return { statement, predicate };
  }
  throw new Error(`verified GitHub provenance does not bind the tarball to ${sourceRevision}`);
}

function normalizeRegistryOrigin(value) {
  let registry;
  try {
    registry = new URL(value);
  } catch {
    throw new Error("--registry-origin must be a valid HTTPS origin");
  }
  if (
    registry.protocol !== "https:" ||
    registry.username ||
    registry.password ||
    registry.search ||
    registry.hash ||
    registry.pathname !== "/"
  ) {
    throw new Error("--registry-origin must be a credential-free HTTPS origin without path, query or fragment");
  }
  return registry.origin;
}

function validRegistryPrincipal(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /\s/.test(value)) return false;
  return [...value].every((character) => {
    const code = character.codePointAt(0);
    return code > 31 && code !== 127;
  });
}

function canonicalRegistryMetadata(metadata) {
  return Buffer.from(
    `${JSON.stringify({
      name: metadata.name,
      version: metadata.version,
      gitHead: metadata.gitHead,
      dist: { integrity: metadata.dist.integrity, tarball: metadata.dist.tarball }
    })}\n`
  );
}

function canonicalJsonBytes(value) {
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
  return Buffer.from(`${JSON.stringify(normalize(value))}\n`);
}

async function readRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error(`${label} must be a non-empty regular file without symbolic links`);
  }
  if (metadata.size > MAX_TARBALL_BYTES) throw new Error(`${label} exceeds the 64 MiB safety limit`);
  return readFile(filePath);
}

function parseJson(value, label) {
  try {
    return JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (stableJson(Object.keys(value).sort()) !== stableJson([...keys].sort())) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}`);
  }
}

function isRegistryNotFound(result) {
  const detail = String(result.stderr ?? "");
  return /\bE404\b/i.test(detail) && /(?:404 Not Found|is not in this registry)/i.test(detail);
}

function assertCommand(result, label) {
  if (result.error) throw new Error(`${label} could not execute: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`${label} failed: ${commandDetail(result)}`);
}

function commandDetail(result) {
  return String(result.stderr || result.stdout || "unknown error").trim();
}

function executeCommand(command, arguments_) {
  return spawnSync(command, arguments_, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env
  });
}

function parseArguments(argv) {
  const options = { force: false, exactTarget: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--contract") options.contract = argv[++index];
    else if (argument === "--version") options.version = argv[++index];
    else if (argument === "--source-repository") options.sourceRepository = argv[++index];
    else if (argument === "--registry-origin") options.registryOrigin = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--verified-at") options.verifiedAt = argv[++index];
    else if (argument === "--exact-target") options.exactTarget = true;
    else if (argument === "--force") options.force = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const evidence = await resolveProviderContractRegistry(parseArguments(process.argv.slice(2)));
  process.stdout.write(`PROVIDER_REGISTRY_RESOLUTION=${evidence.resolution.kind}\n`);
  process.stdout.write(`PROVIDER_REGISTRY_BASELINE=${evidence.resolution.baselineVersion ?? "repository-baseline"}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
