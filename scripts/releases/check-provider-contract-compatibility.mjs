import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  PROVIDER_CONTRACTS,
  buildRuntimeSchemaMap,
  compareSnapshotSurface,
  compareTypeSurface,
  createContractSnapshot,
  providerContractClosure,
  publicTypeEntries,
  readVersionedSnapshots,
  requiresNMinusOneTypeComparison,
  requireLatestSnapshot,
  stableJson,
  validatePackedManifest
} from "./provider-contract-compatibility.mjs";
import {
  publishedSnapshotProvenance,
  requireSnapshotForRegistryEvidence,
  sha256Bytes,
  sha512Integrity,
  validateProviderContractRegistryEvidence
} from "./provider-contract-registry.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaultFixturesRoot = path.join(repositoryRoot, "fixtures", "contracts", "provider-owned");
const maxTarballBytes = 64 * 1024 * 1024;

function usage() {
  return `Usage:
  node scripts/releases/check-provider-contract-compatibility.mjs [--cell platform|nova|lumen|pulso] [--package <id>] [--skip-build] [--registry-resolution <json> --source-repository <owner/repo> --registry-origin <https-origin>]
  node scripts/releases/check-provider-contract-compatibility.mjs --record-baseline [--package <id>]
  node scripts/releases/check-provider-contract-compatibility.mjs --record-published-snapshot --package <id> --registry-resolution <json> --source-repository <owner/repo> --registry-origin <https-origin> --published-tarball <tgz> --published-snapshot-output <json>

Checks provider-owned contract tarballs against the latest versioned N-1 snapshot.
During publication, --registry-resolution binds the comparison to the real verified registry predecessor.
--record-baseline writes a missing repository-baseline snapshot and never overwrites one.`;
}

