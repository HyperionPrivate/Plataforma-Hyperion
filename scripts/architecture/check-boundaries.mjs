import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const DEFAULT_CONFIG = "docs/architecture/data-ownership.json";
const DEFAULT_BASELINE = "docs/architecture/boundary-baseline.json";
// Backwards-compatible default for focused fixtures. The repository config
// declares explicit migration scopes so every provider-owned logical database
// is evaluated independently and discovery can fail closed on new migrators.
const DEFAULT_EFFECTIVE_MIGRATION_OVERLAY_ROOTS = ["packages/platform-migrations/sql"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function normalizeTable(schema, table) {
  return `${schema}.${table}`.toLowerCase();
}

function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
}

function sourceScriptKind(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function stringContents(sourceText, filePath = "source.ts") {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceScriptKind(filePath));
  const contents = [];

  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      contents.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) value += ` __expression__ ${span.literal.text}`;
      contents.push(value);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return contents;
}

export function extractSqlAccesses(sourceText, filePath = "source.ts") {
  const accesses = [];
  for (const content of stringContents(sourceText, filePath)) {
    accesses.push(...extractSqlAccessesFromSql(content));
  }
  return accesses;
}

export function extractSqlAccessesFromSql(sqlText) {
  const accesses = [];
  const pattern =
    /\b(from|join|insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into|copy)\s+(?:only\s+)?"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?/gi;

  for (const match of sqlText.matchAll(pattern)) {
    const keyword = match[1].toLowerCase().replace(/\s+/g, " ");
    const access = keyword === "from" || keyword === "join" ? "read" : "write";
    const remainder = sqlText.slice((match.index ?? 0) + match[0].length);
    const objectType = access === "read" && /^\s*\(/.test(remainder) ? "routine" : "table";
    accesses.push({ access, object: normalizeTable(match[2], match[3]), objectType });
  }

  return accesses;
}

function tableNameFromMatch(match) {
  return normalizeTable(match[1], match[2]);
}

function splitTopLevelSqlClauses(value) {
  const clauses = [];
  let start = 0;
  let depth = 0;
  let quote = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];

    if (quote === "'") {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")" && depth > 0) depth -= 1;
    else if (character === "," && depth === 0) {
      clauses.push({ start, text: value.slice(start, index) });
      start = index + 1;
    }
  }

  clauses.push({ start, text: value.slice(start) });
  return clauses;
}

function foreignKeysInClause(clause, source, basePosition) {
  const foreignKeys = [];
  const foreignKeyPattern =
    /(?:\bconstraint\s+"?([a-z_][a-z0-9_$]*)"?\s+)?(?:foreign\s+key\s*\(([^)]*)\)\s*)?\breferences\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?/gi;

  for (const match of clause.matchAll(foreignKeyPattern)) {
    const constraintName = match[1]?.toLowerCase() ?? inferPostgresForeignKeyName(source, clause, match[2]);
    foreignKeys.push({
      constraintName,
      position: basePosition + (match.index ?? 0),
      source,
      target: normalizeTable(match[3], match[4]),
      type: "add"
    });
  }

  return foreignKeys;
}

function inferPostgresForeignKeyName(source, clause, tableLevelColumns) {
  let columns;
  if (tableLevelColumns !== undefined) {
    columns = parseIdentifierList(tableLevelColumns);
  } else {
    const inlineColumn = clause.match(/^\s*"?([a-z_][a-z0-9_$]*)"?\b/i)?.[1];
    columns = inlineColumn ? [inlineColumn.toLowerCase()] : [];
  }

  if (columns.length === 0) return null;
  const table = source.split(".").at(-1);
  const generatedName = `${table}_${columns.join("_")}_fkey`;

  // PostgreSQL truncates overlong identifiers using an internal balancing
  // algorithm. Do not guess in that case: retaining the FK is safer than
  // allowing an unrelated DROP CONSTRAINT to hide it.
  return Buffer.byteLength(generatedName, "utf8") <= 63 ? generatedName : null;
}

