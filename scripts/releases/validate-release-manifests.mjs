import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CELL_COMPOSE_SERVICES, CELL_NAMES, cellForPackagePath } from "../architecture/cell-policy.mjs";
import {
  RELEASE_CELLS,
  compareSemver,
  composeServicesForComponent,
  isSemver,
  validateCatalog,
  validateCatalogSources,
  validateManifest
} from "./release-model.mjs";
import { ROLLBACK_CELLS, loadRollbackPolicy, verifyProviderMigrationManifest } from "./rollback-policy.mjs";
import { assertReleaseCell, selectedReleaseCells } from "./release-scope.mjs";

export const RETIRED_RELEASE_ARTIFACT_SOURCE_PATHS = Object.freeze([
  "apps/api-gateway",
  "apps/web-console",
  "packages/migrations",
  "packages/platform-migrations"
]);

const retiredPlatformReleaseArtifacts = new Set(RETIRED_RELEASE_ARTIFACT_SOURCE_PATHS);

export function isRetiredReleaseArtifact(artifact) {
  return artifact?.cell === "platform" && retiredPlatformReleaseArtifacts.has(artifact?.sourcePath);
}

export async function validateRepositoryReleases(root, { publishable = false, cell = null } = {}) {
  const errors = [];
  const catalogs = [];
  const manifests = [];
  let rollbackPolicyCount = 0;
  const cells = selectedReleaseCells(cell);
  const catalogRoot = path.join(root, "releases", "catalogs");
  const manifestRoot = path.join(root, "releases", "manifests");

  if (JSON.stringify(RELEASE_CELLS) !== JSON.stringify(CELL_NAMES)) {
    errors.push("release cells and architecture cell policy disagree");
  }

  for (const selectedCell of cells) {
    const catalogFiles = await listJsonFiles(
      path.join(catalogRoot, selectedCell),
      `catalog directory for ${selectedCell}`,
      errors
    );
    const manifestFiles = await listJsonFiles(
      path.join(manifestRoot, selectedCell),
      `manifest directory for ${selectedCell}`,
      errors
    );
    if (catalogFiles.length === 0) errors.push(`cell ${selectedCell} has no versioned release catalog`);
    if (manifestFiles.length === 0) errors.push(`cell ${selectedCell} has no release manifest`);

    for (const filePath of catalogFiles) {
      const catalog = await readJson(filePath, root, errors);
      if (!catalog) continue;
      const context = normalizePath(path.relative(root, filePath));
      errors.push(...validateCatalog(catalog, { context }));
      if (catalog.cell !== selectedCell) errors.push(`${context}.cell must match directory ${selectedCell}`);
      const fileVersion = path.basename(filePath, ".json");
      if (catalog.catalogVersion !== fileVersion) {
        errors.push(`${context}.catalogVersion must match filename ${fileVersion}`);
      }
      catalogs.push({ cell: selectedCell, filePath, context, catalog });
    }

    for (const filePath of manifestFiles) {
      const manifest = await readJson(filePath, root, errors);
      if (!manifest) continue;
      const context = normalizePath(path.relative(root, filePath));
      if (manifest.cell !== selectedCell) errors.push(`${context}.cell must match directory ${selectedCell}`);
      const fileVersion = path.basename(filePath, ".json");
      if (manifest.releaseVersion !== fileVersion) {
        errors.push(`${context}.releaseVersion must match filename ${fileVersion}`);
      }
      manifests.push({ cell: selectedCell, filePath, context, manifest });
    }
  }

  const catalogsByIdentity = new Map();
  for (const entry of catalogs) {
    const identity = `${entry.catalog.cell}@${entry.catalog.catalogVersion}`;
    if (catalogsByIdentity.has(identity)) errors.push(`duplicate release catalog ${identity}`);
    else catalogsByIdentity.set(identity, entry.catalog);
  }

  const releaseArtifacts = (await discoverScopedPackages(root, cells)).map(toReleaseArtifact).filter(Boolean);

  for (const cell of cells) {
    const cellCatalogs = catalogs
      .filter((entry) => entry.catalog.cell === cell && isSemver(entry.catalog.catalogVersion))
      .sort((left, right) => compareSemver(left.catalog.catalogVersion, right.catalog.catalogVersion));
    const latestEntry = cellCatalogs.at(-1);
    const latest = latestEntry?.catalog;
    if (!latest) continue;
    errors.push(...validateCatalogSources(latest, { context: latestEntry.context, root }));
    if (ROLLBACK_CELLS.includes(cell)) {
      if (typeof latest.rollbackPolicy !== "string") {
        errors.push(`latest ${cell} catalog is missing its provider-owned rollbackPolicy`);
      } else {
        try {
          const loadedPolicy = await loadRollbackPolicy(latest, root);
          await verifyProviderMigrationManifest(loadedPolicy.policy, root);
          rollbackPolicyCount += 1;
        } catch (error) {
          errors.push(`latest ${cell} rollback policy is invalid: ${error.message}`);
        }
      }
    }
    const actualById = new Map(latest.components?.map((component) => [component.id, component]) ?? []);
    const componentsByComposeService = new Map();
    for (const component of latest.components?.filter((entry) => entry.distribution === "oci") ?? []) {
      for (const service of composeServicesForComponent(component)) componentsByComposeService.set(service, component);
    }
    for (const expectedId of CELL_COMPOSE_SERVICES[cell]) {
      const component = componentsByComposeService.get(expectedId);
      if (!component) {
        errors.push(`latest ${cell} catalog is missing Compose component ${expectedId}`);
      } else if (component.distribution !== "oci") {
        errors.push(`latest ${cell} catalog component ${expectedId} must use OCI distribution`);
      }
    }
    const composeServices = new Set(CELL_COMPOSE_SERVICES[cell]);
    for (const component of latest.components?.filter((entry) => entry.distribution === "oci") ?? []) {
      for (const service of composeServicesForComponent(component)) {
        if (!composeServices.has(service)) {
          errors.push(
            `latest ${cell} OCI component ${component.id} Compose service ${service} is not covered by CELL_COMPOSE_SERVICES`
          );
        }
      }
    }
    for (const artifact of releaseArtifacts.filter(
      (entry) => entry.cell === cell && !isRetiredReleaseArtifact(entry)
    )) {
      const component = actualById.get(artifact.id);
      if (!component) {
        errors.push(`latest ${cell} catalog is missing discovered release artifact ${artifact.sourcePath}`);
        continue;
      }
      if (component.sourcePath !== artifact.sourcePath) {
        errors.push(`latest ${cell} catalog component ${artifact.id}.sourcePath must be ${artifact.sourcePath}`);
      }
      if (component.distribution !== artifact.distribution) {
        errors.push(`latest ${cell} catalog component ${artifact.id}.distribution must be ${artifact.distribution}`);
      }
      if (component.kind !== artifact.kind) {
        errors.push(`latest ${cell} catalog component ${artifact.id}.kind must be ${artifact.kind}`);
      }
    }
  }

  const manifestIdentities = new Set();
  for (const entry of manifests) {
    const identity = `${entry.manifest.cell}@${entry.manifest.releaseVersion}`;
    if (manifestIdentities.has(identity)) errors.push(`duplicate release manifest ${identity}`);
    manifestIdentities.add(identity);
    const catalog = catalogsByIdentity.get(`${entry.manifest.cell}@${entry.manifest.catalogVersion}`);
    if (!catalog) {
      errors.push(
        `${entry.context} references missing catalog ${entry.manifest.cell}@${entry.manifest.catalogVersion}`
      );
      continue;
    }
    errors.push(...validateManifest(entry.manifest, catalog, { context: entry.context, publishable }));
  }

  return {
    errors,
    catalogCount: catalogs.length,
    manifestCount: manifests.length,
    rollbackPolicyCount,
    cells
  };
}

