import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const MANIFEST_KIND = "vite-rollup-build";
const ALLOWED_VIRTUAL_MODULES = new Set([
  "virtual:commonjsHelpers.js",
  "virtual:vite/modulepreload-polyfill.js",
  "virtual:vite/preload-helper.js"
]);

function posixPath(value) {
  return value.replaceAll("\\", "/");
}

function splitModuleSuffix(moduleId) {
  const suffixIndex = moduleId.search(/[?#]/);
  return suffixIndex === -1
    ? { path: moduleId, suffix: "" }
    : { path: moduleId.slice(0, suffixIndex), suffix: moduleId.slice(suffixIndex) };
}

function portableFileModuleId(moduleId, suffix, workspaceRoot) {
  let modulePath = moduleId;
  if (modulePath.startsWith("/@fs/")) modulePath = modulePath.slice("/@fs/".length);
  if (!isAbsolute(modulePath)) return `unresolved:${posixPath(modulePath)}${suffix}`;

  const workspacePath = relative(workspaceRoot, modulePath);
  if (workspacePath === "" || (!workspacePath.startsWith("..") && !isAbsolute(workspacePath))) {
    return `workspace:${posixPath(workspacePath || ".")}${suffix}`;
  }
  return `external:${posixPath(modulePath)}${suffix}`;
}

function portableModuleId(moduleId, workspaceRoot) {
  const virtual = moduleId.startsWith("\0");
  const unwrapped = virtual ? moduleId.slice(1) : moduleId;
  const { path, suffix } = splitModuleSuffix(unwrapped);

  if (virtual && isAbsolute(path)) {
    return `virtual-file:${portableFileModuleId(path, suffix, workspaceRoot)}`;
  }
  if (virtual) return `virtual:${posixPath(unwrapped)}`;
  return portableFileModuleId(path, suffix, workspaceRoot);
}

function outputFiles(directory, label) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} build output cannot contain a symbolic link: ${target}`);
      return entry.isDirectory() ? outputFiles(target, label) : [target];
    });
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function assertPluginOptions(options) {
  if (!options || typeof options !== "object") throw new Error("Bundle provenance plugin options are required");
  if (!isAbsolute(options.appRoot)) throw new Error("Bundle provenance appRoot must be absolute");
  if (!/^workspace:apps\/[a-z0-9-]+\/src\/main\.tsx$/u.test(options.entryModule ?? "")) {
    throw new Error("Bundle provenance entryModule must be one portable console entry");
  }
  if (!/^[a-z][a-z0-9-]*-bundle-metafile\.json$/u.test(options.metafileName ?? "")) {
    throw new Error("Bundle provenance metafileName must be one portable JSON filename");
  }
  if (!/^[a-z][a-z0-9-]*$/u.test(options.product ?? "")) {
    throw new Error("Bundle provenance product must be a stable lowercase identifier");
  }
}

/**
 * Captures the complete Rollup module graph and hashes every emitted output.
 * The manifest is intentionally deterministic and contains no machine-local paths.
 */
export function createViteBundleProvenancePlugin(options) {
  assertPluginOptions(options);
  const workspaceRoot = resolve(options.workspaceRoot ?? resolve(options.appRoot, "../.."));
  let resolvedConfig;
  let loadedModules = [];
  const rollupOutputs = new Map();

  return {
    name: `${options.product}-bundle-provenance`,
    apply: "build",
    enforce: "post",
    configResolved(config) {
      resolvedConfig = config;
    },
    generateBundle: {
      order: "post",
      handler(_outputOptions, bundle) {
        loadedModules = [...this.getModuleIds()].map((moduleId) => portableModuleId(moduleId, workspaceRoot)).sort();
        rollupOutputs.clear();

        for (const output of Object.values(bundle)) {
          if (output.type === "asset") {
            rollupOutputs.set(posixPath(output.fileName), {
              dynamicImports: [],
              facadeModuleId: null,
              imports: [],
              isEntry: false,
              modules: [],
              type: "asset"
            });
            continue;
          }
          rollupOutputs.set(posixPath(output.fileName), {
            dynamicImports: [...output.dynamicImports].map(posixPath).sort(),
            facadeModuleId: output.facadeModuleId ? portableModuleId(output.facadeModuleId, workspaceRoot) : null,
            imports: [...output.imports].map(posixPath).sort(),
            isEntry: output.isEntry,
            modules: Object.keys(output.modules)
              .map((moduleId) => portableModuleId(moduleId, workspaceRoot))
              .sort(),
            type: "chunk"
          });
        }
      }
    },
    closeBundle: {
      order: "post",
      handler() {
        if (!resolvedConfig) throw new Error("Vite did not resolve the bundle provenance plugin configuration");
        const outDir = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
        const metafilePath = join(outDir, options.metafileName);
        rmSync(metafilePath, { force: true });

        const outputs = outputFiles(outDir, options.product).map((target) => {
          const fileName = posixPath(relative(outDir, target));
          const contents = readFileSync(target);
          const rollup = rollupOutputs.get(fileName) ?? {
            dynamicImports: [],
            facadeModuleId: null,
            imports: [],
            isEntry: false,
            modules: [],
            type: "asset"
          };
          return {
            fileName,
            bytes: statSync(target).size,
            sha256: sha256(contents),
            ...rollup
          };
        });

        writeFileSync(
          metafilePath,
          `${JSON.stringify(
            {
              schemaVersion: SCHEMA_VERSION,
              kind: MANIFEST_KIND,
              product: options.product,
              entryModule: options.entryModule,
              modules: [...new Set(loadedModules)],
              outputs
            },
            null,
            2
          )}\n`,
          "utf8"
        );
      }
    }
  };
}

function assertPortableOutputName(label, fileName) {
  if (
    typeof fileName !== "string" ||
    fileName === "" ||
    fileName.includes("\\") ||
    posix.isAbsolute(fileName) ||
    posix.normalize(fileName) !== fileName ||
    fileName === ".." ||
    fileName.startsWith("../")
  ) {
    throw new Error(`${label} metafile contains a non-portable output path: ${String(fileName)}`);
  }
}

function assertAllowedWorkspaceModule(policy, allowedWorkspaceRoots, allowedWorkspaceFiles, moduleId) {
  const withSuffix = moduleId.slice("workspace:".length);
  const suffixAt = withSuffix.search(/[?#]/);
  const workspacePath = suffixAt === -1 ? withSuffix : withSuffix.slice(0, suffixAt);
  if (
    !workspacePath ||
    workspacePath.includes("\\") ||
    posix.isAbsolute(workspacePath) ||
    posix.normalize(workspacePath) !== workspacePath ||
    workspacePath === ".." ||
    workspacePath.startsWith("../")
  ) {
    throw new Error(`${policy.displayName} metafile contains a non-portable workspace module: ${moduleId}`);
  }

  if (workspacePath.startsWith("node_modules/")) {
    const hyperionMatches = [...workspacePath.matchAll(/(?:^|\/)node_modules\/@hyperion\/([^/]+)/gu)];
    const foreignDependency = hyperionMatches.find((match) => !policy.allowedHyperionDependencies.includes(match[1]));
    if (foreignDependency) {
      throw new Error(`${policy.displayName} bundle contains foreign Hyperion dependency: ${moduleId}`);
    }
    return;
  }

  if (
    allowedWorkspaceFiles.has(workspacePath) ||
    allowedWorkspaceRoots.some((root) => workspacePath.startsWith(root))
  ) {
    return;
  }
  throw new Error(`${policy.displayName} module is outside its cell/platform allowlist: ${moduleId}`);
}

function assertAllowedModule(policy, allowedWorkspaceRoots, allowedWorkspaceFiles, moduleId) {
  if (typeof moduleId !== "string" || moduleId === "" || moduleId.includes("\\")) {
    throw new Error(`${policy.displayName} metafile contains an invalid module id: ${String(moduleId)}`);
  }
  if (moduleId.startsWith("workspace:")) {
    assertAllowedWorkspaceModule(policy, allowedWorkspaceRoots, allowedWorkspaceFiles, moduleId);
    return;
  }
  if (moduleId.startsWith("virtual-file:")) {
    const wrappedModule = moduleId.slice("virtual-file:".length);
    if (!/[?&]commonjs-(?:entry|es-import|exports|module|proxy)(?:&|$)/u.test(wrappedModule)) {
      throw new Error(`${policy.displayName} bundle contains an unknown virtual file module: ${moduleId}`);
    }
    assertAllowedModule(policy, allowedWorkspaceRoots, allowedWorkspaceFiles, wrappedModule);
    return;
  }
  if (ALLOWED_VIRTUAL_MODULES.has(moduleId)) return;
  throw new Error(`${policy.displayName} bundle contains untrusted module provenance: ${moduleId}`);
}

function parseMetafile(policy, metafilePath) {
  let metafile;
  try {
    metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
  } catch (error) {
    throw new Error(`${policy.displayName} bundle metafile is not valid JSON: ${error.message}`, { cause: error });
  }
  if (
    metafile?.schemaVersion !== SCHEMA_VERSION ||
    metafile.kind !== MANIFEST_KIND ||
    metafile.product !== policy.product ||
    metafile.entryModule !== policy.entryModule ||
    !Array.isArray(metafile.modules) ||
    !Array.isArray(metafile.outputs)
  ) {
    throw new Error(`${policy.displayName} bundle metafile has an unsupported or incomplete schema`);
  }
  return metafile;
}

function assertUniqueStrings(label, values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate entries`);
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new Error("Console bundle policy is required");
  assertPluginOptions({
    appRoot: resolve("."),
    entryModule: policy.entryModule,
    metafileName: policy.metafileName,
    product: policy.product
  });
  for (const field of [
    "allowedHyperionDependencies",
    "allowedWorkspaceFiles",
    "allowedWorkspaceRoots",
    "forbiddenMarkers"
  ]) {
    if (!Array.isArray(policy[field])) throw new Error(`Console bundle policy ${field} must be an array`);
  }
  if (!policy.displayName) throw new Error("Console bundle policy displayName is required");
}