function parseIdentifierList(value) {
  const columns = value.split(",").map((entry) => entry.trim());
  if (columns.length === 0 || columns.some((entry) => !/^"?[a-z_][a-z0-9_$]*"?$/i.test(entry))) {
    return [];
  }
  return columns.map((entry) => entry.replace(/^"|"$/g, "").toLowerCase());
}

export function extractMigrationStructure(sqlText) {
  const sql = stripSqlComments(sqlText);
  const declarations = [];
  const foreignKeys = [];
  const foreignKeyEvents = [];
  const routines = [];
  const routineEvents = [];
  const plpgsqlAccesses = [];
  const securityDefiners = [];
  const triggers = [];
  const triggerEvents = [];
  const createPattern =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\)\s*;/gi;
  const alterPattern =
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?([\s\S]*?);/gi;
  const routinePattern =
    /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?/gi;
  const routineBodyPattern =
    /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?([\s\S]*?)\$([A-Za-z_]*)\$([\s\S]*?)\$\4\$/gi;
  const dropRoutinePattern =
    /drop\s+(?:function|procedure)\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?(?:\s*\([^;]*?\))?(?:\s+(?:cascade|restrict))?\s*;/gi;
  const triggerPattern =
    /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+"?([a-z_][a-z0-9_]*)"?\s+[\s\S]*?\bon\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?[\s\S]*?\bexecute\s+(?:function|procedure)\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?/gi;
  const dropTriggerPattern =
    /drop\s+trigger\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s+on\s+(?:only\s+)?"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?(?:\s+(?:cascade|restrict))?\s*;/gi;

  for (const match of sql.matchAll(createPattern)) {
    const source = tableNameFromMatch(match);
    declarations.push(source);
    const bodyPosition = (match.index ?? 0) + match[0].indexOf(match[3]);
    for (const clause of splitTopLevelSqlClauses(match[3])) {
      const additions = foreignKeysInClause(clause.text, source, bodyPosition + clause.start);
      foreignKeys.push(
        ...additions.map(({ constraintName, source: fkSource, target }) => ({
          constraintName,
          source: fkSource,
          target
        }))
      );
      foreignKeyEvents.push(...additions);
    }
  }

  for (const match of sql.matchAll(alterPattern)) {
    const source = tableNameFromMatch(match);
    const bodyPosition = (match.index ?? 0) + match[0].indexOf(match[3]);
    for (const clause of splitTopLevelSqlClauses(match[3])) {
      const clausePosition = bodyPosition + clause.start;
      const drop = clause.text.match(/^\s*drop\s+constraint\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_$]*)"?/i);
      if (drop) {
        foreignKeyEvents.push({
          constraintName: drop[1].toLowerCase(),
          position: clausePosition + (drop.index ?? 0),
          source,
          type: "drop"
        });
      }

      const additions = foreignKeysInClause(clause.text, source, clausePosition);
      foreignKeys.push(
        ...additions.map(({ constraintName, source: fkSource, target }) => ({
          constraintName,
          source: fkSource,
          target
        }))
      );
      foreignKeyEvents.push(...additions);
    }
  }

  for (const match of sql.matchAll(routinePattern)) routines.push(tableNameFromMatch(match));

  for (const match of sql.matchAll(routineBodyPattern)) {
    const routine = normalizeTable(match[1], match[2]);
    const header = match[3] ?? "";
    const body = match[5] ?? "";
    const securityDefiner = /\bsecurity\s+definer\b/i.test(header);
    if (securityDefiner) securityDefiners.push(routine);
    const accesses = extractSqlAccessesFromSql(body).map((access) => ({
      routine,
      securityDefiner,
      ...access
    }));
    routineEvents.push({
      accesses,
      position: match.index ?? 0,
      routine,
      securityDefiner,
      type: "upsert"
    });
    plpgsqlAccesses.push(...accesses);
  }

  for (const match of sql.matchAll(dropRoutinePattern)) {
    routineEvents.push({
      position: match.index ?? 0,
      routine: normalizeTable(match[1], match[2]),
      type: "drop"
    });
  }

  for (const match of sql.matchAll(triggerPattern)) {
    const trigger = {
      name: match[1].toLowerCase(),
      table: normalizeTable(match[2], match[3]),
      routine: normalizeTable(match[4], match[5])
    };
    triggers.push(trigger);
    triggerEvents.push({ ...trigger, position: match.index ?? 0, type: "upsert" });
  }

  for (const match of sql.matchAll(dropTriggerPattern)) {
    triggerEvents.push({
      name: match[1].toLowerCase(),
      position: match.index ?? 0,
      table: normalizeTable(match[2], match[3]),
      type: "drop"
    });
  }

  foreignKeyEvents.sort((left, right) => left.position - right.position);
  routineEvents.sort((left, right) => left.position - right.position);
  triggerEvents.sort((left, right) => left.position - right.position);
  return {
    declarations,
    foreignKeys,
    foreignKeyEvents,
    routines,
    routineEvents,
    plpgsqlAccesses,
    securityDefiners,
    triggers,
    triggerEvents
  };
}

