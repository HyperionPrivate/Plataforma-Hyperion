import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { generateCoopfuturoContext } from "./generate-coopfuturo-context.mjs";

export const CELL_CONTEXT_FILES = Object.freeze({
  nova: Object.freeze([
    "apps/nova-bff",
    "apps/nova-console",
    "services/nova-core-service",
    "services/voice-channel-service",
    "services/liwa-channel-service",
    "services/documents-service",
    "packages/platform-contracts",
    "packages/audit-contracts",
    "packages/nova-contracts",
    "packages/nova-config",
    "packages/nova-service-runtime",
    "packages/nova-durable-events",
    "packages/nova-migrations",
    "packages/database",
    "packages/logger"
  ]),
  lumen: Object.freeze([
    "apps/lumen-bff",
    "apps/lumen-console",
    "services/lumen-service",
    "packages/audit-contracts",
    "packages/config",
    "packages/database",
    "packages/durable-events",
    "packages/frontend-build-provenance",
    "packages/logger",
    "packages/platform-contracts",
    "packages/lumen-contracts",
    "packages/lumen-migrations",
    "packages/service-runtime"
  ]),
  pulso: Object.freeze([
    "apps/pulso-bff",
    "apps/pulso-console",
    "services/agent-service",
    "services/prompt-flow-service",
    "services/knowledge-service",
    "services/integration-service",
    "services/pulso-iris-service",
    "services/whatsapp-channel-service",
    "packages/audit-contracts",
    "packages/config",
    "packages/database",
    "packages/durable-events",
    "packages/frontend-build-provenance",
    "packages/logger",
    "packages/platform-contracts",
    "packages/pulso-contracts",
    "packages/pulso-migrations",
    "packages/service-runtime"
  ]),
  platform: Object.freeze([
    "apps/platform-admin-bff",
    "apps/platform-admin-console",
    "services/audit-service",
    "services/identity-service",
    "services/tenant-service",
    "packages/access-migrations",
    "packages/audit-contracts",
    "packages/audit-migrations",
    "packages/config",
    "packages/database",
    "packages/durable-events",
    "packages/frontend-build-provenance",
    "packages/logger",
    "packages/platform-contracts",
    "packages/service-runtime"
  ])
});

