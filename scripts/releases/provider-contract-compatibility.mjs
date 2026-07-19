import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PROVIDER_CONTRACTS = Object.freeze({
  "platform-contracts": {
    packageName: "@hyperion/platform-contracts",
    directory: "packages/platform-contracts",
    cell: "platform"
  },
  "audit-contracts": {
    packageName: "@hyperion/audit-contracts",
    directory: "packages/audit-contracts",
    cell: "platform"
  },
  "nova-contracts": {
    packageName: "@hyperion/nova-contracts",
    directory: "packages/nova-contracts",
    cell: "nova"
  },
  "lumen-contracts": {
    packageName: "@hyperion/lumen-contracts",
    directory: "packages/lumen-contracts",
    cell: "lumen"
  },
  "pulso-contracts": {
    packageName: "@hyperion/pulso-contracts",
    directory: "packages/pulso-contracts",
    cell: "pulso"
  }
});

const PUBLIC_MANIFEST_FIELDS = [
  "name",
  "version",
  "type",
  "main",
  "module",
  "types",
  "exports",
  "files",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "engines"
];
const SOURCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;
export const SNAPSHOT_FILE_SHA256 = Symbol.for("hyperion.provider-contract.snapshot-file-sha256");

export function parseSemver(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version ?? ""
    );
  if (!match) return null;
  if (
    match[4]
      ?.split(".")
      .some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))
  ) {
    return null;
  }
  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  };
}

export function compareSemver(left, right) {
  const a = typeof left === "string" ? parseSemver(left) : left;
  const b = typeof right === "string" ? parseSemver(right) : right;
  if (!a || !b) throw new Error("compareSemver requires valid SemVer values");
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    if (aParts[index] === undefined) return -1;
    if (bParts[index] === undefined) return 1;
    if (aParts[index] === bParts[index]) continue;
    const aNumber = /^\d+$/.test(aParts[index]) ? Number(aParts[index]) : null;
    const bNumber = /^\d+$/.test(bParts[index]) ? Number(bParts[index]) : null;
    if (aNumber !== null && bNumber !== null) return aNumber < bNumber ? -1 : 1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return aParts[index] < bParts[index] ? -1 : 1;
  }
  return 0;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value))
    .digest("hex");
}

export function publicManifestFrom(manifest) {
  const result = {};
  for (const field of PUBLIC_MANIFEST_FIELDS) {
    if (manifest[field] !== undefined) result[field] = manifest[field];
  }
  return result;
}

export function validatePackedManifest(manifest, expectedName, providerVersions) {
  const errors = [];
  if (manifest.name !== expectedName)
    errors.push(`packed name ${String(manifest.name)} does not equal ${expectedName}`);
  if (!parseSemver(manifest.version)) errors.push(`packed version ${String(manifest.version)} is not SemVer`);
  if (stableJson(manifest).includes("workspace:")) errors.push("packed artifact still contains workspace: protocol");
  for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dependency, range] of Object.entries(manifest[group] ?? {})) {
      if (!dependency.startsWith("@hyperion/")) continue;
      const expected = providerVersions.get(dependency);
      if (!expected) {
        errors.push(`${group}.${dependency} is not a provider-owned contract dependency`);
      } else if (range !== expected) {
        errors.push(`${group}.${dependency} must be exact ${expected}; received ${range}`);
      }
    }
  }
  return errors;
}

function normalizeRuntimeValue(value, state, key = "") {
  if (value === undefined) return { $undefined: true };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "symbol") return { $symbol: String(value) };
  if (typeof value === "function") {
    if (key === "shape" || key === "getter" || key === "defaultValue") {
      try {
        return { $result: normalizeRuntimeValue(value(), state) };
      } catch {
        // A function that cannot be evaluated is still fingerprinted below.
      }
    }
    return { $functionSha256: sha256(Function.prototype.toString.call(value)) };
  }
  if (value instanceof RegExp) return { $regexp: value.source, flags: value.flags };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (state.seen.has(value)) return { $ref: state.seen.get(value) };
  const reference = state.nextReference;
  state.nextReference += 1;
  state.seen.set(value, reference);
  if (Array.isArray(value)) {
    return { $id: reference, $array: value.map((entry) => normalizeRuntimeValue(entry, state)) };
  }
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([mapKey, mapValue]) => [normalizeRuntimeValue(mapKey, state), normalizeRuntimeValue(mapValue, state)])
      .sort((left, right) => stableJson(left[0]).localeCompare(stableJson(right[0])));
    return { $id: reference, $map: entries };
  }
  if (value instanceof Set) {
    const entries = [...value]
      .map((entry) => normalizeRuntimeValue(entry, state))
      .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    return { $id: reference, $set: entries };
  }
  const object = { $id: reference };
  for (const property of Object.keys(value).sort()) {
    if (["description", "errorMap"].includes(property)) continue;
    object[property] = normalizeRuntimeValue(value[property], state, property);
  }
  return object;
}