async function walk(root, extensions) {
  const files = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (extensions.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  await visit(root);
  return files.sort();
}

function ownerForPath(relativePath, pathOwners) {
  const candidate = relativePath.toLowerCase();
  const match = pathOwners
    .map((entry) => ({ ...entry, prefix: entry.prefix.toLowerCase().replace(/\\/g, "/") }))
    .sort((left, right) => right.prefix.length - left.prefix.length)
    .find((entry) => candidate.startsWith(entry.prefix));
  return match?.owner;
}

function isExcludedSource(relativePath, patterns) {
  return patterns.some((pattern) => relativePath.includes(pattern));
}

function addCount(map, violation) {
  const current = map.get(violation.id);
  if (current) current.count += violation.count ?? 1;
  else map.set(violation.id, { ...violation, count: violation.count ?? 1 });
}

function tableOwner(config, table) {
  return config.tables[table];
}

function databaseObjectOwner(config, object, objectType) {
  return objectType === "routine" ? config.routines?.[object] : tableOwner(config, object);
}

function managedObjectProblem(config, object, objectType) {
  const schema = object.split(".")[0];
  return config.managedSchemas.includes(schema) && !databaseObjectOwner(config, object, objectType);
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

export function validateTemporaryExceptions(exceptions = [], today = currentUtcDate()) {
  const errors = [];
  const activeIds = new Set();
  const seenIds = new Set();

  for (const [index, entry] of exceptions.entries()) {
    const label = entry?.id || `temporaryExceptions[${index}]`;
    const validId = typeof entry?.id === "string" && entry.id.trim().length > 0;
    const validOwner = typeof entry?.owner === "string" && entry.owner.trim().length > 0;
    const validIssue = typeof entry?.issue === "string" && /^[A-Z][A-Z0-9]+-[A-Z0-9-]+$/.test(entry.issue);
    const validJustification = typeof entry?.justification === "string" && entry.justification.trim().length >= 20;
    const validExpiry = typeof entry?.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.expiresAt);

    if (!validId || !validOwner || !validIssue || !validJustification || !validExpiry) {
      errors.push(
        `${label}: exception requires non-empty id/owner, issue, justification (>=20 chars) and ISO expiresAt`
      );
      continue;
    }
    if (seenIds.has(entry.id)) {
      errors.push(`${label}: duplicate temporary exception id`);
      continue;
    }
    seenIds.add(entry.id);
    if (entry.expiresAt < today) {
      errors.push(`${label}: temporary exception expired on ${entry.expiresAt}`);
      continue;
    }
    activeIds.add(entry.id);
  }

  return { activeIds, errors };
}

function normalizedMigrationRoot(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = toPosix(path.normalize(value.trim())).replace(/^\.\//, "");
  if (path.isAbsolute(value) || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

async function discoverMigrationPackageRoots(root, packagesRoot) {
  const discovered = [];
  const errors = [];
  const absolutePackagesRoot = path.join(root, packagesRoot);
  let entries;
  try {
    entries = await readdir(absolutePackagesRoot, { withFileTypes: true });
  } catch (error) {
    return {
      discovered,
      errors: [`No se pudo descubrir migradores en ${packagesRoot}: ${error.message}`]
    };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = toPosix(path.join(packagesRoot, entry.name));
    const manifestPath = path.join(root, packageRoot, "package.json");
    let manifest;
    let manifestMissing = false;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") manifestMissing = true;
      else errors.push(`${packageRoot}/package.json no se pudo validar: ${error.message}`);
    }
    const namedMigrator = entry.name === "migrations" || entry.name.endsWith("-migrations");
    const hasMigrateScript = typeof manifest?.scripts?.migrate === "string" && manifest.scripts.migrate.trim() !== "";
    let sqlFiles = [];
    try {
      sqlFiles = await walk(path.join(root, packageRoot, "sql"), new Set([".sql"]));
    } catch (error) {
      if (hasMigrateScript || namedMigrator) errors.push(`${packageRoot}/sql no se pudo escanear: ${error.message}`);
    }
    if (!hasMigrateScript && !(namedMigrator && sqlFiles.length > 0)) continue;
    if (manifestMissing) errors.push(`${packageRoot}/package.json falta para un migrador descubierto`);
    else if (namedMigrator && !hasMigrateScript) {
      errors.push(`${packageRoot}/package.json debe declarar scripts.migrate`);
    }
    discovered.push(`${packageRoot}/sql`);
  }

  return { discovered: discovered.sort(), errors };
}

export async function resolveMigrationScopes(root, scan) {
  const effective = scan?.migrationStateMode === "effective";
  if (!effective || scan?.migrationScopes === undefined) {
    const roots = [
      scan?.migrationRoot,
      ...(effective ? (scan?.effectiveMigrationOverlayRoots ?? DEFAULT_EFFECTIVE_MIGRATION_OVERLAY_ROOTS) : [])
    ].filter(Boolean);
    return { errors: [], scopes: [{ id: effective ? "effective" : "historical", roots: [...new Set(roots)] }] };
  }

  const errors = [];
  const scopes = [];
  const seenIds = new Set();
  const seenRoots = new Set();
  if (!Array.isArray(scan.migrationScopes) || scan.migrationScopes.length === 0) {
    return { errors: ["scan.migrationScopes debe ser un arreglo no vacío"], scopes };
  }

  for (const [index, candidate] of scan.migrationScopes.entries()) {
    const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      errors.push(`scan.migrationScopes[${index}].id no es válido`);
      continue;
    }
    if (seenIds.has(id)) errors.push(`scan.migrationScopes repite el scope ${id}`);
    seenIds.add(id);
    if (!Array.isArray(candidate.roots) || candidate.roots.length === 0) {
      errors.push(`scan.migrationScopes.${id}.roots debe ser un arreglo no vacío`);
      continue;
    }
    const mode = candidate.mode ?? "independent";
    if (!new Set(["independent", "legacy-overlay"]).has(mode)) {
      errors.push(`scan.migrationScopes.${id}.mode no es válido`);
    }
    if (candidate.roots.length > 1 && mode !== "legacy-overlay") {
      errors.push(`scan.migrationScopes.${id} no puede mezclar migradores provider-owned independientes`);
    }
    const legacyRoot = normalizedMigrationRoot(scan.migrationRoot);
    if (
      mode === "legacy-overlay" &&
      (candidate.roots.length < 2 || normalizedMigrationRoot(candidate.roots[0]) !== legacyRoot)
    ) {
      errors.push(
        `scan.migrationScopes.${id} legacy-overlay debe comenzar por scan.migrationRoot y declarar un overlay`
      );
    }
    if (mode === "legacy-overlay") {
      if (typeof candidate.owner !== "string" || !candidate.owner.trim()) {
        errors.push(`scan.migrationScopes.${id} legacy-overlay no declara owner`);
      }
      if (typeof candidate.issue !== "string" || !/^[A-Z][A-Z0-9]+-[A-Z0-9-]+$/.test(candidate.issue)) {
        errors.push(`scan.migrationScopes.${id} legacy-overlay no declara issue válido`);
      }
      if (
        typeof candidate.expiresAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(candidate.expiresAt) ||
        candidate.expiresAt < currentUtcDate()
      ) {
        errors.push(`scan.migrationScopes.${id} legacy-overlay no declara expiresAt vigente`);
      }
    }
    const roots = [];
    for (const value of candidate.roots) {
      const migrationRoot = normalizedMigrationRoot(value);
      if (!migrationRoot) {
        errors.push(`scan.migrationScopes.${id} contiene una ruta inválida`);
        continue;
      }
      if (seenRoots.has(migrationRoot)) {
        errors.push(`scan.migrationScopes registra más de una vez ${migrationRoot}`);
        continue;
      }
      seenRoots.add(migrationRoot);
      roots.push(migrationRoot);
      try {
        const sqlFiles = await walk(path.join(root, migrationRoot), new Set([".sql"]));
        if (sqlFiles.length === 0) errors.push(`${migrationRoot} no contiene migraciones SQL`);
      } catch (error) {
        errors.push(`${migrationRoot} no se pudo escanear: ${error.message}`);
      }
    }
    scopes.push({ id, roots });
  }

  const packagesRoot = normalizedMigrationRoot(scan.migrationPackagesRoot ?? "packages");
  if (!packagesRoot) {
    errors.push("scan.migrationPackagesRoot no es una ruta válida");
  } else {
    const discovery = await discoverMigrationPackageRoots(root, packagesRoot);
    errors.push(...discovery.errors);
    for (const migrationRoot of discovery.discovered) {
      if (!seenRoots.has(migrationRoot)) {
        errors.push(`Migrador descubierto no registrado en migrationScopes: ${migrationRoot}`);
      }
    }
    for (const migrationRoot of seenRoots) {
      if (!discovery.discovered.includes(migrationRoot)) {
        errors.push(`migrationScopes registra una raíz sin package migrador: ${migrationRoot}`);
      }
    }
  }

  return { errors: [...new Set(errors)].sort(), scopes };
}

export async function detectBoundaryViolations(root, config) {
  const violations = new Map();
  const exceptionValidation = validateTemporaryExceptions(config.temporaryExceptions);
  const structuralErrors = [...exceptionValidation.errors];
  const effectiveMigrationState = config.scan.migrationStateMode === "effective";
  const sourceExtensions = new Set(config.scan.sourceExtensions ?? [...SOURCE_EXTENSIONS]);
  const isTemporaryException = (id) => exceptionValidation.activeIds.has(id);

  for (const sourceRoot of config.scan.sourceRoots) {
    const absoluteRoot = path.join(root, sourceRoot);
    for (const file of await walk(absoluteRoot, sourceExtensions)) {
      const relativePath = toPosix(path.relative(root, file));
      if (isExcludedSource(relativePath, config.scan.excludePathContains ?? [])) continue;
      const accesses = extractSqlAccesses(await readFile(file, "utf8"), relativePath);
      if (accesses.length === 0) continue;
      const sourceOwner = ownerForPath(relativePath, config.pathOwners);

      for (const { access, object, objectType } of accesses) {
        if (managedObjectProblem(config, object, objectType)) {
          structuralErrors.push(
            `Referencia a ${objectType === "routine" ? "rutina" : "tabla"} sin propietario: ${relativePath} -> ${object}`
          );
          continue;
        }
        const targetOwner = databaseObjectOwner(config, object, objectType);
        if (!targetOwner) continue;
        if (!sourceOwner) {
          structuralErrors.push(`Ruta con SQL de dominio sin propietario: ${relativePath} -> ${object}`);
          continue;
        }
        // Migration tooling is administrative and may inspect multiple owners.
        if (sourceOwner === "migration-control") continue;
        if (sourceOwner === targetOwner) continue;
        const id = `sql-access|${relativePath}|${sourceOwner}->${targetOwner}|${access}|${objectType}|${object}`;
        if (isTemporaryException(id)) continue;
        addCount(violations, {
          id,
          kind: "sql-access",
          path: relativePath,
          sourceOwner,
          targetOwner,
          access,
          object,
          objectType
        });
      }
    }
  }

  const migrationResolution = await resolveMigrationScopes(root, config.scan);
  structuralErrors.push(...migrationResolution.errors);

  for (const migrationScope of migrationResolution.errors.length === 0 ? migrationResolution.scopes : []) {
    const activeForeignKeys = new Map();
    const activeRoutines = new Map();
    const activeTriggers = new Map();
    const migrationFiles = [];
    for (const migrationRoot of migrationScope.roots) {
      migrationFiles.push(...(await walk(path.join(root, migrationRoot), new Set([".sql"]))));
    }

    for (const file of migrationFiles) {
      const relativePath = toPosix(path.relative(root, file));
      const structure = extractMigrationStructure(await readFile(file, "utf8"));
      for (const table of structure.declarations) {
        if (managedObjectProblem(config, table, "table")) {
          structuralErrors.push(`Tabla declarada sin propietario: ${relativePath} -> ${table}`);
        }
      }
      for (const routine of structure.routines) {
        if (managedObjectProblem(config, routine, "routine")) {
          structuralErrors.push(`Rutina declarada sin propietario: ${relativePath} -> ${routine}`);
        }
      }

      const inspectRoutineAccess = (access, accessPath) => {
        if (managedObjectProblem(config, access.object, access.objectType)) {
          structuralErrors.push(
            `Referencia PL/pgSQL a ${access.objectType === "routine" ? "rutina" : "tabla"} sin propietario: ${accessPath} -> ${access.routine} -> ${access.object}`
          );
          return;
        }
        const sourceOwner = databaseObjectOwner(config, access.routine, "routine");
        const targetOwner = databaseObjectOwner(config, access.object, access.objectType);
        if (!sourceOwner) {
          structuralErrors.push(`Rutina PL/pgSQL sin propietario: ${accessPath} -> ${access.routine}`);
          return;
        }
        if (!targetOwner || sourceOwner === targetOwner) return;
        const id = `plpgsql-sql-access|${accessPath}|${access.routine}|${sourceOwner}->${targetOwner}|${access.access}|${access.objectType}|${access.object}`;
        if (isTemporaryException(id)) return;
        addCount(violations, {
          id,
          kind: "plpgsql-sql-access",
          path: accessPath,
          routine: access.routine,
          sourceOwner,
          targetOwner,
          access: access.access,
          object: access.object,
          objectType: access.objectType,
          securityDefiner: access.securityDefiner
        });
      };

      const inspectSecurityDefiner = (routine, accesses, accessPath) => {
        const hasCrossOwner = accesses.some(
          (access) =>
            access.routine === routine &&
            access.securityDefiner &&
            databaseObjectOwner(config, access.routine, "routine") &&
            databaseObjectOwner(config, access.object, access.objectType) &&
            databaseObjectOwner(config, access.routine, "routine") !==
              databaseObjectOwner(config, access.object, access.objectType)
        );
        if (!hasCrossOwner) return;
        const crossId = `security-definer-cross-owner|${accessPath}|${routine}`;
        if (isTemporaryException(crossId)) return;
        addCount(violations, {
          id: crossId,
          kind: "security-definer-cross-owner",
          path: accessPath,
          routine
        });
      };

      if (effectiveMigrationState) {
        for (const event of structure.routineEvents) {
          if (event.type === "drop") activeRoutines.delete(event.routine);
          else activeRoutines.set(event.routine, { ...event, path: relativePath });
        }
      } else {
        for (const access of structure.plpgsqlAccesses) inspectRoutineAccess(access, relativePath);
        for (const routine of structure.securityDefiners) {
          inspectSecurityDefiner(routine, structure.plpgsqlAccesses, relativePath);
        }
      }

      for (const event of structure.triggerEvents) {
        const key = `${event.table}|${event.name}`;
        if (event.type === "drop") activeTriggers.delete(key);
        else activeTriggers.set(key, { ...event, path: relativePath });
      }

      for (const event of structure.foreignKeyEvents) {
        if (event.type === "drop") {
          activeForeignKeys.delete(`${event.source}|${event.constraintName}`);
          continue;
        }

        const key = event.constraintName
          ? `${event.source}|${event.constraintName}`
          : `${relativePath}|${event.position}|${event.source}`;
        activeForeignKeys.set(key, { ...event, path: relativePath });
      }
    }

    for (const { path: declarationPath, source, target } of activeForeignKeys.values()) {
      if (managedObjectProblem(config, source, "table") || managedObjectProblem(config, target, "table")) {
        structuralErrors.push(`FK con tabla sin propietario: ${declarationPath} -> ${source} -> ${target}`);
        continue;
      }
      const sourceOwner = tableOwner(config, source);
      const targetOwner = tableOwner(config, target);
      if (!sourceOwner || !targetOwner || sourceOwner === targetOwner) continue;
      const id = `cross-owner-fk|${declarationPath}|${source}|${sourceOwner}->${targetOwner}|${target}`;
      if (isTemporaryException(id)) continue;
      addCount(violations, {
        id,
        kind: "cross-owner-fk",
        path: declarationPath,
        sourceOwner,
        targetOwner,
        sourceTable: source,
        targetTable: target
      });
    }

    for (const trigger of activeTriggers.values()) {
      const tableProblem = managedObjectProblem(config, trigger.table, "table");
      const routineProblem = managedObjectProblem(config, trigger.routine, "routine");
      if (tableProblem) {
        structuralErrors.push(
          `Trigger sobre tabla sin propietario: ${trigger.path} -> ${trigger.name} -> ${trigger.table}`
        );
      }
      if (routineProblem) {
        structuralErrors.push(
          `Trigger hacia rutina sin propietario: ${trigger.path} -> ${trigger.name} -> ${trigger.routine}`
        );
      }
      if (tableProblem || routineProblem) continue;

      const sourceOwner = tableOwner(config, trigger.table);
      const targetOwner = databaseObjectOwner(config, trigger.routine, "routine");
      if (!sourceOwner || !targetOwner || sourceOwner === targetOwner) continue;
      const id = `cross-owner-trigger|${trigger.path}|${trigger.name}|${trigger.table}|${sourceOwner}->${targetOwner}|${trigger.routine}`;
      if (isTemporaryException(id)) continue;
      addCount(violations, {
        id,
        kind: "cross-owner-trigger",
        path: trigger.path,
        trigger: trigger.name,
        sourceOwner,
        targetOwner,
        sourceTable: trigger.table,
        targetRoutine: trigger.routine
      });
    }

    if (effectiveMigrationState) {
      for (const definition of activeRoutines.values()) {
        for (const access of definition.accesses) {
          if (managedObjectProblem(config, access.object, access.objectType)) {
            structuralErrors.push(
              `Referencia PL/pgSQL a ${access.objectType === "routine" ? "rutina" : "tabla"} sin propietario: ${definition.path} -> ${access.routine} -> ${access.object}`
            );
            continue;
          }
          const sourceOwner = databaseObjectOwner(config, access.routine, "routine");
          const targetOwner = databaseObjectOwner(config, access.object, access.objectType);
          if (!sourceOwner) {
            structuralErrors.push(`Rutina PL/pgSQL sin propietario: ${definition.path} -> ${access.routine}`);
            continue;
          }
          if (!targetOwner || sourceOwner === targetOwner) continue;
          const id = `plpgsql-sql-access|${definition.path}|${access.routine}|${sourceOwner}->${targetOwner}|${access.access}|${access.objectType}|${access.object}`;
          if (!isTemporaryException(id)) {
            addCount(violations, {
              id,
              kind: "plpgsql-sql-access",
              path: definition.path,
              routine: access.routine,
              sourceOwner,
              targetOwner,
              access: access.access,
              object: access.object,
              objectType: access.objectType,
              securityDefiner: access.securityDefiner
            });
          }
        }

        if (definition.securityDefiner) {
          const hasCrossOwner = definition.accesses.some((access) => {
            const sourceOwner = databaseObjectOwner(config, access.routine, "routine");
            const targetOwner = databaseObjectOwner(config, access.object, access.objectType);
            return sourceOwner && targetOwner && sourceOwner !== targetOwner;
          });
          const id = `security-definer-cross-owner|${definition.path}|${definition.routine}`;
          if (hasCrossOwner && !isTemporaryException(id)) {
            addCount(violations, {
              id,
              kind: "security-definer-cross-owner",
              path: definition.path,
              routine: definition.routine
            });
          }
        }
      }
    }
  }

  return {
    structuralErrors: [...new Set(structuralErrors)].sort(),
    violations: [...violations.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
}

export function compareWithBaseline(detected, baseline) {
  const actual = new Map(detected.map((entry) => [entry.id, entry]));
  const expected = new Map(baseline.violations.map((entry) => [entry.id, entry]));
  const unexpected = [];
  const increased = [];
  const stale = [];

  for (const [id, entry] of actual) {
    const allowed = expected.get(id);
    if (!allowed) unexpected.push(entry);
    else if (entry.count > allowed.count) increased.push({ actual: entry, baselineCount: allowed.count });
    else if (entry.count < allowed.count) stale.push({ actualCount: entry.count, baseline: allowed });
  }
  for (const [id, entry] of expected) {
    if (!actual.has(id)) stale.push({ actualCount: 0, baseline: entry });
  }

  return { increased, stale, unexpected };
}

export function makeBaseline(violations, commit = "replace-with-reviewed-commit") {
  return {
    version: 1,
    capturedAtCommit: commit,
    policy:
      "Deuda preexistente solamente. No aumentar conteos; eliminar la entrada en el mismo cambio que elimina la violacion.",
    violations: violations.map(({ id, count }) => ({ id, count }))
  };
}

export function makeBaselineFromDetection(detected, commit = "replace-with-reviewed-commit") {
  if ((detected?.structuralErrors ?? []).length > 0) {
    throw new Error(`No se puede generar baseline con errores estructurales:\n${detected.structuralErrors.join("\n")}`);
  }
  return makeBaseline(detected?.violations ?? [], commit);
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function formatViolation(entry) {
  return `- ${entry.id} (conteo: ${entry.count})`;
}

function writeOut(message = "") {
  process.stdout.write(`${message}\n`);
}

function writeError(message = "") {
  process.stderr.write(`${message}\n`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const root = process.cwd();
  const config = await readJson(root, DEFAULT_CONFIG);
  const detected = await detectBoundaryViolations(root, config);

  if (args.has("--print-baseline")) {
    process.stdout.write(`${JSON.stringify(makeBaselineFromDetection(detected), null, 2)}\n`);
    return;
  }

  const baseline = await readJson(root, DEFAULT_BASELINE);
  const comparison = compareWithBaseline(detected.violations, baseline);
  const failed =
    detected.structuralErrors.length > 0 ||
    comparison.unexpected.length > 0 ||
    comparison.increased.length > 0 ||
    comparison.stale.length > 0;

  if (!failed) {
    writeOut(
      `Architecture boundaries OK: ${detected.violations.length} grupos de deuda preexistente, sin violaciones nuevas.`
    );
    return;
  }

  writeError("Architecture boundary check failed.");
  if (detected.structuralErrors.length) {
    writeError("\nErrores de propiedad:");
    for (const error of detected.structuralErrors) writeError(`- ${error}`);
  }
  if (comparison.unexpected.length) {
    writeError("\nViolaciones nuevas:");
    for (const entry of comparison.unexpected) writeError(formatViolation(entry));
  }
  if (comparison.increased.length) {
    writeError("\nViolaciones preexistentes cuyo conteo aumento:");
    for (const { actual, baselineCount } of comparison.increased) {
      writeError(`${formatViolation(actual)}; baseline: ${baselineCount}`);
    }
  }
  if (comparison.stale.length) {
    writeError("\nBaseline obsoleto (retire estas entradas junto con la deuda corregida):");
    for (const { actualCount, baseline: entry } of comparison.stale) {
      writeError(`- ${entry.id} (baseline: ${entry.count}; actual: ${actualCount})`);
    }
  }
  writeError(
    "\nNo amplie el baseline para aprobar una dependencia nueva. Corrija la frontera o documente una decision arquitectonica explicita."
  );
  process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) await main();
