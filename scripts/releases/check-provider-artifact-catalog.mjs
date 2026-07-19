import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cellForPackagePath } from "../architecture/cell-policy.mjs";
import { compareSemver, parseSemver, readVersionedSnapshots } from "./provider-contract-compatibility.mjs";
import { assertReleaseCell } from "./release-scope.mjs";

const defaultRepositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaultCatalogPath = path.join(defaultRepositoryRoot, "releases", "registry", "provider-artifacts.v1.json");
const dependencyGroups = ["dependencies", "optionalDependencies", "peerDependencies"];
const publicationStates = new Set(["ready", "pending-workflow", "published"]);
const artifactKinds = new Set(["provider-contract", "shared-library"]);
const shaPattern = /^(?!0{40}$)[0-9a-f]{40}$/;
const sha256Pattern = /^(?!0{64}$)[0-9a-f]{64}$/;
const integrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const sourceRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const publishedEvidenceKeys = Object.freeze([
  "schemaVersion",
  "verifier",
  "packageName",
  "version",
  "sourceRepository",
  "sourceRevision",
  "signerWorkflow",
  "registryOrigin",
  "registryTarball",
  "integrity",
  "tarballSha256",
  "builderId",
  "registryMetadataSha256",
  "verifiedProvenanceSha256",
  "verifiedAt"
]);