const ROOT_METADATA = Object.freeze(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"]);
const IGNORED_DIRECTORY_NAMES = new Set([".git", ".next", ".turbo", ".vite", "coverage", "dist", "node_modules"]);

const CONTEXT_INFRA = Object.freeze({
  nova: Object.freeze([
    ["infra/docker/cells/nova.Dockerfile", "Dockerfile"],
    ["infra/docker/console.nginx.conf.template", "infra/docker/console.nginx.conf.template"]
  ]),
  lumen: Object.freeze([
    ["infra/docker/cells/lumen.Dockerfile", "Dockerfile"],
    ["infra/docker/console.nginx.conf.template", "infra/docker/console.nginx.conf.template"]
  ]),
  pulso: Object.freeze([
    ["infra/docker/cells/pulso.Dockerfile", "Dockerfile"],
    ["infra/docker/console.nginx.conf.template", "infra/docker/console.nginx.conf.template"]
  ]),
  platform: Object.freeze([
    ["infra/docker/cells/platform.Dockerfile", "Dockerfile"],
    ["infra/docker/console.nginx.conf.template", "infra/docker/console.nginx.conf.template"]
  ])
});

export function assertKnownCell(cell) {
  if (!(cell in CELL_CONTEXT_FILES)) {
    throw new Error(`Unknown Docker cell ${JSON.stringify(cell)}`);
  }
  return cell;
}

export function contextSourcePaths(cell) {
  assertKnownCell(cell);
  return [...ROOT_METADATA, ...CELL_CONTEXT_FILES[cell], ...CONTEXT_INFRA[cell].map(([source]) => source)];
}

export async function generateCellContext(repositoryRoot, outputRoot, cell) {
  assertKnownCell(cell);
  const absoluteRepositoryRoot = path.resolve(repositoryRoot);
  const absoluteOutputRoot = path.resolve(outputRoot);
  const target = path.resolve(absoluteOutputRoot, cell);
  assertDescendant(absoluteOutputRoot, target, "generated cell context");
  assertDescendant(absoluteRepositoryRoot, path.resolve(absoluteRepositoryRoot, "apps"), "repository root");

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const relativePath of ROOT_METADATA) {
    await copyRequired(absoluteRepositoryRoot, target, relativePath, relativePath);
  }
  for (const relativePath of CELL_CONTEXT_FILES[cell]) {
    await copyRequired(absoluteRepositoryRoot, target, relativePath, relativePath);
  }
  for (const [source, destination] of CONTEXT_INFRA[cell]) {
    await copyRequired(absoluteRepositoryRoot, target, source, destination);
  }

  const files = await listContextFiles(target);
  const closureSha256 = await calculateContextClosureSha256(target, files);
  const manifest = {
    schemaVersion: 1,
    cell,
    generatedAt: new Date().toISOString(),
    sources: contextSourcePaths(cell),
    files,
    closure: {
      algorithm: "sha256-path-null-content-sha256-lf-v1",
      sha256: closureSha256
    }
  };
  await writeFile(path.join(target, ".context-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { cell, target, files, closureSha256 };
}

export async function listContextFiles(root) {
  const files = [];
  await walk(root, "", files);
  return files.sort();
}

export async function calculateContextClosureSha256(root, files) {
  const absoluteRoot = path.resolve(root);
  const closure = createHash("sha256");
  for (const relativePath of [...files].sort()) {
    const candidate = path.resolve(absoluteRoot, relativePath);
    assertDescendant(absoluteRoot, candidate, `context closure file ${relativePath}`);
    const contents = await readFile(candidate);
    const contentSha256 = createHash("sha256").update(contents).digest("hex");
    closure.update(relativePath, "utf8");
    closure.update("\0", "utf8");
    closure.update(contentSha256, "ascii");
    closure.update("\n", "utf8");
  }
  return closure.digest("hex");
}

async function walk(root, relativeDirectory, files) {
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = normalize(path.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) await walk(root, relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error(`Generated context contains a non-regular entry: ${relativePath}`);
  }
}

async function copyRequired(repositoryRoot, targetRoot, sourceRelativePath, destinationRelativePath) {
  const source = path.resolve(repositoryRoot, sourceRelativePath);
  const destination = path.resolve(targetRoot, destinationRelativePath);
  assertDescendant(repositoryRoot, source, `source ${sourceRelativePath}`);
  assertDescendant(targetRoot, destination, `destination ${destinationRelativePath}`);
  try {
    await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Required Docker context source is missing: ${sourceRelativePath}`, { cause: error });
    }
    throw error;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (candidate) => {
      const relative = path.relative(source, candidate);
      return relative === "" || !relative.split(path.sep).some((segment) => IGNORED_DIRECTORY_NAMES.has(segment));
    }
  });
}

function assertDescendant(parent, candidate, label) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe ${label}: ${candidate}`);
  }
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}

function parseArguments(argv) {
  const cells = [];
  let outputRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") cells.push(assertKnownCell(argv[++index]));
    else if (argument === "--output") outputRoot = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
  }
  return { cells: cells.length > 0 ? [...new Set(cells)] : Object.keys(CELL_CONTEXT_FILES), outputRoot };
}

async function main() {
  const repositoryRoot = process.cwd();
  const options = parseArguments(process.argv.slice(2));
  const outputRoot = options.outputRoot
    ? path.resolve(repositoryRoot, options.outputRoot)
    : path.join(repositoryRoot, ".docker-contexts");
  await mkdir(outputRoot, { recursive: true });
  for (const cell of options.cells) {
    const result = await generateCellContext(repositoryRoot, outputRoot, cell);
    process.stdout.write(`Generated ${cell} Docker context (${result.files.length} files): ${result.target}\n`);
    if (cell === "nova") {
      const customerResult = await generateCoopfuturoContext(repositoryRoot, outputRoot);
      process.stdout.write(
        `Generated Coopfuturo Docker context (${customerResult.files.length} files): ${customerResult.target}\n`
      );
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

// Referenced in tests to make sure importing this module never needs a writable
// repository directory; generated contexts may live under an OS temp folder.
export async function temporaryContextRoot(prefix = "hyperion-cell-context-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function readGeneratedManifest(contextRoot, cell) {
  return JSON.parse(await readFile(path.join(contextRoot, cell, ".context-manifest.json"), "utf8"));
}
