import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  RELEASE_CELLS,
  assertValid,
  compareSemver,
  draftImageReference,
  isSemver,
  validateCatalog,
  validateManifest
} from "./release-model.mjs";

export function generateManifest(catalog, options) {
  const status = options.status ?? "draft";
  const suppliedImages = options.images instanceof Map ? options.images : new Map(Object.entries(options.images ?? {}));
  const ociIds = new Set(
    catalog.components.filter((component) => component.distribution === "oci").map((component) => component.id)
  );
  for (const id of suppliedImages.keys()) {
    if (!ociIds.has(id)) throw new Error(`Image supplied for unknown or non-OCI catalog component ${id}`);
  }

  const components = catalog.components.map((component) => {
    if (component.distribution === "npm") {
      return {
        id: component.id,
        version: component.version,
        package: `${component.packageName}@${component.version}`
      };
    }
    const image = suppliedImages.get(component.id);
    if (status === "published" && !image) {
      throw new Error(`Published release requires --image for ${component.id}`);
    }
    return {
      id: component.id,
      version: component.version,
      image: image ?? draftImageReference(catalog.cell, catalog.catalogVersion, component)
    };
  });

  const manifest = {
    $schema: "../../schemas/release-manifest.schema.json",
    schemaVersion: 1,
    cell: catalog.cell,
    catalogVersion: catalog.catalogVersion,
    releaseVersion: options.releaseVersion,
    status,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    imagesVerified: options.imagesVerified === true,
    components
  };
  if (options.sourceRevision) manifest.sourceRevision = options.sourceRevision;
  if (status === "published") manifest.releasedAt = options.releasedAt ?? manifest.generatedAt;

  assertValid(validateManifest(manifest, catalog), `Cannot generate ${catalog.cell} manifest`);
  return manifest;
}

export async function loadCatalog(root, cell, requestedVersion) {
  if (!RELEASE_CELLS.includes(cell)) throw new Error(`Unknown cell ${JSON.stringify(cell)}`);
  const directory = path.join(root, "releases", "catalogs", cell);
  let version = requestedVersion;
  if (!version) {
    const versions = (await readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -5))
      .filter(isSemver)
      .sort(compareSemver);
    version = versions.at(-1);
  }
  if (!isSemver(version)) throw new Error(`No valid catalog version found for ${cell}`);
  const filePath = path.join(directory, `${version}.json`);
  const catalog = JSON.parse(await readFile(filePath, "utf8"));
  assertValid(validateCatalog(catalog, { context: filePath }), `Cannot load ${cell} catalog`);
  if (catalog.cell !== cell || catalog.catalogVersion !== version) {
    throw new Error(`Catalog identity does not match ${cell}@${version}`);
  }
  return catalog;
}

function parseArguments(argv) {
  const options = { images: new Map(), status: "draft", force: false, imagesVerified: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--catalog-version") options.catalogVersion = argv[++index];
    else if (argument === "--release-version") options.releaseVersion = argv[++index];
    else if (argument === "--status") options.status = argv[++index];
    else if (argument === "--source-revision") options.sourceRevision = argv[++index];
    else if (argument === "--generated-at") options.generatedAt = argv[++index];
    else if (argument === "--released-at") options.releasedAt = argv[++index];
    else if (argument === "--output") options.output = argv[++index];
    else if (argument === "--image") addImageAssignment(options.images, argv[++index]);
    else if (argument === "--images-verified") options.imagesVerified = true;
    else if (argument === "--force") options.force = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.cell) throw new Error("--cell is required");
  if (!isSemver(options.releaseVersion)) throw new Error("--release-version must be valid SemVer");
  if (!["draft", "published"].includes(options.status)) throw new Error("--status must be draft or published");
  return options;
}

function addImageAssignment(images, assignment) {
  const separator = assignment?.indexOf("=") ?? -1;
  if (separator <= 0 || separator === assignment.length - 1) {
    throw new Error("--image must use component=repository@sha256:digest");
  }
  const id = assignment.slice(0, separator);
  if (images.has(id)) throw new Error(`Duplicate --image assignment for ${id}`);
  images.set(id, assignment.slice(separator + 1));
}

async function outputManifest(manifest, options) {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!options.output || options.output === "-") {
    process.stdout.write(serialized);
    return;
  }
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  if (!options.force) {
    try {
      await access(outputPath);
      throw new Error(`Refusing to overwrite ${outputPath}; pass --force to replace it`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await writeFile(outputPath, serialized, { encoding: "utf8", flag: options.force ? "w" : "wx" });
  process.stdout.write(`Wrote ${outputPath}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = process.cwd();
  const catalog = await loadCatalog(root, options.cell, options.catalogVersion);
  const manifest = generateManifest(catalog, options);
  await outputManifest(manifest, options);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