async function discoverScopedPackages(root, cells) {
  const selected = new Set(cells);
  const packages = [];
  for (const workspaceRoot of ["apps", "services", "packages"]) {
    const absoluteWorkspaceRoot = path.join(root, workspaceRoot);
    let entries;
    try {
      entries = await readdir(absoluteWorkspaceRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = `${workspaceRoot}/${entry.name}`;
      const packageCell = cellForPackagePath(directory);
      if (!packageCell || !selected.has(packageCell)) continue;
      const packageJsonPath = path.join(root, directory, "package.json");
      try {
        const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
        packages.push({ directory, cell: packageCell, manifest });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw new Error(`Cannot read ${normalizePath(path.relative(root, packageJsonPath))}: ${error.message}`, {
          cause: error
        });
      }
    }
  }
  return packages;
}

function toReleaseArtifact(packageEntry) {
  const [workspaceRoot, id] = packageEntry.directory.split("/");
  if (!packageEntry.cell || !id) return null;
  if (workspaceRoot === "services") {
    return { id, cell: packageEntry.cell, sourcePath: packageEntry.directory, distribution: "oci", kind: "service" };
  }
  if (workspaceRoot === "apps") {
    const kind = id.endsWith("-console") ? "console" : id.endsWith("-bff") ? "bff" : "gateway";
    return { id, cell: packageEntry.cell, sourcePath: packageEntry.directory, distribution: "oci", kind };
  }
  if (workspaceRoot !== "packages" || id === "contracts") return null;
  if (id === "migrations") {
    return {
      id: "legacy-global-migrations",
      cell: "platform",
      sourcePath: packageEntry.directory,
      distribution: "oci",
      kind: "migrations"
    };
  }
  if (id.endsWith("-contracts")) {
    return { id, cell: packageEntry.cell, sourcePath: packageEntry.directory, distribution: "npm", kind: "contract" };
  }
  if (id.endsWith("-migrations")) {
    return {
      id,
      cell: packageEntry.cell,
      sourcePath: packageEntry.directory,
      distribution: "oci",
      kind: "migrations"
    };
  }
  return null;
}

function parseArguments(argv) {
  const options = { publishable: false, root: process.cwd(), cell: null };
  let cellSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--publishable") options.publishable = true;
    else if (argument === "--root") options.root = path.resolve(argv[++index]);
    else if (argument === "--cell") {
      if (cellSeen) throw new Error("--cell may be supplied only once");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--cell requires a value");
      options.cell = assertReleaseCell(value);
      cellSeen = true;
      index += 1;
    } else if (argument === "--" || argument === "") continue;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function listJsonFiles(directory, description, errors) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      errors.push(`missing ${description}: ${normalizePath(directory)}`);
      return [];
    }
    throw error;
  }
  const unexpected = entries.filter((entry) => !entry.isFile() || !entry.name.endsWith(".json"));
  for (const entry of unexpected) errors.push(`${description} contains unsupported entry ${entry.name}`);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function readJson(filePath, root, errors) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    errors.push(`${normalizePath(path.relative(root, filePath))} is not valid JSON: ${error.message}`);
    return null;
  }
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await validateRepositoryReleases(options.root, options);
  if (result.errors.length > 0) {
    process.stderr.write(`Release validation failed with ${result.errors.length} error(s):\n`);
    for (const error of result.errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Validated ${result.catalogCount} catalog(s) and ${result.manifestCount} manifest(s), plus ${result.rollbackPolicyCount} product rollback policy/policies, across ${result.cells.length} cells.\n`
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
