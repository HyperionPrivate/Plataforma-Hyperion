import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const MANIFEST_KIND = "next-turbopack-standalone-build";
const RECEIPT_NAME = "hyperion-build-provenance.json";
const DEFAULT_APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_OUTPUT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".xml",
]);

const FORBIDDEN_MARKERS = Object.freeze([
  { label: "LUMEN product marker", pattern: /(?:^|[^a-z0-9])lumen(?:[^a-z0-9]|$)/iu },
  {
    label: "PULSO product marker",
    pattern: /(?:^|[^a-z0-9])pulso(?:[-_ ]?iris)?(?:[^a-z0-9]|$)/iu,
  },
  { label: "legacy Vite product selector", pattern: /\bVITE_(?:PRODUCT|BRAND_LABEL)\b/u },
]);
const BROWSER_SESSION_MARKERS = Object.freeze([
  { label: "browser localStorage session", pattern: /(?:^|[^A-Za-z])localStorage(?:[^A-Za-z]|$)/u },
  { label: "browser sessionStorage session", pattern: /(?:^|[^A-Za-z])sessionStorage(?:[^A-Za-z]|$)/u },
]);

export const COOPFUTURO_NEXT_POLICY = Object.freeze({
  cell: "nova",
  product: "nova",
  client: "coopfuturo-console",
  contextSourceRoot: "apps/coopfuturo-console",
  receiptName: RECEIPT_NAME,
  inputRoots: Object.freeze([
    "Dockerfile",
    "next.config.ts",
    "package-lock.json",
    "package.json",
    "postcss.config.mjs",
    "public",
    "scripts",
    "src",
    "tsconfig.json",
  ]),
  appRoutes: Object.freeze([
    "/",
    "/_not-found",
    "/campanas",
    "/campanas/nueva",
    "/configuracion",
    "/conversaciones",
    "/crm",
    "/dashboard",
    "/favicon.ico",
    "/handoff",
    "/importar",
    "/laboratorio",
    "/login",
    "/pilot-core/[...slug]",
    "/reportes",
    "/revision-post-llamada",
    "/segmentacion",
  ]),
  pagesRoutes: Object.freeze(["/404", "/_app", "/_document", "/_error"]),
  allowedHyperionDependencies: Object.freeze([]),
});

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJsonFile(target, label) {
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function normalizedPath(value) {
  return value.replaceAll("\\", "/");
}

function assertPortablePath(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\\") ||
    value.normalize("NFC") !== value ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`${label} is not a portable descendant path: ${String(value)}`);
  }
}

function assertPortableTraceReference(value, label) {
  const normalized = typeof value === "string" ? posix.normalize(value) : "";
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\\") ||
    value.normalize("NFC") !== value ||
    posix.isAbsolute(value) ||
    (normalized !== value && `./${normalized}` !== value)
  ) {
    throw new Error(`${label} is not a portable trace reference: ${String(value)}`);
  }
}

function descendantPath(root, candidate, label) {
  const result = relative(root, candidate);
  if (result === "" || result.startsWith("..") || isAbsolute(result)) {
    throw new Error(`${label} escapes its declared root: ${candidate}`);
  }
  return normalizedPath(result);
}

function samePath(left, right) {
  return relative(left, right) === "" && relative(right, left) === "";
}

function assertForbiddenFree(value, label) {
  for (const marker of FORBIDDEN_MARKERS) {
    if (marker.pattern.test(value)) throw new Error(`${label} contains forbidden ${marker.label}`);
  }
}

function assertBrowserSessionFree(value, label) {
  for (const marker of BROWSER_SESSION_MARKERS) {
    if (marker.pattern.test(value)) throw new Error(`${label} contains forbidden ${marker.label}`);
  }
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate entries`);
}

function assertSameStrings(actual, expected, label) {
  const sortedActual = [...actual].sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} differs from its allowlist (actual=${sortedActual.join(",")})`);
  }
}

function assertNoCaseCollisions(entries, key, label) {
  const seen = new Map();
  for (const entry of entries) {
    const value = key(entry);
    const folded = value.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = seen.get(folded);
    if (previous && previous !== value) {
      throw new Error(`${label} has a case-folding collision: ${previous} / ${value}`);
    }
    seen.set(folded, value);
  }
}