function normalizeRelative(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function resolveInside(repositoryRoot, relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`unsafe repository-relative path: ${String(relativePath)}`);
  }
  const resolved = path.resolve(repositoryRoot, ...normalized.split("/"));
  const root = `${path.resolve(repositoryRoot)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error(`path escapes repository root: ${relativePath}`);
  return resolved;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function providerPackageId(artifact) {
  return path.posix.basename(normalizeRelative(artifact.sourcePath));
}

function expectedPublicationWorkflow(artifact) {
  return artifact.kind === "provider-contract"
    ? ".github/workflows/publish-provider-contracts.yml"
    : ".github/workflows/publish-shared-libraries.yml";
}

function expectedTagPattern(artifact) {
  const prefix = artifact.kind === "provider-contract" ? "contracts" : "shared";
  return `${prefix}/${providerPackageId(artifact)}/v{version}`;
}

export function providerArtifactCell(artifact) {
  return cellForPackagePath(normalizeRelative(artifact?.sourcePath));
}

async function discoverWorkspacePackages(repositoryRoot, cell = null) {
  const packages = [];
  for (const parent of ["apps", "packages", "services"]) {
    const parentPath = path.join(repositoryRoot, parent);
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativePath = `${parent}/${entry.name}`;
      if (cell !== null && cellForPackagePath(relativePath) !== cell) continue;
      const manifestPath = path.join(parentPath, entry.name, "package.json");
      try {
        packages.push({ relativePath, manifest: await readJson(manifestPath) });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return packages;
}

export function validateNovaDependencySpec({ dependencyName, dependencySpec, ownedPackages, artifacts }) {
  const errors = [];
  if (!dependencyName.startsWith("@hyperion/")) return errors;
  if (ownedPackages.has(dependencyName)) {
    const ownedVersion = ownedPackages.get(dependencyName);
    if (dependencySpec !== "workspace:*" && dependencySpec !== ownedVersion) {
      errors.push(
        `${dependencyName} is NOVA-owned and must use workspace:* or exact ${ownedVersion}; received ${dependencySpec}`
      );
    }
    return errors;
  }
  const artifact = artifacts.get(dependencyName);
  if (!artifact) {
    errors.push(`${dependencyName} crosses the NOVA repository boundary but is absent from the registry catalog`);
  } else if (dependencySpec !== artifact.currentVersion) {
    errors.push(
      `${dependencyName} crosses the NOVA repository boundary and must use exact ${artifact.currentVersion}; received ${dependencySpec}`
    );
  }
  return errors;
}

export async function inspectProviderArtifactCatalog(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const catalogPath = path.resolve(options.catalogPath ?? defaultCatalogPath);
  const catalog = options.catalog ?? (await readJson(catalogPath));
  const cell = options.cell === undefined || options.cell === null ? null : assertReleaseCell(options.cell);
  const errors = [];
  const add = (condition, message) => {
    if (!condition) errors.push(message);
  };

  add(catalog.schemaVersion === 1, "catalog schemaVersion must equal 1");
  add(Boolean(parseSemver(catalog.catalogVersion)), "catalogVersion must be SemVer");
  add(validDate(catalog.updatedAt), "catalog updatedAt must be YYYY-MM-DD");
  try {
    const registry = new URL(catalog.registryOrigin);
    add(
      registry.protocol === "https:" &&
        !registry.username &&
        !registry.password &&
        !registry.search &&
        !registry.hash &&
        registry.pathname === "/",
      "registryOrigin must be a credential-free HTTPS origin"
    );
  } catch {
    errors.push("registryOrigin must be a valid URL");
  }

  const catalogArtifacts = Array.isArray(catalog.artifacts) ? catalog.artifacts : [];
  const scopedArtifacts =
    cell === null ? catalogArtifacts : catalogArtifacts.filter((artifact) => providerArtifactCell(artifact) === cell);
  const allArtifacts = new Map(
    catalogArtifacts
      .filter((artifact) => typeof artifact?.packageName === "string")
      .map((artifact) => [artifact.packageName, artifact])
  );
  const artifacts = new Map();
  const manifests = new Map();
  if (cell !== null && scopedArtifacts.length === 0) errors.push(`catalog has no release artifacts owned by ${cell}`);
  for (const artifact of scopedArtifacts) {
    const label = artifact.packageName ?? "<missing-package-name>";
    add(/^@hyperion\/[a-z0-9-]+$/.test(label), `${label}: packageName is invalid`);
    add(!artifacts.has(label), `${label}: duplicate registry artifact`);
    artifacts.set(label, artifact);
    add(artifactKinds.has(artifact.kind), `${label}: unsupported kind ${String(artifact.kind)}`);
    add(Boolean(artifact.owner), `${label}: owner is required`);
    add(Boolean(parseSemver(artifact.currentVersion)), `${label}: currentVersion must be SemVer`);
    let manifest;
    try {
      manifest = await readJson(path.join(resolveInside(repositoryRoot, artifact.sourcePath), "package.json"));
      manifests.set(label, manifest);
      add(manifest.name === label, `${label}: source manifest name differs`);
      add(manifest.version === artifact.currentVersion, `${label}: source version must equal catalog currentVersion`);
      add(
        manifest.repository?.directory === artifact.sourcePath,
        `${label}: repository.directory must equal sourcePath`
      );
      add((manifest.files ?? []).includes("dist"), `${label}: publishable files must include dist`);
      add(
        (manifest.files ?? []).includes("!dist/**/*.test.*"),
        `${label}: publishable files must exclude compiled tests`
      );
    } catch (error) {
      errors.push(`${label}: source manifest cannot be read (${error.message})`);
    }

    const publication = artifact.publication ?? {};
    add(publicationStates.has(publication.state), `${label}: publication state is invalid`);
    add(Boolean(publication.issue), `${label}: publication issue is required until registry readback is recorded`);
    add(validDate(publication.expiresOn), `${label}: publication expiresOn must be YYYY-MM-DD`);
    if (validDate(publication.expiresOn) && validDate(catalog.updatedAt)) {
      add(publication.expiresOn >= catalog.updatedAt, `${label}: publication exception is already expired`);
    }
    add(
      publication.tagPattern === expectedTagPattern(artifact),
      `${label}: publication tagPattern must equal ${expectedTagPattern(artifact)}`
    );
    if (publication.state === "ready") {
      add(
        publication.workflow === expectedPublicationWorkflow(artifact),
        `${label}: ready publication workflow must equal ${expectedPublicationWorkflow(artifact)}`
      );
    }
    if (publication.state === "pending-workflow") {
      add(publication.workflow === null, `${label}: pending-workflow must not claim a workflow`);
    }
    if (publication.state === "published") {
      const evidence = publication.registryEvidence ?? {};
      add(
        publication.workflow === expectedPublicationWorkflow(artifact),
        `${label}: published workflow must equal ${expectedPublicationWorkflow(artifact)}`
      );
      add(
        JSON.stringify(Object.keys(evidence).sort()) === JSON.stringify([...publishedEvidenceKeys].sort()),
        `${label}: published evidence must contain the exact registry readback fields`
      );
      add(evidence.schemaVersion === 1, `${label}: published evidence schemaVersion must equal 1`);
      add(
        evidence.verifier === "npm-registry-sha512+gh-attestation",
        `${label}: published evidence verifier is invalid`
      );
      add(evidence.packageName === label, `${label}: published evidence packageName differs`);
      add(evidence.version === artifact.currentVersion, `${label}: published evidence version differs`);
      add(
        sourceRepositoryPattern.test(evidence.sourceRepository ?? ""),
        `${label}: published evidence sourceRepository is invalid`
      );
      add(shaPattern.test(evidence.sourceRevision ?? ""), `${label}: published evidence needs sourceRevision`);
      add(
        evidence.signerWorkflow === publication.workflow,
        `${label}: published evidence signerWorkflow differs from the approved workflow`
      );
      add(evidence.registryOrigin === catalog.registryOrigin, `${label}: published evidence registryOrigin differs`);
      add(integrityPattern.test(evidence.integrity ?? ""), `${label}: published evidence needs npm integrity`);
      add(
        evidence.registryTarball ===
          `${catalog.registryOrigin.replace(/\/$/, "")}/${label}/-/${providerPackageId(artifact)}-${artifact.currentVersion}.tgz`,
        `${label}: published evidence tarball must be the exact immutable registry target`
      );
      add(sha256Pattern.test(evidence.tarballSha256 ?? ""), `${label}: published evidence needs tarballSha256`);
      add(typeof evidence.builderId === "string" && evidence.builderId.length > 0, `${label}: builderId is required`);
      add(
        sha256Pattern.test(evidence.registryMetadataSha256 ?? ""),
        `${label}: published evidence needs registryMetadataSha256`
      );
      add(
        sha256Pattern.test(evidence.verifiedProvenanceSha256 ?? ""),
        `${label}: published evidence needs verifiedProvenanceSha256`
      );
      add(
        Number.isFinite(Date.parse(evidence.verifiedAt ?? "")),
        `${label}: published evidence needs a valid verifiedAt`
      );
    }

    if (artifact.kind !== "provider-contract") continue;
    add(Boolean(parseSemver(artifact.nMinusOneVersion)), `${label}: nMinusOneVersion must be SemVer`);
    if (parseSemver(artifact.currentVersion) && parseSemver(artifact.nMinusOneVersion)) {
      add(
        compareSemver(artifact.nMinusOneVersion, artifact.currentVersion) < 0,
        `${label}: N-1 ${artifact.nMinusOneVersion} must be strictly older than current ${artifact.currentVersion}`
      );
    }
    try {
      const snapshots = await readVersionedSnapshots(
        path.join(repositoryRoot, "fixtures", "contracts", "provider-owned"),
        providerPackageId(artifact),
        label
      );
      const previous = snapshots.find((snapshot) => snapshot.version === artifact.nMinusOneVersion);
      add(Boolean(previous), `${label}: exact N-1 snapshot ${artifact.nMinusOneVersion} is missing`);
      add(
        previous?.provenance?.kind === "repository-baseline" || previous?.provenance?.kind === "published-registry",
        `${label}: N-1 snapshot provenance is invalid`
      );
    } catch (error) {
      errors.push(`${label}: N-1 snapshots are invalid (${error.message})`);
    }
    if (manifest) {
      for (const group of dependencyGroups) {
        for (const [dependency, specifier] of Object.entries(manifest[group] ?? {})) {
          if (String(specifier).startsWith("workspace:")) {
            errors.push(`${label}: ${group}.${dependency} must not use workspace protocol in a provider contract`);
          }
        }
      }
    }
  }
  add(
    artifacts.size === scopedArtifacts.length,
    "artifact package names must be unique within the selected release scope"
  );

  for (const [packageName, manifest] of manifests) {
    if (artifacts.get(packageName)?.kind !== "provider-contract") continue;
    for (const group of dependencyGroups) {
      for (const [dependency, specifier] of Object.entries(manifest[group] ?? {})) {
        const dependencyArtifact = allArtifacts.get(dependency);
        if (dependencyArtifact?.kind === "provider-contract") {
          add(
            specifier === dependencyArtifact.currentVersion,
            `${packageName}: ${group}.${dependency} must be exact ${dependencyArtifact.currentVersion}`
          );
        }
      }
    }
  }

  const workspacePackages = await discoverWorkspacePackages(repositoryRoot, cell);
  const providerNames = new Set(
    [...allArtifacts.values()]
      .filter((artifact) => artifact.kind === "provider-contract")
      .map((artifact) => artifact.packageName)
  );
  for (const workspacePackage of workspacePackages) {
    for (const group of dependencyGroups) {
      for (const [dependency, specifier] of Object.entries(workspacePackage.manifest[group] ?? {})) {
        if (providerNames.has(dependency) && String(specifier).startsWith("workspace:")) {
          errors.push(
            `${workspacePackage.relativePath}: ${group}.${dependency} must use explicit SemVer, not ${specifier}`
          );
        }
      }
    }
  }

  const sourcePaths = new Set();
  const requiredExternal = new Set();
  if (cell === null || cell === "nova") {
    const ownedPackages = new Map();
    const novaManifests = [];
    for (const sourcePath of catalog.novaExtraction?.sourcePackages ?? []) {
      const normalized = normalizeRelative(sourcePath);
      add(!sourcePaths.has(normalized), `NOVA source package is duplicated: ${normalized}`);
      sourcePaths.add(normalized);
      try {
        const manifest = await readJson(path.join(resolveInside(repositoryRoot, normalized), "package.json"));
        add(!ownedPackages.has(manifest.name), `NOVA package name is duplicated: ${manifest.name}`);
        ownedPackages.set(manifest.name, manifest.version);
        novaManifests.push({ sourcePath: normalized, manifest });
      } catch (error) {
        errors.push(`${normalized}: NOVA source package cannot be read (${error.message})`);
      }
    }
    add(
      catalog.novaExtraction?.ownedWorkspaceProtocol === "workspace:*",
      "NOVA ownedWorkspaceProtocol must be workspace:*"
    );
    add(
      catalog.novaExtraction?.externalDependencyPolicy === "exact-semver",
      "NOVA externalDependencyPolicy must be exact-semver"
    );

    const observedExternal = new Set();
    for (const { sourcePath, manifest } of novaManifests) {
      for (const group of dependencyGroups) {
        for (const [dependencyName, dependencySpec] of Object.entries(manifest[group] ?? {})) {
          const dependencyErrors = validateNovaDependencySpec({
            dependencyName,
            dependencySpec,
            ownedPackages,
            artifacts: allArtifacts
          });
          errors.push(...dependencyErrors.map((error) => `${sourcePath}: ${group}.${error}`));
          if (dependencyName.startsWith("@hyperion/") && !ownedPackages.has(dependencyName)) {
            observedExternal.add(dependencyName);
          }
        }
      }
    }
    for (const dependency of catalog.novaExtraction?.requiredExternalArtifacts ?? []) {
      add(!requiredExternal.has(dependency), `NOVA required external artifact is duplicated: ${dependency}`);
      requiredExternal.add(dependency);
    }
    for (const dependency of observedExternal) {
      add(requiredExternal.has(dependency), `NOVA external artifact is not declared as required: ${dependency}`);
    }
    for (const dependency of requiredExternal) {
      add(observedExternal.has(dependency), `NOVA required external artifact is stale or unused: ${dependency}`);
      add(allArtifacts.has(dependency), `NOVA required external artifact is absent from catalog: ${dependency}`);
    }
    if (options.requirePublished) {
      for (const dependency of requiredExternal) {
        const state = allArtifacts.get(dependency)?.publication?.state;
        add(state === "published", `NOVA extraction is blocked until ${dependency} has verified published state`);
      }
    }
  }

  return {
    errors,
    summary: {
      artifacts: artifacts.size,
      providerContracts: [...artifacts.values()].filter((artifact) => artifact.kind === "provider-contract").length,
      novaSourcePackages: sourcePaths.size,
      novaExternalArtifacts: [...requiredExternal].sort(),
      requirePublished: Boolean(options.requirePublished),
      cell: cell ?? "all"
    }
  };
}

export async function checkProviderArtifactCatalog(options = {}) {
  const result = await inspectProviderArtifactCatalog(options);
  if (result.errors.length > 0) {
    throw new Error(`Provider artifact registry check failed:\n${result.errors.join("\n")}`);
  }
  return result.summary;
}

function parseArguments(argv) {
  const options = {};
  let cellSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-published") options.requirePublished = true;
    else if (argument === "--catalog") {
      const value = argv[index + 1];
      if (!value) throw new Error("--catalog requires a path");
      options.catalogPath = path.resolve(defaultRepositoryRoot, value);
      index += 1;
    } else if (argument === "--cell") {
      if (cellSeen) throw new Error("--cell may be supplied only once");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--cell requires a value");
      options.cell = assertReleaseCell(value);
      cellSeen = true;
      index += 1;
    } else if (argument === "--" || argument === "") {
      continue;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const summary = await checkProviderArtifactCatalog(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `Provider artifact registry OK (${summary.cell}): ${summary.providerContracts} contracts, ${summary.novaSourcePackages} NOVA packages, ${summary.novaExternalArtifacts.length} external artifacts${summary.requirePublished ? " (published evidence declarations)" : " (declarations)"}\n`
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
