import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const COOPFUTURO_CONTEXT_NAME = "coopfuturo";
export const COOPFUTURO_SOURCE_ROOT = "apps/coopfuturo-console";
export const COOPFUTURO_CONTEXT_ALLOWLIST = Object.freeze([
  "Dockerfile",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "public",
  "scripts",
  "src",
  "tsconfig.json"
]);

const IGNORED_DIRECTORY_NAMES = new Set([".git", ".next", ".turbo", "coverage", "dist", "node_modules"]);

export async function generateCoopfuturoContext(repositoryRoot, outputRoot) {
  const absoluteRepositoryRoot = path.resolve(repositoryRoot);
  const absoluteOutputRoot = path.resolve(outputRoot);
  const sourceRoot = path.resolve(absoluteRepositoryRoot, COOPFUTURO_SOURCE_ROOT);
  const target = path.resolve(absoluteOutputRoot, COOPFUTURO_CONTEXT_NAME);
  assertDescendant(absoluteRepositoryRoot, sourceRoot, "Coopfuturo source root");
  assertDescendant(absoluteOutputRoot, target, "generated Coopfuturo context");

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const allowedPath of COOPFUTURO_CONTEXT_ALLOWLIST) {
    await copyRequired(sourceRoot, target, allowedPath);
  }

  const files = await buildProvenance(sourceRoot, target);
  const manifest = {
    schemaVersion: 1,
    kind: "customer-console-context",
    cell: "nova",
    client: "coopfuturo-console",
    generatedAt: new Date().toISOString(),
    sourceRoot: COOPFUTURO_SOURCE_ROOT,
    allowlist: COOPFUTURO_CONTEXT_ALLOWLIST,
    files
  };
  await writeFile(path.join(target, ".context-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { target, files, manifest };
}

async function copyRequired(sourceRoot, targetRoot, relativePath) {
  const source = path.resolve(sourceRoot, relativePath);
  const destination = path.resolve(targetRoot, relativePath);
  assertDescendant(sourceRoot, source, `Coopfuturo allowlist source ${relativePath}`);
  assertDescendant(targetRoot, destination, `Coopfuturo context destination ${relativePath}`);
  try {
    await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Required Coopfuturo Docker context source is missing: ${relativePath}`, { cause: error });
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

async function buildProvenance(sourceRoot, targetRoot) {
  const files = [];
  await walkProvenance(sourceRoot, targetRoot, "", files);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkProvenance(sourceRoot, targetRoot, relativeDirectory, files) {
  const entries = await readdir(path.join(targetRoot, relativeDirectory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = normalize(path.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) {
      await walkProvenance(sourceRoot, targetRoot, relativePath, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Generated Coopfuturo context contains a non-regular entry: ${relativePath}`);
    }
    const [sourceContents, generatedContents] = await Promise.all([
      readFile(path.join(sourceRoot, relativePath)),
      readFile(path.join(targetRoot, relativePath))
    ]);
    if (!sourceContents.equals(generatedContents)) {
      throw new Error(`Generated Coopfuturo context differs from source: ${relativePath}`);
    }
    files.push({
      path: relativePath,
      source: `${COOPFUTURO_SOURCE_ROOT}/${relativePath}`,
      bytes: generatedContents.byteLength,
      sha256: createHash("sha256").update(generatedContents).digest("hex")
    });
  }
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
  let outputRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") outputRoot = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
  }
  return { outputRoot };
}

async function main() {
  const repositoryRoot = process.cwd();
  const options = parseArguments(process.argv.slice(2));
  const outputRoot = options.outputRoot
    ? path.resolve(repositoryRoot, options.outputRoot)
    : path.join(repositoryRoot, ".docker-contexts");
  await mkdir(outputRoot, { recursive: true });
  const result = await generateCoopfuturoContext(repositoryRoot, outputRoot);
  process.stdout.write(`Generated Coopfuturo Docker context (${result.files.length} files): ${result.target}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export async function readCoopfuturoManifest(outputRoot) {
  return JSON.parse(await readFile(path.join(outputRoot, COOPFUTURO_CONTEXT_NAME, ".context-manifest.json"), "utf8"));
}