export function zodSchemaSignature(schema) {
  if (!schema || typeof schema !== "object" || typeof schema.safeParse !== "function" || !schema._def) return null;
  return normalizeRuntimeValue(schema._def, { seen: new WeakMap(), nextReference: 1 });
}

export function buildRuntimeSchemaMap(modulesBySubpath) {
  const schemas = {};
  for (const subpath of Object.keys(modulesBySubpath).sort()) {
    for (const exportName of Object.keys(modulesBySubpath[subpath]).sort()) {
      const value = modulesBySubpath[subpath][exportName];
      const signature = zodSchemaSignature(value);
      if (signature) {
        schemas[`${subpath}#${exportName}`] = {
          typeName: value._def.typeName,
          sha256: sha256(signature)
        };
      }
    }
  }
  return schemas;
}

export function createContractSnapshot({ manifest, declarationFiles, runtimeSchemas, provenance }) {
  const snapshot = {
    schemaVersion: 1,
    packageName: manifest.name,
    version: manifest.version,
    provenance,
    manifest: publicManifestFrom(manifest),
    declarationFiles: Object.fromEntries(
      Object.entries(declarationFiles).sort(([left], [right]) => left.localeCompare(right))
    ),
    runtimeSchemas: Object.fromEntries(
      Object.entries(runtimeSchemas).sort(([left], [right]) => left.localeCompare(right))
    )
  };
  snapshot.contentSha256 = sha256({
    manifest: snapshot.manifest,
    declarationFiles: snapshot.declarationFiles,
    runtimeSchemas: snapshot.runtimeSchemas
  });
  return snapshot;
}

export function validateSnapshot(snapshot, expectedName) {
  const errors = [];
  if (snapshot.schemaVersion !== 1) errors.push("snapshot schemaVersion must equal 1");
  if (snapshot.packageName !== expectedName) errors.push(`snapshot packageName must equal ${expectedName}`);
  if (!parseSemver(snapshot.version)) errors.push("snapshot version must be SemVer");
  if (snapshot.manifest?.name !== snapshot.packageName || snapshot.manifest?.version !== snapshot.version) {
    errors.push("snapshot manifest identity does not match packageName/version");
  }
  if (!snapshot.provenance || !["repository-baseline", "published-registry"].includes(snapshot.provenance.kind)) {
    errors.push("snapshot provenance.kind must be repository-baseline or published-registry");
  }
  if (snapshot.provenance?.kind === "published-registry") {
    if (snapshot.provenance.published !== true) errors.push("published snapshot requires published=true");
    if (!SOURCE_REPOSITORY.test(snapshot.provenance.sourceRepository ?? "")) {
      errors.push("published snapshot requires sourceRepository owner/repository");
    }
    if (!/^(?!0{40}$)[0-9a-f]{40}$/.test(snapshot.provenance.sourceRevision ?? "")) {
      errors.push("published snapshot requires a non-zero 40-character sourceRevision");
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(snapshot.provenance.integrity ?? "")) {
      errors.push("published snapshot requires npm SHA-512 integrity");
    }
    for (const field of ["tarballSha256", "registryMetadataSha256", "verifiedProvenanceSha256"]) {
      if (!SHA256.test(snapshot.provenance[field] ?? "")) {
        errors.push(`published snapshot requires non-zero ${field}`);
      }
    }
    if (typeof snapshot.provenance.builderId !== "string" || !snapshot.provenance.builderId) {
      errors.push("published snapshot requires a provenance builderId");
    }
    let registry;
    let tarball;
    try {
      registry = new URL(snapshot.provenance.registryOrigin);
      tarball = new URL(snapshot.provenance.registryTarball);
    } catch {
      errors.push("published snapshot registry URLs are invalid");
    }
    if (
      registry &&
      (registry.protocol !== "https:" ||
        registry.username ||
        registry.password ||
        registry.search ||
        registry.hash ||
        registry.pathname !== "/")
    ) {
      errors.push("published snapshot registryOrigin must be a credential-free HTTPS origin");
    }
    if (
      registry &&
      tarball &&
      (tarball.protocol !== "https:" ||
        tarball.username ||
        tarball.password ||
        tarball.search ||
        tarball.hash ||
        tarball.origin !== registry.origin)
    ) {
      errors.push("published snapshot tarball must stay on registryOrigin");
    }
  }
  if (
    snapshot.provenance?.kind === "repository-baseline" &&
    (snapshot.provenance.published !== false || snapshot.provenance.sourceRevision !== null)
  ) {
    errors.push("repository baseline must declare published=false and sourceRevision=null");
  }
  if (!snapshot.declarationFiles || Object.keys(snapshot.declarationFiles).length === 0) {
    errors.push("snapshot has no declaration files");
  }
  const expectedHash = sha256({
    manifest: snapshot.manifest,
    declarationFiles: snapshot.declarationFiles,
    runtimeSchemas: snapshot.runtimeSchemas ?? {}
  });
  if (snapshot.contentSha256 !== expectedHash) errors.push("snapshot contentSha256 does not match its public surface");
  return errors;
}

