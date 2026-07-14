import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const DEFAULT_CONFIG = "docs/architecture/data-ownership.json";
const DEFAULT_BASELINE = "docs/architecture/boundary-baseline.json";
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
  const plpgsqlAccesses = [];
  const securityDefiners = [];
  const triggers = [];
  const createPattern =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\)\s*;/gi;
  const alterPattern =
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?([\s\S]*?);/gi;
  const routinePattern =
    /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?/gi;
  const routineBodyPattern =
    /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?([\s\S]*?)\$([A-Za-z_]*)\$([\s\S]*?)\$\4\$/gi;
  const triggerPattern =
    /create\s+(?:or\s+replace\s+)?trigger\s+"?([a-z_][a-z0-9_]*)"?\s+[\s\S]*?\bon\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?[\s\S]*?\bexecute\s+(?:function|procedure)\s+"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?/gi;

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
    for (const access of extractSqlAccessesFromSql(body)) {
      plpgsqlAccesses.push({ routine, securityDefiner, ...access });
    }
  }

  for (const match of sql.matchAll(triggerPattern)) {
    triggers.push({
      name: match[1].toLowerCase(),
      table: normalizeTable(match[2], match[3]),
      routine: normalizeTable(match[4], match[5])
    });
  }

  foreignKeyEvents.sort((left, right) => left.position - right.position);
  return {
    declarations,
    foreignKeys,
    foreignKeyEvents,
    routines,
    plpgsqlAccesses,
    securityDefiners,
    triggers
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

function isTemporaryException(config, id) {
  return (config.temporaryExceptions ?? []).some((entry) => entry.id === id);
}

export async function detectBoundaryViolations(root, config) {
  const violations = new Map();
  const structuralErrors = [];
  const activeForeignKeys = new Map();
  const sourceExtensions = new Set(config.scan.sourceExtensions ?? [...SOURCE_EXTENSIONS]);

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
        if (isTemporaryException(config, id)) continue;
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

  const migrationRoot = path.join(root, config.scan.migrationRoot);
  for (const file of await walk(migrationRoot, new Set([".sql"]))) {
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

    for (const access of structure.plpgsqlAccesses) {
      if (managedObjectProblem(config, access.object, access.objectType)) {
        structuralErrors.push(
          `Referencia PL/pgSQL a ${access.objectType === "routine" ? "rutina" : "tabla"} sin propietario: ${relativePath} -> ${access.routine} -> ${access.object}`
        );
        continue;
      }
      const sourceOwner = databaseObjectOwner(config, access.routine, "routine");
      const targetOwner = databaseObjectOwner(config, access.object, access.objectType);
      if (!sourceOwner) {
        structuralErrors.push(`Rutina PL/pgSQL sin propietario: ${relativePath} -> ${access.routine}`);
        continue;
      }
      if (!targetOwner || sourceOwner === targetOwner) continue;
      const id = `plpgsql-sql-access|${relativePath}|${access.routine}|${sourceOwner}->${targetOwner}|${access.access}|${access.objectType}|${access.object}`;
      if (isTemporaryException(config, id)) continue;
      addCount(violations, {
        id,
        kind: "plpgsql-sql-access",
        path: relativePath,
        routine: access.routine,
        sourceOwner,
        targetOwner,
        access: access.access,
        object: access.object,
        objectType: access.objectType,
        securityDefiner: access.securityDefiner
      });
    }

    for (const routine of structure.securityDefiners) {
      const id = `security-definer|${relativePath}|${routine}`;
      if (isTemporaryException(config, id)) continue;
      // SECURITY DEFINER is recorded only when paired with a cross-owner body access,
      // or when the routine itself is undeclared (already a structural error).
      const hasCrossOwner = structure.plpgsqlAccesses.some(
        (access) =>
          access.routine === routine &&
          access.securityDefiner &&
          databaseObjectOwner(config, access.routine, "routine") &&
          databaseObjectOwner(config, access.object, access.objectType) &&
          databaseObjectOwner(config, access.routine, "routine") !==
            databaseObjectOwner(config, access.object, access.objectType)
      );
      if (!hasCrossOwner) continue;
      const crossId = `security-definer-cross-owner|${relativePath}|${routine}`;
      if (isTemporaryException(config, crossId)) continue;
      addCount(violations, {
        id: crossId,
        kind: "security-definer-cross-owner",
        path: relativePath,
        routine
      });
    }

    for (const trigger of structure.triggers) {
      if (managedObjectProblem(config, trigger.table, "table")) {
        structuralErrors.push(
          `Trigger sobre tabla sin propietario: ${relativePath} -> ${trigger.name} -> ${trigger.table}`
        );
      }
      if (managedObjectProblem(config, trigger.routine, "routine")) {
        structuralErrors.push(
          `Trigger hacia rutina sin propietario: ${relativePath} -> ${trigger.name} -> ${trigger.routine}`
        );
      }
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
    if (isTemporaryException(config, id)) continue;
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
    process.stdout.write(`${JSON.stringify(makeBaseline(detected.violations), null, 2)}\n`);
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