function walkRegularFiles(root, label, relativeDirectory = "") {
  const directory = relativeDirectory ? join(root, ...relativeDirectory.split("/")) : root;
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    compareText(left.name, right.name),
  );
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const target = join(root, ...relativePath.split("/"));
    if (entry.isSymbolicLink()) throw new Error(`${label} cannot contain a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) files.push(...walkRegularFiles(root, label, relativePath));
    else if (entry.isFile()) files.push({ relativePath, target });
    else throw new Error(`${label} contains a non-regular entry: ${relativePath}`);
  }
  return files;
}

function requiredRegularFile(target, label) {
  if (!existsSync(target)) throw new Error(`${label} is missing: ${target}`);
  const stats = lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} must be a regular file: ${target}`);
  return stats;
}

function closureSha256(files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\n`, "utf8");
  return hash.digest("hex");
}

function collectInputs(appRoot, policy) {
  const files = [];
  for (const declaredRoot of policy.inputRoots) {
    assertPortablePath(declaredRoot, "Coopfuturo input allowlist entry");
    const target = join(appRoot, ...declaredRoot.split("/"));
    if (!existsSync(target)) throw new Error(`Required Coopfuturo build input is missing: ${declaredRoot}`);
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error(`Coopfuturo build input cannot be a symbolic link: ${declaredRoot}`);
    const candidates = stats.isDirectory()
      ? walkRegularFiles(target, `Coopfuturo build input ${declaredRoot}`).map((file) => ({
          path: `${declaredRoot}/${file.relativePath}`,
          target: file.target,
        }))
      : stats.isFile()
        ? [{ path: declaredRoot, target }]
        : (() => {
            throw new Error(`Coopfuturo build input must be a file or directory: ${declaredRoot}`);
          })();
    for (const candidate of candidates) {
      assertPortablePath(candidate.path, "Coopfuturo build input path");
      const contents = readFileSync(candidate.target);
      files.push({ path: candidate.path, bytes: contents.byteLength, sha256: sha256(contents) });
    }
  }
  files.sort((left, right) => compareText(left.path, right.path));
  assertUnique(
    files.map((file) => file.path),
    "Coopfuturo build input inventory",
  );
  assertNoCaseCollisions(files, (file) => file.path, "Coopfuturo build input inventory");
  return files;
}

function validateDockerContext(appRoot, policy, inputs, requireContextManifest) {
  const target = join(appRoot, ".context-manifest.json");
  if (!existsSync(target)) {
    if (requireContextManifest) {
      throw new Error("The release build requires the generated Coopfuturo Docker context manifest");
    }
    return { verified: false, semanticSha256: null };
  }
  const manifest = parseJsonFile(target, "Coopfuturo Docker context manifest");
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.kind !== "customer-console-context" ||
    manifest.cell !== policy.cell ||
    manifest.client !== policy.client ||
    manifest.sourceRoot !== policy.contextSourceRoot ||
    !Array.isArray(manifest.allowlist) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Coopfuturo Docker context manifest has an unsupported or incomplete schema");
  }
  if (JSON.stringify(manifest.allowlist) !== JSON.stringify(policy.inputRoots)) {
    throw new Error("Coopfuturo Docker context allowlist differs from the build provenance policy");
  }
  const declared = manifest.files.map((file) => ({
    path: file?.path,
    source: file?.source,
    bytes: file?.bytes,
    sha256: file?.sha256,
  }));
  for (const file of declared) {
    assertPortablePath(file.path, "Coopfuturo Docker context file");
    if (file.source !== `${policy.contextSourceRoot}/${file.path}`) {
      throw new Error(`Coopfuturo Docker context has foreign source provenance: ${String(file.source)}`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? "")) {
      throw new Error(`Coopfuturo Docker context has invalid integrity metadata: ${file.path}`);
    }
  }
  declared.sort((left, right) => compareText(left.path, right.path));
  const expected = inputs.map((file) => ({
    ...file,
    source: `${policy.contextSourceRoot}/${file.path}`,
  }));
  const comparableDeclared = declared.map(({ path, bytes, sha256: digest, source }) => ({
    path,
    source,
    bytes,
    sha256: digest,
  }));
  const comparableExpected = expected.map(({ path, source, bytes, sha256: digest }) => ({
    path,
    source,
    bytes,
    sha256: digest,
  }));
  if (JSON.stringify(comparableDeclared) !== JSON.stringify(comparableExpected)) {
    throw new Error("Coopfuturo Docker context inventory differs from the build inputs");
  }
  const semantic = {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    cell: manifest.cell,
    client: manifest.client,
    sourceRoot: manifest.sourceRoot,
    allowlist: manifest.allowlist,
    files: comparableDeclared,
  };
  return { verified: true, semanticSha256: sha256(JSON.stringify(semantic)) };
}

function readNextJson(appRoot, relativePath, label) {
  return parseJsonFile(join(appRoot, ".next", ...relativePath.split("/")), label);
}

function validateRequiredServerFiles(appRoot) {
  const required = readNextJson(appRoot, "required-server-files.json", "Next required-server-files manifest");
  if (
    required?.version !== 1 ||
    required.config?.output !== "standalone" ||
    required.config?.distDir !== ".next" ||
    !Array.isArray(required.files)
  ) {
    throw new Error("Next required-server-files manifest is not a standalone build");
  }
  const checkedRoot = realpathSync(appRoot);
  for (const [label, configuredPath] of [
    ["appDir", required.appDir],
    ["outputFileTracingRoot", required.config.outputFileTracingRoot],
    ["turbopack.root", required.config.turbopack?.root],
  ]) {
    if (typeof configuredPath !== "string" || !existsSync(configuredPath) || !samePath(realpathSync(configuredPath), checkedRoot)) {
      throw new Error(`Next ${label} must be the isolated Coopfuturo app root`);
    }
  }
  const files = required.files.map((file) => normalizedPath(String(file))).sort(compareText);
  assertUnique(files, "Next required server files");
  for (const file of files) {
    assertPortablePath(file, "Next required server file");
    if (!file.startsWith(".next/")) throw new Error(`Next required server file escapes .next: ${file}`);
    requiredRegularFile(join(appRoot, ...file.split("/")), "Next required server source");
    requiredRegularFile(join(appRoot, ".next", "standalone", ...file.split("/")), "Next standalone required server file");
  }
  return files;
}

function validateRouteManifests(appRoot, policy) {
  const routeMapping = readNextJson(appRoot, "app-path-routes-manifest.json", "Next app path route manifest");
  const appPaths = readNextJson(appRoot, "server/app-paths-manifest.json", "Next app paths manifest");
  const routeEntries = Object.entries(routeMapping).sort(([left], [right]) => compareText(left, right));
  const appPathEntries = Object.entries(appPaths).sort(([left], [right]) => compareText(left, right));
  assertSameStrings(
    routeEntries.map(([, route]) => route),
    policy.appRoutes,
    "Coopfuturo Next routes",
  );
  assertSameStrings(
    routeEntries.map(([entry]) => entry),
    appPathEntries.map(([entry]) => entry),
    "Next app path entries",
  );
  const appPathByEntry = new Map(appPathEntries);
  const routes = routeEntries.map(([entry, route]) => {
    if (typeof route !== "string" || !route.startsWith("/") || route.includes("\\")) {
      throw new Error(`Next route is invalid: ${String(route)}`);
    }
    assertForbiddenFree(route, `Next route ${route}`);
    const bundle = appPathByEntry.get(entry);
    assertPortablePath(bundle, `Next route bundle ${entry}`);
    requiredRegularFile(join(appRoot, ".next", "server", ...bundle.split("/")), `Next route bundle ${entry}`);
    if (bundle.endsWith(".js")) {
      requiredRegularFile(
        join(appRoot, ".next", "server", ...`${bundle}.nft.json`.split("/")),
        `Next route trace ${entry}`,
      );
    }
    return { entry, route, bundle };
  });

  const pages = readNextJson(appRoot, "server/pages-manifest.json", "Next pages manifest");
  assertSameStrings(Object.keys(pages), policy.pagesRoutes, "Coopfuturo Next pages routes");
  const pageEntries = Object.entries(pages)
    .sort(([left], [right]) => compareText(left, right))
    .map(([route, bundle]) => {
      assertPortablePath(bundle, `Next pages bundle ${route}`);
      requiredRegularFile(join(appRoot, ".next", "server", ...bundle.split("/")), `Next pages bundle ${route}`);
      if (bundle.endsWith(".js")) {
        requiredRegularFile(
          join(appRoot, ".next", "server", ...`${bundle}.nft.json`.split("/")),
          `Next pages trace ${route}`,
        );
      }
      return { route, bundle };
    });

  const routesManifest = readNextJson(appRoot, "routes-manifest.json", "Next routes manifest");
  const emittedRoutes = [...(routesManifest.staticRoutes ?? []), ...(routesManifest.dynamicRoutes ?? [])].map(
    (route) => route?.page,
  );
  assertSameStrings(emittedRoutes, policy.appRoutes, "Next emitted route table");
  if (
    !Array.isArray(routesManifest.headers) ||
    routesManifest.headers.length !== 0 ||
    !Array.isArray(routesManifest.rewrites?.beforeFiles) ||
    routesManifest.rewrites.beforeFiles.length !== 0 ||
    !Array.isArray(routesManifest.rewrites?.afterFiles) ||
    routesManifest.rewrites.afterFiles.length !== 0 ||
    !Array.isArray(routesManifest.rewrites?.fallback) ||
    routesManifest.rewrites.fallback.length !== 0
  ) {
    throw new Error("Coopfuturo Next build cannot contain custom headers or rewrites");
  }
  const redirects = routesManifest.redirects ?? [];
  if (
    redirects.length !== 1 ||
    redirects[0]?.source !== "/:path+/" ||
    redirects[0]?.destination !== "/:path+" ||
    redirects[0]?.internal !== true ||
    redirects[0]?.statusCode !== 308
  ) {
    throw new Error("Coopfuturo Next build contains an unexpected redirect");
  }

  const middleware = readNextJson(appRoot, "server/middleware-manifest.json", "Next middleware manifest");
  if (
    middleware?.version !== 3 ||
    Object.keys(middleware.middleware ?? {}).length !== 0 ||
    Object.keys(middleware.functions ?? {}).length !== 0 ||
    !Array.isArray(middleware.sortedMiddleware) ||
    middleware.sortedMiddleware.length !== 0
  ) {
    throw new Error("Coopfuturo Next build contains unexpected middleware or edge functions");
  }
  const actions = readNextJson(appRoot, "server/server-reference-manifest.json", "Next server reference manifest");
  if (Object.keys(actions.node ?? {}).length !== 0 || Object.keys(actions.edge ?? {}).length !== 0) {
    throw new Error("Coopfuturo Next build contains unexpected server actions");
  }
  return { routes, pages: pageEntries };
}

function hyperionPackageFromPath(modulePath) {
  const match = modulePath.match(/(?:^|\/)node_modules\/@hyperion\/([^/]+)/u);
  return match?.[1] ?? null;
}

function assertAllowedModulePath(modulePath, policy, label) {
  assertForbiddenFree(modulePath, label);
  const hyperionPackage = hyperionPackageFromPath(modulePath);
  if (hyperionPackage && !policy.allowedHyperionDependencies.includes(hyperionPackage)) {
    throw new Error(`${label} contains foreign Hyperion dependency @hyperion/${hyperionPackage}`);
  }
}

function collectNftTraces(appRoot, policy) {
  const nextRoot = join(appRoot, ".next");
  const traceTargets = walkRegularFiles(nextRoot, "Next build output")
    .filter(
      (file) => !file.relativePath.startsWith("standalone/") && file.relativePath.endsWith(".nft.json"),
    )
    .map((file) => ({ fileName: file.relativePath, target: file.target }));
  traceTargets.sort((left, right) => compareText(left.fileName, right.fileName));
  assertUnique(
    traceTargets.map((trace) => trace.fileName),
    "Next NFT trace inventory",
  );
  for (const requiredTrace of ["next-minimal-server.js.nft.json", "next-server.js.nft.json"]) {
    if (!traceTargets.some((trace) => trace.fileName === requiredTrace)) {
      throw new Error(`Next runtime trace is missing: ${requiredTrace}`);
    }
  }
  const checkedAppRoot = realpathSync(appRoot);
  return traceTargets.map(({ fileName, target }) => {
    requiredRegularFile(target, `Next NFT trace ${fileName}`);
    const trace = parseJsonFile(target, `Next NFT trace ${fileName}`);
    if (trace?.version !== 1 || !Array.isArray(trace.files)) {
      throw new Error(`Next NFT trace has an unsupported schema: ${fileName}`);
    }
    assertUnique(trace.files, `Next NFT trace ${fileName}`);
    const files = trace.files.map((reference) => {
      assertPortableTraceReference(reference, `Next NFT trace ${fileName}`);
      const unresolved = resolve(dirname(target), ...reference.split("/"));
      requiredRegularFile(unresolved, `Next NFT dependency from ${fileName}`);
      const realTarget = realpathSync(unresolved);
      const appRelative = descendantPath(checkedAppRoot, realTarget, `Next NFT dependency from ${fileName}`);
      if (!appRelative.startsWith(".next/") && !appRelative.startsWith("node_modules/")) {
        throw new Error(`Next NFT trace reaches an untrusted local source: ${appRelative}`);
      }
      assertAllowedModulePath(appRelative, policy, `Next NFT dependency ${appRelative}`);
      return `app:${appRelative}`;
    });
    files.sort(compareText);
    return { fileName, files };
  });
}

function parseClientReferenceManifest(target, label) {
  const source = readFileSync(target, "utf8");
  const assignment = source.lastIndexOf("globalThis.__RSC_MANIFEST[");
  const equals = assignment === -1 ? -1 : source.indexOf(" = ", assignment);
  if (equals === -1) throw new Error(`${label} has an unsupported assignment format`);
  const payload = source.slice(equals + 3).trim().replace(/;$/u, "");
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`${label} payload is not valid JSON: ${error.message}`, { cause: error });
  }
}

function validateProjectModuleId(moduleId, policy, label) {
  if (typeof moduleId !== "string" || !moduleId.startsWith("[project]/")) {
    throw new Error(`${label} is not rooted in the isolated Next project: ${String(moduleId)}`);
  }
  const suffix = moduleId.indexOf(" <");
  const modulePath = moduleId.slice("[project]/".length, suffix === -1 ? undefined : suffix);
  assertPortablePath(modulePath, label);
  if (!modulePath.startsWith("src/") && !modulePath.startsWith("node_modules/")) {
    throw new Error(`${label} is outside the customer/NOVA source allowlist: ${modulePath}`);
  }
  assertAllowedModulePath(modulePath, policy, label);
}

function collectClientReferences(appRoot, policy) {
  const appServerRoot = join(appRoot, ".next", "server", "app");
  const manifests = walkRegularFiles(appServerRoot, "Next app server output")
    .filter((file) => file.relativePath.endsWith("_client-reference-manifest.js"))
    .sort((left, right) => compareText(left.relativePath, right.relativePath));
  if (manifests.length === 0) throw new Error("Next build emitted no client reference manifests");
  return manifests.map((file) => {
    const parsed = parseClientReferenceManifest(file.target, `Next client reference manifest ${file.relativePath}`);
    if (!parsed?.clientModules || typeof parsed.clientModules !== "object" || Array.isArray(parsed.clientModules)) {
      throw new Error(`Next client reference manifest has no client module graph: ${file.relativePath}`);
    }
    const modules = Object.entries(parsed.clientModules)
      .sort(([left], [right]) => compareText(left, right))
      .map(([moduleId, metadata]) => {
        validateProjectModuleId(moduleId, policy, `Next client module ${moduleId}`);
        if (!Array.isArray(metadata?.chunks)) {
          throw new Error(`Next client module has no chunk provenance: ${moduleId}`);
        }
        assertUnique(metadata.chunks, `Next client module chunks ${moduleId}`);
        const chunks = metadata.chunks.map((chunk) => {
          if (typeof chunk !== "string" || !chunk.startsWith("/_next/static/")) {
            throw new Error(`Next client module references an invalid chunk: ${String(chunk)}`);
          }
          const outputPath = `.next/${chunk.slice("/_next/".length)}`;
          assertPortablePath(outputPath, `Next client chunk ${chunk}`);
          requiredRegularFile(join(appRoot, ...outputPath.split("/")), `Next client chunk ${chunk}`);
          return outputPath;
        });
        chunks.sort(compareText);
        return { moduleId, chunks };
      });
    return { fileName: `server/app/${file.relativePath}`, modules };
  });
}

function collectStandalonePackages(appRoot, policy) {
  const standaloneRoot = join(appRoot, ".next", "standalone");
  const nodeModulesRoot = join(standaloneRoot, "node_modules");
  const lock = parseJsonFile(join(appRoot, "package-lock.json"), "Coopfuturo package lock");
  if (!lock?.packages || typeof lock.packages !== "object") {
    throw new Error("Coopfuturo package lock does not expose an npm package inventory");
  }
  const packages = [];
  for (const file of walkRegularFiles(nodeModulesRoot, "Next standalone node_modules")) {
    const packageJsonPath = `node_modules/${file.relativePath}`;
    if (!/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(packageJsonPath)) continue;
    const packageRoot = packageJsonPath.slice(0, -"/package.json".length);
    const manifest = parseJsonFile(file.target, `Next standalone package ${packageRoot}`);
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Next standalone package has incomplete identity: ${packageRoot}`);
    }
    const locked = lock.packages[packageRoot];
    if (!locked || locked.version !== manifest.version) {
      throw new Error(`Next standalone package differs from package-lock.json: ${manifest.name}@${manifest.version}`);
    }
    assertAllowedModulePath(packageRoot, policy, `Next standalone package ${manifest.name}`);
    packages.push({ path: packageRoot, name: manifest.name, version: manifest.version });
  }
  packages.sort((left, right) => compareText(left.path, right.path));
  assertUnique(
    packages.map((item) => item.path),
    "Next standalone package inventory",
  );
  const nextPackage = packages.find((item) => item.name === "next");
  if (!nextPackage) throw new Error("Next standalone output does not contain the locked Next runtime");
  const standaloneManifest = parseJsonFile(join(standaloneRoot, "package.json"), "Next standalone package manifest");
  if (standaloneManifest.name !== policy.client) {
    throw new Error(`Next standalone package must belong to ${policy.client}`);
  }
  return { nextVersion: nextPackage.version, packages };
}