export function selectPreviousSnapshot(snapshots, currentVersion) {
  if (snapshots.length === 0) return null;
  return (
    [...snapshots]
      .sort((left, right) => compareSemver(right.version, left.version))
      .find((snapshot) => compareSemver(snapshot.version, currentVersion) <= 0) ?? null
  );
}

export function requireLatestSnapshot(snapshots, contractId, currentVersion) {
  if (snapshots.length === 0) throw new Error(`${contractId}: no versioned N-1 snapshot exists`);
  const latest = [...snapshots].sort((left, right) => compareSemver(left.version, right.version)).at(-1);
  if (compareSemver(currentVersion, latest.version) < 0) {
    throw new Error(`${contractId}: current ${currentVersion} is older than latest snapshot ${latest.version}`);
  }
  return latest;
}

export function compareSnapshotSurface(previous, current) {
  const errors = [];
  const oldVersion = parseSemver(previous.version);
  const newVersion = parseSemver(current.version);
  if (!oldVersion || !newVersion) return { errors: ["comparison requires SemVer snapshots"], mode: "invalid" };
  const order = compareSemver(newVersion, oldVersion);
  if (order < 0)
    return {
      errors: [`version regressed from snapshot ${previous.version} to ${current.version}`],
      mode: "regression"
    };
  if (order === 0) {
    if (previous.contentSha256 !== current.contentSha256) {
      errors.push(
        `version ${current.version} changed its public artifact; bump SemVer before changing a published surface`
      );
    }
    return { errors, mode: "immutable" };
  }
  if (newVersion.major < oldVersion.major) {
    return { errors: [`major version regressed from ${previous.version} to ${current.version}`], mode: "regression" };
  }
  const mode = newVersion.major > oldVersion.major ? "major-compatible" : "compatible";
  for (const oldSubpath of Object.keys(previous.manifest.exports ?? {})) {
    if (!(oldSubpath in (current.manifest.exports ?? {}))) errors.push(`removed public export subpath ${oldSubpath}`);
  }
  for (const [schemaName, signature] of Object.entries(previous.runtimeSchemas ?? {})) {
    if (!(schemaName in (current.runtimeSchemas ?? {}))) {
      errors.push(`removed runtime schema ${schemaName}`);
    } else if (stableJson(current.runtimeSchemas[schemaName]) !== stableJson(signature)) {
      errors.push(
        `changed runtime schema ${schemaName}; preserve it through N-1 (a major bump does not waive the compatibility window)`
      );
    }
  }
  return { errors, mode };
}

export function requiresNMinusOneTypeComparison(mode) {
  return mode === "compatible" || mode === "major-compatible";
}

export async function readVersionedSnapshots(fixturesRoot, contractId, expectedName) {
  const directory = path.join(fixturesRoot, contractId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const snapshots = [];
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
    const snapshotBytes = await readFile(path.join(directory, entry.name));
    const snapshot = JSON.parse(snapshotBytes.toString("utf8"));
    Object.defineProperty(snapshot, SNAPSHOT_FILE_SHA256, {
      value: createHash("sha256").update(snapshotBytes).digest("hex"),
      enumerable: false,
      writable: false
    });
    const errors = validateSnapshot(snapshot, expectedName);
    if (errors.length > 0) throw new Error(`${contractId}/${entry.name}: ${errors.join("; ")}`);
    if (`${snapshot.version}.json` !== entry.name) {
      throw new Error(`${contractId}/${entry.name}: filename must equal snapshot version ${snapshot.version}.json`);
    }
    snapshots.push(snapshot);
  }
  return snapshots.sort((left, right) => compareSemver(left.version, right.version));
}