function parseArguments(argv) {
  const options = {
    packages: [],
    cell: null,
    skipBuild: false,
    recordBaseline: false,
    recordPublishedSnapshot: false,
    registryResolution: null,
    sourceRepository: null,
    registryOrigin: null,
    publishedTarball: null,
    publishedSnapshotOutput: null,
    fixturesRoot: defaultFixturesRoot
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--record-baseline") options.recordBaseline = true;
    else if (argument === "--record-published-snapshot") options.recordPublishedSnapshot = true;
    else if (
      [
        "--package",
        "--cell",
        "--fixtures-root",
        "--registry-resolution",
        "--source-repository",
        "--registry-origin",
        "--published-tarball",
        "--published-snapshot-output"
      ].includes(argument)
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--package") options.packages.push(value);
      if (argument === "--cell") options.cell = value;
      if (argument === "--fixtures-root") options.fixturesRoot = path.resolve(repositoryRoot, value);
      if (argument === "--registry-resolution") options.registryResolution = path.resolve(repositoryRoot, value);
      if (argument === "--source-repository") options.sourceRepository = value;
      if (argument === "--registry-origin") options.registryOrigin = value;
      if (argument === "--published-tarball") options.publishedTarball = path.resolve(repositoryRoot, value);
      if (argument === "--published-snapshot-output") {
        options.publishedSnapshotOutput = path.resolve(repositoryRoot, value);
      }
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.cell && !["platform", "nova", "lumen", "pulso"].includes(options.cell)) {
    throw new Error(`Unknown cell: ${options.cell}`);
  }
  for (const id of options.packages) {
    if (!PROVIDER_CONTRACTS[id]) throw new Error(`Unknown provider contract: ${id}`);
  }
  if (options.cell) {
    for (const id of options.packages) {
      if (PROVIDER_CONTRACTS[id].cell !== options.cell) {
        throw new Error(`Provider contract ${id} is not owned by release cell ${options.cell}`);
      }
    }
    options.packages.push(
      ...Object.entries(PROVIDER_CONTRACTS)
        .filter(([, provider]) => provider.cell === options.cell)
        .map(([id]) => id)
    );
  }
  options.packages = [...new Set(options.packages.length > 0 ? options.packages : Object.keys(PROVIDER_CONTRACTS))];
  if (options.registryResolution && options.packages.length !== 1) {
    throw new Error("--registry-resolution requires exactly one --package");
  }
  if (options.registryResolution && (!options.sourceRepository || !options.registryOrigin)) {
    throw new Error("--registry-resolution requires --source-repository and --registry-origin");
  }
  if (!options.registryResolution && (options.sourceRepository || options.registryOrigin)) {
    throw new Error("--source-repository/--registry-origin require --registry-resolution");
  }
  if (options.recordBaseline && options.recordPublishedSnapshot) {
    throw new Error("repository and published snapshots cannot be recorded together");
  }
  if (
    options.recordPublishedSnapshot &&
    (!options.registryResolution ||
      !options.publishedTarball ||
      !options.publishedSnapshotOutput ||
      options.packages.length !== 1)
  ) {
    throw new Error(
      "--record-published-snapshot requires one --package, --registry-resolution, --published-tarball and --published-snapshot-output"
    );
  }
  if (!options.recordPublishedSnapshot && (options.publishedTarball || options.publishedSnapshotOutput)) {
    throw new Error("--published-tarball/--published-snapshot-output require --record-published-snapshot");
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: { ...process.env, ...options.env }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${detail}`);
  }
  return result.stdout ?? "";
}

async function sourceManifests(requestedIds) {
  const manifests = new Map();
  const idByName = new Map(Object.entries(PROVIDER_CONTRACTS).map(([id, provider]) => [provider.packageName, id]));
  const visit = async (id) => {
    if (manifests.has(id)) return;
    const provider = PROVIDER_CONTRACTS[id];
    if (!provider) throw new Error(`Unknown provider contract: ${id}`);
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, provider.directory, "package.json"), "utf8"));
    manifests.set(id, manifest);
    for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(manifest[group] ?? {})) {
        const dependencyId = idByName.get(dependency);
        if (dependencyId) await visit(dependencyId);
      }
    }
  };
  for (const id of requestedIds) await visit(id);
  return manifests;
}

function packageManagerExecutable() {
  return "pnpm";
}

async function buildContracts(contractIds, manifests) {
  const pending = new Set(contractIds);
  const built = new Set();
  const idByName = new Map(Object.entries(PROVIDER_CONTRACTS).map(([id, provider]) => [provider.packageName, id]));
  while (pending.size > 0) {
    const ready = [...pending].filter((id) => {
      const dependencies = Object.keys(manifests.get(id).dependencies ?? {})
        .map((name) => idByName.get(name))
        .filter(Boolean);
      return dependencies.every((dependency) => built.has(dependency) || !pending.has(dependency));
    });
    if (ready.length === 0) throw new Error("Provider contract dependency graph contains a cycle");
    for (const id of ready) {
      run(packageManagerExecutable(), ["--filter", PROVIDER_CONTRACTS[id].packageName, "build"]);
      pending.delete(id);
      built.add(id);
    }
  }
}

async function packContract(id, temporaryRoot) {
  const provider = PROVIDER_CONTRACTS[id];
  const packDirectory = path.join(temporaryRoot, "pack", id);
  const extractDirectory = path.join(temporaryRoot, "extracted", id);
  await mkdir(packDirectory, { recursive: true });
  await mkdir(extractDirectory, { recursive: true });
  const output = run(
    packageManagerExecutable(),
    ["--dir", provider.directory, "pack", "--json", "--pack-destination", packDirectory],
    { capture: true }
  );
  const packed = JSON.parse(output);
  const tarball = path.resolve(packed.filename);
  if ((await stat(tarball)).size > maxTarballBytes) throw new Error(`${id} tarball exceeds 64 MiB`);
  run("tar", ["-xf", tarball, "-C", extractDirectory], { capture: true });
  const packageRoot = path.join(extractDirectory, "package");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const leakedTests = (packed.files ?? [])
    .map((entry) => entry.path)
    .filter((file) => /(^|\/)dist\/.*\.test\./.test(file));
  if (leakedTests.length > 0) throw new Error(`${id} tarball contains test artifacts: ${leakedTests.join(", ")}`);
  return { id, packageRoot, manifest, tarball };
}

function runtimeTarget(definition) {
  if (typeof definition === "string") return definition;
  if (!definition || typeof definition !== "object") return null;
  for (const condition of ["import", "default", "node", "require"]) {
    if (typeof definition[condition] === "string") return definition[condition];
    const nested = runtimeTarget(definition[condition]);
    if (nested) return nested;
  }
  return null;
}

function publicRuntimeEntries(manifest) {
  const entries = new Map();
  if (manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)) {
    for (const [subpath, definition] of Object.entries(manifest.exports)) {
      const target = runtimeTarget(definition);
      if (target) entries.set(subpath, target.replace(/^\.\//, ""));
    }
  }
  if (entries.size === 0 && manifest.main) entries.set(".", manifest.main.replace(/^\.\//, ""));
  return entries;
}

async function declarationClosure(packageRoot, manifest) {
  const files = {};
  const queue = [...publicTypeEntries(manifest).values()];
  const visited = new Set();
  while (queue.length > 0) {
    const relativePath = queue.shift().replaceAll("\\", "/");
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    const absolutePath = path.join(packageRoot, relativePath);
    const contents = await readFile(absolutePath, "utf8");
    files[relativePath] = contents;
    for (const match of contents.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      const candidate = path.posix.normalize(
        path.posix.join(path.posix.dirname(relativePath), specifier.replace(/\.(?:m|c)?js$/, ".d.ts"))
      );
      if (!visited.has(candidate)) queue.push(candidate);
    }
  }
  return files;
}

async function materializeCurrentPackages(packedById, temporaryRoot) {
  const nodeModules = path.join(temporaryRoot, "current", "node_modules");
  for (const packed of packedById.values()) {
    const target = path.join(nodeModules, ...packed.manifest.name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(packed.packageRoot, target, { recursive: true });
    packed.materializedRoot = target;
  }
}

async function materializeExternalDependencies(temporaryRoot) {
  const source = path.join(repositoryRoot, "packages", "platform-contracts", "node_modules", "zod");
  await stat(source);
  const target = path.join(temporaryRoot, "node_modules", "zod");
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
}

async function runtimeSchemasFor(packed) {
  const modules = {};
  for (const [subpath, target] of publicRuntimeEntries(packed.manifest)) {
    const moduleUrl = `${pathToFileURL(path.join(packed.materializedRoot, target)).href}?contract-compat=${Date.now()}-${encodeURIComponent(subpath)}`;
    modules[subpath] = await import(moduleUrl);
  }
  return buildRuntimeSchemaMap(modules);
}

async function currentSnapshotFor(packed) {
  return createContractSnapshot({
    manifest: packed.manifest,
    declarationFiles: await declarationClosure(packed.packageRoot, packed.manifest),
    runtimeSchemas: await runtimeSchemasFor(packed),
    provenance: {
      kind: "repository-baseline",
      published: false,
      sourceRevision: null,
      note: "Generated from the repository package tarball; this is not registry publication evidence."
    }
  });
}

async function materializeSnapshotPackage(snapshot, root) {
  const target = path.join(root, "node_modules", ...snapshot.packageName.split("/"));
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "package.json"), `${JSON.stringify(snapshot.manifest, null, 2)}\n`, "utf8");
  for (const [relativePath, contents] of Object.entries(snapshot.declarationFiles)) {
    const destination = path.join(target, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  return target;
}

async function loadAllSnapshots(fixturesRoot, contractIds) {
  const snapshotsById = new Map();
  for (const id of contractIds) {
    const provider = PROVIDER_CONTRACTS[id];
    snapshotsById.set(id, await readVersionedSnapshots(fixturesRoot, id, provider.packageName));
  }
  return snapshotsById;
}

async function materializePreviousClosure(contractId, previous, snapshotsById, root) {
  const idByName = new Map(Object.entries(PROVIDER_CONTRACTS).map(([id, provider]) => [provider.packageName, id]));
  const materialized = new Map();
  const visit = async (id, snapshot) => {
    if (materialized.has(id)) return;
    materialized.set(id, await materializeSnapshotPackage(snapshot, root));
    for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependencyName, version] of Object.entries(snapshot.manifest[group] ?? {})) {
        const dependencyId = idByName.get(dependencyName);
        if (!dependencyId) continue;
        const dependencySnapshot = (snapshotsById.get(dependencyId) ?? []).find(
          (candidate) => candidate.version === version
        );
        if (!dependencySnapshot) {
          throw new Error(
            `${contractId} N-1 depends on ${dependencyName}@${version}, but that exact snapshot is missing`
          );
        }
        await visit(dependencyId, dependencySnapshot);
      }
    }
  };
  await visit(contractId, previous);
  return materialized.get(contractId);
}

async function recordBaselines(requestedIds, currentSnapshots, fixturesRoot) {
  for (const id of requestedIds) {
    const snapshot = currentSnapshots.get(id);
    const directory = path.join(fixturesRoot, id);
    const target = path.join(directory, `${snapshot.version}.json`);
    await mkdir(directory, { recursive: true });
    try {
      const existing = JSON.parse(await readFile(target, "utf8"));
      if (stableJson(existing) !== stableJson(snapshot)) {
        throw new Error(
          `${path.relative(repositoryRoot, target)} already exists with different contents; snapshots are immutable`
        );
      }
      process.stdout.write(`Provider contract baseline already exact: ${id}@${snapshot.version}\n`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      process.stdout.write(`Recorded repository-only provider contract baseline: ${id}@${snapshot.version}\n`);
    }
  }
}

async function readRegistryEvidence(options, contractId, currentVersion) {
  const filePath = options.registryResolution;
  const evidence = JSON.parse(await readFile(filePath, "utf8"));
  validateProviderContractRegistryEvidence(evidence, {
    contractId,
    targetVersion: currentVersion,
    sourceRepository: options.sourceRepository,
    registryOrigin: options.registryOrigin
  });
  return evidence;
}

async function recordPublishedSnapshot(options, current, packed) {
  const contractId = options.packages[0];
  const evidence = await readRegistryEvidence(options, contractId, current.version);
  if (
    evidence.purpose !== "snapshot-capture" ||
    evidence.resolution.kind !== "published-registry" ||
    evidence.resolution.selection !== "exact-target" ||
    evidence.resolution.baselineVersion !== current.version
  ) {
    throw new Error(
      `${contractId}: published snapshot recording requires verified readback of exact current ${current.version}`
    );
  }
  const tarballBytes = await readFile(options.publishedTarball);
  const capturedSurfaceTarballBytes = await readFile(packed.tarball);
  if (
    sha256Bytes(tarballBytes) !== evidence.resolution.tarballSha256 ||
    sha512Integrity(tarballBytes) !== evidence.resolution.integrity
  ) {
    throw new Error(`${contractId}: local packed bytes differ from the verified registry artifact`);
  }
  if (!capturedSurfaceTarballBytes.equals(tarballBytes)) {
    throw new Error(`${contractId}: snapshot surface pack differs byte-for-byte from --published-tarball`);
  }
  const published = createContractSnapshot({
    manifest: current.manifest,
    declarationFiles: current.declarationFiles,
    runtimeSchemas: current.runtimeSchemas,
    provenance: publishedSnapshotProvenance(evidence)
  });
  if (published.contentSha256 !== current.contentSha256) {
    throw new Error(`${contractId}: published provenance changed the captured contract surface`);
  }
  const existingSnapshots = await readVersionedSnapshots(
    options.fixturesRoot,
    contractId,
    PROVIDER_CONTRACTS[contractId].packageName
  );
  const existing = existingSnapshots.find((snapshot) => snapshot.version === current.version);
  if (existing && existing.contentSha256 !== published.contentSha256) {
    throw new Error(`${contractId}: registry publication differs from existing ${current.version} snapshot surface`);
  }
  if (existing?.provenance?.kind === "published-registry" && stableJson(existing) !== stableJson(published)) {
    throw new Error(`${contractId}: existing published-registry snapshot ${current.version} is immutable`);
  }
  await mkdir(path.dirname(options.publishedSnapshotOutput), { recursive: true });
  await writeFile(options.publishedSnapshotOutput, `${JSON.stringify(published, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  process.stdout.write(`Recorded verified published-registry snapshot candidate: ${contractId}@${current.version}\n`);
  return { id: contractId, version: current.version, output: options.publishedSnapshotOutput };
}

async function removeCompatibilityTemporaryRoot(temporaryRoot) {
  const resolved = path.resolve(temporaryRoot);
  if (!resolved.startsWith(`${path.resolve(repositoryRoot)}${path.sep}.contract-compat-`)) {
    throw new Error(`Refusing to remove unexpected compatibility directory: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function runCompatibilityCheck(options) {
  const manifests = await sourceManifests(options.packages);
  const closure = providerContractClosure(options.packages, manifests);
  if (!options.skipBuild) await buildContracts(closure, manifests);
  const temporaryRoot = await mkdtemp(path.join(repositoryRoot, ".contract-compat-"));
  try {
    const packedById = new Map();
    for (const id of closure) packedById.set(id, await packContract(id, temporaryRoot));
    const providerVersions = new Map(
      [...packedById.values()].map((packed) => [packed.manifest.name, packed.manifest.version])
    );
    const manifestErrors = [];
    for (const packed of packedById.values()) {
      manifestErrors.push(
        ...validatePackedManifest(packed.manifest, PROVIDER_CONTRACTS[packed.id].packageName, providerVersions).map(
          (error) => `${packed.id}: ${error}`
        )
      );
    }
    if (manifestErrors.length > 0) throw new Error(manifestErrors.join("\n"));
    await materializeExternalDependencies(temporaryRoot);
    await materializeCurrentPackages(packedById, temporaryRoot);
    const currentSnapshots = new Map();
    for (const id of options.packages) currentSnapshots.set(id, await currentSnapshotFor(packedById.get(id)));
    if (options.recordBaseline) {
      await recordBaselines(options.packages, currentSnapshots, options.fixturesRoot);
      return { checked: [], recorded: options.packages };
    }
    if (options.recordPublishedSnapshot) {
      const contractId = options.packages[0];
      const recorded = await recordPublishedSnapshot(
        options,
        currentSnapshots.get(contractId),
        packedById.get(contractId)
      );
      return { checked: [], recorded: [recorded] };
    }
    const snapshotsById = await loadAllSnapshots(options.fixturesRoot, closure);
    const checked = [];
    const allErrors = [];
    for (const id of options.packages) {
      const snapshots = snapshotsById.get(id) ?? [];
      const current = currentSnapshots.get(id);
      let previous;
      try {
        if (options.registryResolution) {
          const evidence = await readRegistryEvidence(options, id, current.version);
          previous = requireSnapshotForRegistryEvidence(snapshots, evidence, id, current.version);
        } else {
          previous = requireLatestSnapshot(snapshots, id, current.version);
        }
      } catch (error) {
        allErrors.push(error.message);
        continue;
      }
      const comparison = compareSnapshotSurface(previous, current);
      const packageErrors = [...comparison.errors];
      if (requiresNMinusOneTypeComparison(comparison.mode)) {
        const previousRoot = await materializePreviousClosure(
          id,
          previous,
          snapshotsById,
          path.join(temporaryRoot, "previous", id)
        );
        packageErrors.push(
          ...(await compareTypeSurface({
            previousRoot,
            currentRoot: packedById.get(id).materializedRoot,
            previousManifest: previous.manifest,
            currentManifest: current.manifest
          }))
        );
      }
      if (packageErrors.length > 0) {
        allErrors.push(...packageErrors.map((error) => `${id}: ${error}`));
      } else {
        checked.push({
          id,
          previous: previous.version,
          current: current.version,
          mode: comparison.mode,
          provenance: previous.provenance.kind
        });
      }
    }
    if (allErrors.length > 0) throw new Error(`Provider contract compatibility failed:\n${allErrors.join("\n")}`);
    for (const result of checked) {
      process.stdout.write(
        `Provider contract N/N-1 OK: ${result.id} ${result.previous} -> ${result.current} (${result.mode}, ${result.provenance})\n`
      );
    }
    return { checked, recorded: [] };
  } finally {
    await removeCompatibilityTemporaryRoot(temporaryRoot);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await runCompatibilityCheck(options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