function isSearchableOutput(fileName) {
  const extension = posix.extname(fileName).toLowerCase();
  return TEXT_OUTPUT_EXTENSIONS.has(extension) || fileName === "server.js";
}

function collectArtifact(appRoot, policy) {
  const roots = [
    { source: ".next/standalone", target: "." },
    { source: "public", target: "public" },
    { source: ".next/static", target: ".next/static" },
  ];
  const files = [];
  for (const root of roots) {
    const sourceRoot = join(appRoot, ...root.source.split("/"));
    if (!existsSync(sourceRoot)) throw new Error(`Next deployment root is missing: ${root.source}`);
    for (const file of walkRegularFiles(sourceRoot, `Next deployment root ${root.source}`)) {
      if (root.source === ".next/standalone" && file.relativePath === policy.receiptName) continue;
      const fileName = root.target === "." ? file.relativePath : `${root.target}/${file.relativePath}`;
      assertPortablePath(fileName, "Next deployment output");
      assertForbiddenFree(fileName, `Next deployment output ${fileName}`);
      const contents = readFileSync(file.target);
      if (isSearchableOutput(fileName)) {
        assertForbiddenFree(contents.toString("utf8"), `Next deployment output ${fileName}`);
        if (!fileName.startsWith("node_modules/")) {
          assertBrowserSessionFree(contents.toString("utf8"), `Next deployment output ${fileName}`);
        }
      }
      files.push({
        fileName,
        source: `${root.source}/${file.relativePath}`,
        bytes: contents.byteLength,
        sha256: sha256(contents),
      });
    }
  }
  files.sort((left, right) => compareText(left.fileName, right.fileName));
  assertUnique(
    files.map((file) => file.fileName),
    "Next deployment inventory",
  );
  assertNoCaseCollisions(files, (file) => file.fileName, "Next deployment inventory");
  return {
    roots,
    algorithm: "sha256-path-null-content-sha256-lf-v1",
    closureSha256: closureSha256(files.map(({ fileName: path, sha256: digest }) => ({ path, sha256: digest }))),
    files,
  };
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new Error("Next build provenance policy is required");
  for (const field of ["cell", "product", "client", "contextSourceRoot", "receiptName"]) {
    if (typeof policy[field] !== "string" || policy[field] === "") {
      throw new Error(`Next build provenance policy is missing ${field}`);
    }
  }
  for (const field of ["inputRoots", "appRoutes", "pagesRoutes", "allowedHyperionDependencies"]) {
    if (!Array.isArray(policy[field])) throw new Error(`Next build provenance policy is missing ${field}`);
  }
  assertPortablePath(policy.receiptName, "Next build provenance receipt name");
}