export function verifyConsoleBundle(policy, options) {
  validatePolicy(policy);
  if (!options?.appRoot) throw new Error(`${policy.displayName} bundle verifier requires appRoot`);
  const checkedAppRoot = resolve(options.appRoot);
  const checkedDistRoot = options.distRoot ? resolve(options.distRoot) : join(checkedAppRoot, "dist");
  if (!existsSync(checkedDistRoot)) {
    throw new Error(`${policy.displayName} bundle does not exist; run Vite before the provenance check`);
  }

  const metafilePath = join(checkedDistRoot, policy.metafileName);
  if (!existsSync(metafilePath)) {
    throw new Error(`${policy.displayName} bundle provenance metafile is missing; run the configured Vite build`);
  }
  const metafile = parseMetafile(policy, metafilePath);
  const allowedWorkspaceRoots = [...policy.allowedWorkspaceRoots];
  const allowedWorkspaceFiles = new Set(policy.allowedWorkspaceFiles);

  const moduleSet = new Set();
  for (const moduleId of metafile.modules) {
    if (moduleSet.has(moduleId)) throw new Error(`${policy.displayName} metafile repeats module id: ${moduleId}`);
    assertAllowedModule(policy, allowedWorkspaceRoots, allowedWorkspaceFiles, moduleId);
    moduleSet.add(moduleId);
  }
  if (!moduleSet.has(policy.entryModule)) {
    throw new Error(`${policy.displayName} metafile does not include its declared entry module`);
  }

  const declaredOutputs = new Map();
  let chunks = 0;
  let matchingEntryChunks = 0;
  for (const output of metafile.outputs) {
    assertPortableOutputName(policy.displayName, output?.fileName);
    if (output.fileName === policy.metafileName) {
      throw new Error(`${policy.displayName} metafile cannot include itself in the output inventory`);
    }
    if (declaredOutputs.has(output.fileName)) {
      throw new Error(`${policy.displayName} metafile repeats output: ${output.fileName}`);
    }
    if (
      !["asset", "chunk"].includes(output.type) ||
      !Number.isSafeInteger(output.bytes) ||
      output.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(output.sha256 ?? "") ||
      typeof output.isEntry !== "boolean" ||
      (output.facadeModuleId !== null && typeof output.facadeModuleId !== "string")
    ) {
      throw new Error(`${policy.displayName} metafile has invalid integrity/provenance data for ${output.fileName}`);
    }
    assertUniqueStrings(`${policy.displayName} ${output.fileName} modules`, output.modules);
    assertUniqueStrings(`${policy.displayName} ${output.fileName} imports`, output.imports);
    assertUniqueStrings(`${policy.displayName} ${output.fileName} dynamic imports`, output.dynamicImports);

    if (output.type === "asset") {
      if (
        output.modules.length !== 0 ||
        output.imports.length !== 0 ||
        output.dynamicImports.length !== 0 ||
        output.facadeModuleId !== null ||
        output.isEntry
      ) {
        throw new Error(`${policy.displayName} asset ${output.fileName} contains forged chunk provenance`);
      }
    } else {
      chunks += 1;
      for (const moduleId of output.modules) {
        assertAllowedModule(policy, allowedWorkspaceRoots, allowedWorkspaceFiles, moduleId);
        if (!moduleSet.has(moduleId)) {
          throw new Error(
            `${policy.displayName} chunk ${output.fileName} references an undeclared module: ${moduleId}`
          );
        }
      }
      if (output.facadeModuleId !== null) {
        assertAllowedModule(policy, allowedWorkspaceRoots, allowedWorkspaceFiles, output.facadeModuleId);
        if (!moduleSet.has(output.facadeModuleId)) {
          throw new Error(`${policy.displayName} chunk ${output.fileName} has an undeclared facade module`);
        }
      }
      if (output.isEntry && output.modules.includes(policy.entryModule)) matchingEntryChunks += 1;
    }
    declaredOutputs.set(output.fileName, output);
  }
  if (matchingEntryChunks !== 1) {
    throw new Error(`${policy.displayName} metafile must declare exactly one entry chunk containing its entry module`);
  }

  for (const output of declaredOutputs.values()) {
    if (output.type !== "chunk") continue;
    for (const importedFile of [...output.imports, ...output.dynamicImports]) {
      assertPortableOutputName(policy.displayName, importedFile);
      const importedOutput = declaredOutputs.get(importedFile);
      if (!importedOutput || importedOutput.type !== "chunk") {
        throw new Error(`${policy.displayName} chunk ${output.fileName} imports undeclared chunk ${importedFile}`);
      }
    }
  }

  const actualFiles = outputFiles(checkedDistRoot, policy.displayName)
    .map((target) => posixPath(relative(checkedDistRoot, target)))
    .filter((fileName) => fileName !== policy.metafileName)
    .sort();
  const declaredFiles = [...declaredOutputs.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
    throw new Error(
      `${policy.displayName} metafile output inventory differs from dist (actual=${actualFiles.join(",")}; declared=${declaredFiles.join(",")})`
    );
  }

  const textOutputs = [];
  for (const fileName of actualFiles) {
    const output = declaredOutputs.get(fileName);
    const contents = readFileSync(join(checkedDistRoot, ...fileName.split("/")));
    if (contents.byteLength !== output.bytes || sha256(contents) !== output.sha256) {
      throw new Error(`${policy.displayName} output integrity does not match the metafile: ${fileName}`);
    }
    const searchable = `${fileName}\n${contents.toString("utf8")}`;
    const forbidden = policy.forbiddenMarkers.find(({ pattern }) => pattern.test(searchable));
    if (forbidden) {
      throw new Error(`${policy.displayName} bundle output ${fileName} contains forbidden ${forbidden.label}`);
    }
    textOutputs.push(searchable);
  }
  policy.validateContents?.(textOutputs.join("\n"));

  return { chunks, modules: moduleSet.size, outputs: actualFiles.length };
}
