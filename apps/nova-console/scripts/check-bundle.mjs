import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { argv, platform, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const metafileName = "nova-bundle-metafile.json";

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`NOVA bundle cannot contain symbolic links: ${path}`);
    }
    return entry.isDirectory() ? files(path) : [path];
  });
}

const forbidden = [
  /\bpulso\b/i,
  /\blumen\b/i,
  /\bsof[ií]a\b/i,
  /coop\w*/i,
  /\bcedco\b/i,
  /brand-coopfuturo/i,
  /vite_product/i,
  /\/pulso-iris\//i,
  /\/lumen\//i,
  /localStorage|sessionStorage/,
  /\bBearer\b|accessToken|tokenType/i
];

const allowedWorkspaceRoots = ["apps/nova-console/src/", "packages/nova-contracts/", "packages/platform-contracts/"];
const allowedWorkspaceFiles = new Set(["apps/nova-console/index.html"]);
const allowedHyperionDependencies = new Set(["nova-contracts", "platform-contracts"]);
const allowedVirtualModules = new Set([
  "virtual:commonjsHelpers.js",
  "virtual:vite/modulepreload-polyfill.js",
  "virtual:vite/preload-helper.js"
]);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function suffixIndex(value) {
  const index = value.search(/[?#]/);
  return index === -1 ? value.length : index;
}

function assertPortableOutputName(fileName) {
  if (
    typeof fileName !== "string" ||
    fileName === "" ||
    fileName.includes("\\") ||
    posix.isAbsolute(fileName) ||
    posix.normalize(fileName) !== fileName ||
    fileName === ".." ||
    fileName.startsWith("../")
  ) {
    throw new Error(`NOVA metafile contains a non-portable output path: ${String(fileName)}`);
  }
}

function assertAllowedWorkspaceModule(moduleId) {
  const withSuffix = moduleId.slice("workspace:".length);
  const workspacePath = withSuffix.slice(0, suffixIndex(withSuffix));
  if (
    workspacePath === "" ||
    workspacePath.includes("\\") ||
    posix.isAbsolute(workspacePath) ||
    posix.normalize(workspacePath) !== workspacePath ||
    workspacePath === ".." ||
    workspacePath.startsWith("../")
  ) {
    throw new Error(`NOVA metafile contains a non-portable workspace module: ${moduleId}`);
  }

  if (workspacePath.startsWith("node_modules/")) {
    const hyperionMatches = [...workspacePath.matchAll(/(?:^|\/)node_modules\/@hyperion\/([^/]+)/g)];
    const foreignDependency = hyperionMatches.find((match) => !allowedHyperionDependencies.has(match[1]));
    if (foreignDependency) {
      throw new Error(`NOVA bundle contains foreign Hyperion dependency: ${moduleId}`);
    }
    return;
  }

  if (
    allowedWorkspaceFiles.has(workspacePath) ||
    allowedWorkspaceRoots.some((root) => workspacePath.startsWith(root))
  ) {
    return;
  }
  throw new Error(`NOVA module is outside the NOVA/platform allowlist: ${moduleId}`);
}

function assertAllowedModule(moduleId) {
  if (typeof moduleId !== "string" || moduleId === "" || moduleId.includes("\\")) {
    throw new Error(`NOVA metafile contains an invalid module id: ${String(moduleId)}`);
  }
  if (moduleId.startsWith("workspace:")) {
    assertAllowedWorkspaceModule(moduleId);
    return;
  }
  if (moduleId.startsWith("virtual-file:")) {
    const wrappedModule = moduleId.slice("virtual-file:".length);
    if (!/[?&]commonjs-(?:entry|es-import|exports|module|proxy)(?:&|$)/.test(wrappedModule)) {
      throw new Error(`NOVA bundle contains an unknown virtual file module: ${moduleId}`);
    }
    assertAllowedModule(wrappedModule);
    return;
  }
  if (allowedVirtualModules.has(moduleId)) return;
  throw new Error(`NOVA bundle contains an untrusted module provenance: ${moduleId}`);
}

function parseMetafile(path) {
  let metafile;
  try {
    metafile = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`NOVA bundle metafile is not valid JSON: ${error.message}`, { cause: error });
  }
  if (
    metafile?.schemaVersion !== 1 ||
    metafile.kind !== "vite-rollup-build" ||
    metafile.product !== "nova" ||
    metafile.entryModule !== "workspace:apps/nova-console/src/main.tsx" ||
    !Array.isArray(metafile.modules) ||
    !Array.isArray(metafile.outputs)
  ) {
    throw new Error("NOVA bundle metafile has an unsupported or incomplete schema");
  }
  return metafile;
}

export function verifyNovaBundle(options = {}) {
  const checkedAppRoot = options.appRoot ? resolve(options.appRoot) : appRoot;
  const checkedDistRoot = options.distRoot ? resolve(options.distRoot) : join(checkedAppRoot, "dist");
  if (!existsSync(checkedDistRoot)) {
    throw new Error("NOVA bundle does not exist; run Vite before the contamination check");
  }

  const metafilePath = join(checkedDistRoot, metafileName);
  if (!existsSync(metafilePath)) {
    throw new Error("NOVA bundle provenance metafile is missing; run the configured Vite build");
  }
  const metafile = parseMetafile(metafilePath);

  const moduleSet = new Set();
  for (const moduleId of metafile.modules) {
    if (moduleSet.has(moduleId)) throw new Error(`NOVA metafile repeats module id: ${moduleId}`);
    assertAllowedModule(moduleId);
    moduleSet.add(moduleId);
  }
  if (!moduleSet.has(metafile.entryModule)) {
    throw new Error(`NOVA metafile does not include its declared entry module: ${metafile.entryModule}`);
  }

  const declaredOutputs = new Map();
  let entryChunks = 0;
  for (const output of metafile.outputs) {
    assertPortableOutputName(output?.fileName);
    if (declaredOutputs.has(output.fileName)) {
      throw new Error(`NOVA metafile repeats output: ${output.fileName}`);
    }
    if (
      !["asset", "chunk"].includes(output.type) ||
      !Number.isSafeInteger(output.bytes) ||
      output.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(output.sha256)
    ) {
      throw new Error(`NOVA metafile has invalid integrity data for ${output.fileName}`);
    }
    if (output.type === "chunk") {
      if (!Array.isArray(output.modules) || !Array.isArray(output.imports) || !Array.isArray(output.dynamicImports)) {
        throw new Error(`NOVA metafile has incomplete chunk provenance for ${output.fileName}`);
      }
      for (const moduleId of output.modules) {
        assertAllowedModule(moduleId);
        if (!moduleSet.has(moduleId)) {
          throw new Error(`NOVA chunk ${output.fileName} references an undeclared module: ${moduleId}`);
        }
      }
      if (output.facadeModuleId !== null) {
        assertAllowedModule(output.facadeModuleId);
        if (!moduleSet.has(output.facadeModuleId)) {
          throw new Error(`NOVA chunk ${output.fileName} has an undeclared facade module`);
        }
      }
      if (output.isEntry === true) entryChunks += 1;
    }
    declaredOutputs.set(output.fileName, output);
  }
  if (entryChunks === 0) throw new Error("NOVA metafile does not declare an entry chunk");

  const actualFiles = files(checkedDistRoot)
    .map((path) => relative(checkedDistRoot, path).replaceAll("\\", "/"))
    .filter((fileName) => fileName !== metafileName)
    .sort();
  const declaredFiles = [...declaredOutputs.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
    throw new Error(
      `NOVA metafile output inventory differs from dist (actual=${actualFiles.join(",")}; declared=${declaredFiles.join(",")})`
    );
  }

  for (const fileName of actualFiles) {
    const output = declaredOutputs.get(fileName);
    const contents = readFileSync(join(checkedDistRoot, ...fileName.split("/")));
    if (contents.byteLength !== output.bytes || sha256(contents) !== output.sha256) {
      throw new Error(`NOVA output integrity does not match the metafile: ${fileName}`);
    }
    const match = forbidden.find((pattern) => pattern.test(`${fileName}\n${contents.toString("utf8")}`));
    if (match) throw new Error(`NOVA bundle asset ${fileName} contains forbidden marker ${match}`);
  }

  return {
    modules: moduleSet.size,
    outputs: actualFiles.length
  };
}

function sameExecutablePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

if (argv[1] && sameExecutablePath(argv[1], fileURLToPath(import.meta.url))) {
  const result = verifyNovaBundle();
  stdout.write(`NOVA bundle boundary check passed (${result.modules} modules, ${result.outputs} emitted assets)\n`);
}