export function collectNextBuildProvenance({
  appRoot = DEFAULT_APP_ROOT,
  policy = COOPFUTURO_NEXT_POLICY,
  requireContextManifest = process.env.HYPERION_REQUIRE_CONTEXT_MANIFEST === "1",
} = {}) {
  validatePolicy(policy);
  const checkedAppRoot = resolve(appRoot);
  const inputs = collectInputs(checkedAppRoot, policy);
  const dockerContext = validateDockerContext(checkedAppRoot, policy, inputs, requireContextManifest);
  const buildId = readFileSync(join(checkedAppRoot, ".next", "BUILD_ID"), "utf8").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(buildId)) throw new Error("Next BUILD_ID is invalid");
  const requiredServerFiles = validateRequiredServerFiles(checkedAppRoot);
  const routeData = validateRouteManifests(checkedAppRoot, policy);
  const traces = collectNftTraces(checkedAppRoot, policy);
  const clientReferences = collectClientReferences(checkedAppRoot, policy);
  const packageData = collectStandalonePackages(checkedAppRoot, policy);
  const artifact = collectArtifact(checkedAppRoot, policy);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    cell: policy.cell,
    product: policy.product,
    client: policy.client,
    buildId,
    source: {
      algorithm: "sha256-path-null-content-sha256-lf-v1",
      closureSha256: closureSha256(inputs),
      dockerContext,
      files: inputs,
    },
    next: {
      version: packageData.nextVersion,
      requiredServerFiles,
      routes: routeData.routes,
      pages: routeData.pages,
      traces,
      clientReferences,
      packages: packageData.packages,
    },
    artifact,
  };
}