function typesTarget(exportDefinition) {
  if (typeof exportDefinition === "string") return exportDefinition;
  if (!exportDefinition || typeof exportDefinition !== "object") return null;
  if (typeof exportDefinition.types === "string") return exportDefinition.types;
  for (const condition of ["import", "default", "node", "require"]) {
    const nested = typesTarget(exportDefinition[condition]);
    if (nested) return nested;
  }
  return null;
}

export function publicTypeEntries(manifest) {
  const result = new Map();
  if (manifest.exports && typeof manifest.exports === "object" && !Array.isArray(manifest.exports)) {
    for (const [subpath, definition] of Object.entries(manifest.exports)) {
      const target = typesTarget(definition);
      if (target) result.set(subpath, target.replace(/^\.\//, ""));
    }
  }
  if (result.size === 0 && manifest.types) result.set(".", manifest.types.replace(/^\.\//, ""));
  return result;
}

function resolveAlias(checker, typescript, symbol) {
  return symbol.flags & typescript.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function symbolDescription(checker, type, node) {
  return checker.typeToString(type, node, 1 | 2 | 8 | 32 | 64 | 1024);
}

function exportedTypeParameterCount(symbol) {
  return Math.max(0, ...(symbol.declarations ?? []).map((declaration) => declaration.typeParameters?.length ?? 0));
}

function declarationModuleSpecifier(fromDirectory, declarationFile) {
  let relative = path.relative(fromDirectory, declarationFile).replaceAll("\\", "/");
  relative = relative.replace(/\.d\.(?:m|c)?ts$/, ".js");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function genericTypeIsAssignable({
  typescript,
  previousFile,
  currentFile,
  currentRoot,
  exportName,
  typeParameterCount
}) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName) || typeParameterCount < 1) return false;
  const compatibilityFile = path.join(currentRoot, `.hyperion-n-minus-one-${exportName}.mts`);
  // `never` satisfies arbitrary constraints while still detecting a current
  // declaration that replaces the type parameter with a concrete type.
  const typeArguments = Array.from({ length: typeParameterCount }, () => "never").join(", ");
  const previousModule = declarationModuleSpecifier(currentRoot, previousFile);
  const currentModule = declarationModuleSpecifier(currentRoot, currentFile);
  const source = [
    `import type * as Previous from ${JSON.stringify(previousModule)};`,
    `import type * as Current from ${JSON.stringify(currentModule)};`,
    `declare const currentValue: Current.${exportName}<${typeArguments}>;`,
    `const previousValue: Previous.${exportName}<${typeArguments}> = currentValue;`,
    "void previousValue;",
    ""
  ].join("\n");
  await writeFile(compatibilityFile, source, "utf8");
  try {
    const program = typescript.createProgram({
      rootNames: [compatibilityFile],
      options: {
        target: typescript.ScriptTarget.ES2022,
        module: typescript.ModuleKind.NodeNext,
        moduleResolution: typescript.ModuleResolutionKind.NodeNext,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowSyntheticDefaultImports: true
      }
    });
    return !typescript
      .getPreEmitDiagnostics(program)
      .some((diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error);
  } finally {
    await rm(compatibilityFile, { force: true });
  }
}

export async function compareTypeSurface({ previousRoot, currentRoot, previousManifest, currentManifest }) {
  const typescript = await import("typescript");
  const previousEntries = publicTypeEntries(previousManifest);
  const currentEntries = publicTypeEntries(currentManifest);
  const rootNames = [];
  const entryPairs = [];
  for (const [subpath, previousTarget] of previousEntries) {
    const currentTarget = currentEntries.get(subpath);
    if (!currentTarget) continue;
    const previousFile = path.join(previousRoot, previousTarget);
    const currentFile = path.join(currentRoot, currentTarget);
    rootNames.push(previousFile, currentFile);
    entryPairs.push({ subpath, previousFile, currentFile });
  }
  const program = typescript.createProgram({
    rootNames,
    options: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.NodeNext,
      moduleResolution: typescript.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowSyntheticDefaultImports: true
    }
  });
  const errors = [];
  for (const diagnostic of typescript.getPreEmitDiagnostics(program)) {
    if (diagnostic.category !== typescript.DiagnosticCategory.Error) continue;
    const message = typescript.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    errors.push(`declaration program error TS${diagnostic.code}: ${message}`);
  }
  if (errors.length > 0) return [...new Set(errors)];
  const checker = program.getTypeChecker();
  for (const { subpath, previousFile, currentFile } of entryPairs) {
    const previousSource = program.getSourceFile(previousFile);
    const currentSource = program.getSourceFile(currentFile);
    if (!previousSource?.symbol || !currentSource?.symbol) {
      errors.push(`${subpath}: declaration entry could not be loaded`);
      continue;
    }
    const previousExports = checker.getExportsOfModule(previousSource.symbol);
    const currentExports = new Map(
      checker.getExportsOfModule(currentSource.symbol).map((symbol) => [symbol.name, symbol])
    );
    for (const previousExportAlias of previousExports) {
      const exportName = previousExportAlias.name;
      const currentExportAlias = currentExports.get(exportName);
      if (!currentExportAlias) {
        errors.push(`${subpath}: removed exported symbol ${exportName}`);
        continue;
      }
      const previousExport = resolveAlias(checker, typescript, previousExportAlias);
      const currentExport = resolveAlias(checker, typescript, currentExportAlias);
      const previousHasValue = Boolean(previousExport.flags & typescript.SymbolFlags.Value);
      const currentHasValue = Boolean(currentExport.flags & typescript.SymbolFlags.Value);
      if (previousHasValue && !currentHasValue) {
        errors.push(`${subpath}: exported value ${exportName} became type-only`);
        continue;
      }
      if (previousHasValue) {
        const previousNode = previousExport.valueDeclaration ?? previousExport.declarations?.[0] ?? previousSource;
        const currentNode = currentExport.valueDeclaration ?? currentExport.declarations?.[0] ?? currentSource;
        const previousType = checker.getTypeOfSymbolAtLocation(previousExport, previousNode);
        const currentType = checker.getTypeOfSymbolAtLocation(currentExport, currentNode);
        if (!checker.isTypeAssignableTo(currentType, previousType)) {
          errors.push(
            `${subpath}: exported value ${exportName} is no longer assignable to N-1 (${symbolDescription(checker, currentType, currentNode)} -> ${symbolDescription(checker, previousType, previousNode)})`
          );
        }
      }
      const previousHasType = Boolean(previousExport.flags & typescript.SymbolFlags.Type);
      const currentHasType = Boolean(currentExport.flags & typescript.SymbolFlags.Type);
      if (previousHasType && !currentHasType) {
        errors.push(`${subpath}: exported type ${exportName} became value-only`);
        continue;
      }
      if (previousHasType && !previousHasValue) {
        const previousType = checker.getDeclaredTypeOfSymbol(previousExport);
        const currentType = checker.getDeclaredTypeOfSymbol(currentExport);
        let assignable = checker.isTypeAssignableTo(currentType, previousType);
        const previousTypeParameters = exportedTypeParameterCount(previousExport);
        const currentTypeParameters = exportedTypeParameterCount(currentExport);
        if (!assignable && previousTypeParameters > 0 && previousTypeParameters === currentTypeParameters) {
          assignable = await genericTypeIsAssignable({
            typescript,
            previousFile,
            currentFile,
            currentRoot,
            exportName,
            typeParameterCount: previousTypeParameters
          });
        }
        if (!assignable) {
          errors.push(`${subpath}: exported type ${exportName} is no longer structurally assignable to N-1`);
        }
      }
    }
  }
  return errors;
}

export function providerContractClosure(requestedIds, manifestsById) {
  const idByName = new Map(Object.entries(PROVIDER_CONTRACTS).map(([id, provider]) => [provider.packageName, id]));
  const closure = new Set();
  const visit = (id) => {
    if (closure.has(id)) return;
    const manifest = manifestsById.get(id);
    if (!manifest) throw new Error(`Missing package manifest for ${id}`);
    closure.add(id);
    for (const group of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(manifest[group] ?? {})) {
        const dependencyId = idByName.get(dependency);
        if (dependencyId) visit(dependencyId);
      }
    }
  };
  for (const id of requestedIds) visit(id);
  return [...closure];
}