function receiptPath(appRoot, policy) {
  return join(resolve(appRoot), ".next", "standalone", policy.receiptName);
}

export function verifyNextBuildProvenance(options = {}) {
  const policy = options.policy ?? COOPFUTURO_NEXT_POLICY;
  validatePolicy(policy);
  const appRoot = resolve(options.appRoot ?? DEFAULT_APP_ROOT);
  const target = receiptPath(appRoot, policy);
  if (!existsSync(target)) throw new Error("Coopfuturo Next build provenance receipt is missing; run the build first");
  const declared = parseJsonFile(target, "Coopfuturo Next build provenance receipt");
  const expected = collectNextBuildProvenance({ ...options, appRoot, policy });
  for (const section of [
    "schemaVersion",
    "kind",
    "cell",
    "product",
    "client",
    "buildId",
    "source",
    "next",
    "artifact",
  ]) {
    if (JSON.stringify(declared?.[section]) !== JSON.stringify(expected[section])) {
      throw new Error(`Coopfuturo Next build provenance does not match ${section}`);
    }
  }
  return {
    inputs: expected.source.files.length,
    routes: expected.next.routes.length,
    clientModules: expected.next.clientReferences.reduce((count, manifest) => count + manifest.modules.length, 0),
    traces: expected.next.traces.length,
    packages: expected.next.packages.length,
    outputs: expected.artifact.files.length,
  };
}

export function emitNextBuildProvenance(options = {}) {
  const policy = options.policy ?? COOPFUTURO_NEXT_POLICY;
  validatePolicy(policy);
  const appRoot = resolve(options.appRoot ?? DEFAULT_APP_ROOT);
  const manifest = collectNextBuildProvenance({ ...options, appRoot, policy });
  writeFileSync(receiptPath(appRoot, policy), json(manifest), "utf8");
  return verifyNextBuildProvenance({ ...options, appRoot, policy });
}

function main() {
  const command = process.argv[2];
  if (!new Set(["--emit", "--verify"]).has(command) || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/check-bundle.mjs --emit|--verify");
  }
  const result = command === "--emit" ? emitNextBuildProvenance() : verifyNextBuildProvenance();
  process.stdout.write(
    `Coopfuturo Next provenance OK (${result.inputs} inputs, ${result.routes} routes, ${result.clientModules} client module references, ${result.traces} traces, ${result.packages} packages, ${result.outputs} outputs)\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
