import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CATALOG_PATHS = {
  products: "docs/catalogs/products.v1.json",
  services: "docs/catalogs/services.v1.json",
  debt: "docs/catalogs/debt.v1.json"
};
const CONTROLLED_REQUIREMENT_STATES = new Set([
  "implementado",
  "parcial",
  "simulado",
  "demo sintética",
  "pendiente",
  "bloqueado por decisión"
]);
const CATALOG_STATES = new Set(["active", "transitioning", "retiring", "planned", "accepted"]);
const RUNBOOK_STATES = new Set(["active", "not-current", "draft", "interface-stub"]);
const REQUIRED_ITEM_FIELDS = ["id", "owner", "status", "issue", "dueDate"];
const REQUIRED_RUNBOOK_FIELDS = ["documentType", "status", "owner", "issue", "reviewDue"];
const EXCLUDED_DIRECTORIES = new Set([
  ".docker-contexts",
  ".git",
  "node_modules",
  "graphify-out",
  "tmp",
  "dist",
  "coverage"
]);
const ENVIRONMENT_SCAN_ROOTS = ["apps", "services", "packages", "scripts", ".github", "infra"];
const ENVIRONMENT_SOURCE_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".conf",
  ".dockerfile",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".nginx",
  ".ps1",
  ".sh",
  ".template",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);
const ENVIRONMENT_GENERATED_DIRECTORIES = new Set([".next", ...EXCLUDED_DIRECTORIES]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISSUE_ID = /^HYP-[A-Z]+-\d{3}$/;

export async function runDocsChecks(root, options = {}) {
  const now = dateOnly(options.now ?? new Date());
  const problems = [];
  const markdownFiles = await collectMarkdownFiles(root);

  for (const relativePath of markdownFiles) {
    const content = await readFile(path.join(root, relativePath), "utf8");
    problems.push(...(await linkProblems(root, relativePath, content)));
    problems.push(...unsafeDocumentationProblems(relativePath, content));
    if (isRunbookPath(relativePath)) {
      problems.push(...runbookMetadataProblems(relativePath, content, now));
      problems.push(...(await activeRunbookReleaseProblems(root, relativePath, content, now)));
    }
  }
  problems.push(...(await environmentExampleProblems(root)));
  problems.push(...(await environmentUsageProblems(root)));

  const catalogs = {};
  for (const [name, relativePath] of Object.entries(CATALOG_PATHS)) {
    try {
      catalogs[name] = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
      problems.push(...catalogMetadataProblems(relativePath, catalogs[name], now));
    } catch (error) {
      problems.push(`${relativePath}: catálogo ausente o JSON inválido (${error.message})`);
    }
  }

  if (catalogs.products) problems.push(...(await productCatalogProblems(root, catalogs.products)));
  if (catalogs.services) problems.push(...(await serviceInventoryProblems(root, catalogs.services)));
  if (catalogs.debt) {
    try {
      const baseline = JSON.parse(
        await readFile(path.join(root, catalogs.debt.baseline ?? "docs/architecture/boundary-baseline.json"), "utf8")
      );
      problems.push(...debtCoverageProblems(catalogs.debt, baseline));
    } catch (error) {
      problems.push(`${CATALOG_PATHS.debt}: baseline ausente o inválido (${error.message})`);
    }
  }
  if (catalogs.products && catalogs.services && catalogs.debt) {
    try {
      const catalogReadme = await readFile(path.join(root, "docs/catalogs/README.md"), "utf8");
      problems.push(...catalogReadmeProblems(catalogReadme, catalogs));
    } catch (error) {
      problems.push(`docs/catalogs/README.md: no se pudieron validar estadísticas (${error.message})`);
    }
  }

  try {
    const ownership = JSON.parse(await readFile(path.join(root, "docs/architecture/data-ownership.json"), "utf8"));
    problems.push(...temporaryExceptionProblems(ownership.temporaryExceptions, now, catalogs.debt));
  } catch (error) {
    problems.push(`docs/architecture/data-ownership.json: inventario ausente o inválido (${error.message})`);
  }

  try {
    const novaSpec = await readFile(path.join(root, "docs/products/NOVA.md"), "utf8");
    const traceability = await readFile(path.join(root, "docs/products/REQUIREMENTS-TRACEABILITY.md"), "utf8");
    problems.push(...(await novaTraceabilityProblems(root, novaSpec, traceability)));
    problems.push(...(await productTraceabilityEvidenceProblems(root, traceability, ["PUL", "LUM"])));
  } catch (error) {
    problems.push(`trazabilidad NOVA: no se pudo leer la especificación o la matriz (${error.message})`);
  }

  try {
    const environmentExample = await readFile(path.join(root, ".env.example"), "utf8");
    for (const relativePath of markdownFiles) {
      const content = await readFile(path.join(root, relativePath), "utf8");
      problems.push(...environmentReferenceProblems(relativePath, content, environmentExample));
    }
  } catch (error) {
    problems.push(`.env.example: no se pudo validar el inventario de variables (${error.message})`);
  }

  try {
    const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const fullStackWorkflow = await readFile(path.join(root, ".github/workflows/check.yml"), "utf8");
    const cellWorkflow = await readFile(path.join(root, ".github/workflows/_cell-ci.yml"), "utf8");
    problems.push(...documentationCiProblems(packageManifest, fullStackWorkflow, cellWorkflow));
  } catch (error) {
    problems.push(`docs:check CI: no se pudo validar la integración (${error.message})`);
  }

  return [...new Set(problems)].sort();
}

export async function collectMarkdownFiles(root) {
  const files = [];
  await walkMarkdown(root, root, files);
  return files.sort();
}

async function walkMarkdown(root, directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkMarkdown(root, absolute, files);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(normalizePath(path.relative(root, absolute)));
    }
  }
}

export async function linkProblems(root, relativePath, content) {
  const problems = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<")) target = target.slice(1, target.indexOf(">"));
    else target = target.replace(/\s+["'][^"']*["']\s*$/, "");
    if (!target) continue;
    if (/^https?:/i.test(target)) {
      try {
        new URL(target);
      } catch {
        problems.push(`${relativePath}: enlace HTTP(S) inválido: ${match[1]}`);
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const hashIndex = target.indexOf("#");
    let fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
    target = (hashIndex >= 0 ? target.slice(0, hashIndex) : target).split("?", 1)[0];
    try {
      target = decodeURIComponent(target);
      fragment = decodeURIComponent(fragment);
    } catch {
      problems.push(`${relativePath}: enlace local con escape inválido: ${match[1]}`);
      continue;
    }
    const absolute = target ? path.resolve(root, path.dirname(relativePath), target) : path.resolve(root, relativePath);
    const relativeTarget = path.relative(root, absolute);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      problems.push(`${relativePath}: enlace local sale del repositorio: ${match[1]}`);
    } else if (!(await exists(absolute))) {
      problems.push(`${relativePath}: enlace local inexistente: ${match[1]}`);
    } else if (fragment && absolute.toLowerCase().endsWith(".md")) {
      const targetContent = await readFile(absolute, "utf8");
      if (!markdownAnchors(targetContent).has(fragment.toLowerCase())) {
        problems.push(`${relativePath}: anchor local inexistente: ${match[1]}`);
      }
    }
  }
  return problems;
}

export function markdownAnchors(content) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const match of content.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]
      .replace(/<[^>]*>/g, "")
      .replace(/[`*_~]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-");
    if (!base) continue;
    const seen = occurrences.get(base) ?? 0;
    occurrences.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

export function parseFrontMatter(content) {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return null;
  const lines = normalized.split(/\r?\n/);
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) return null;
  const result = {};
  for (const line of lines.slice(1, closingIndex)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    result[key] = value;
  }
  return result;
}

export function runbookMetadataProblems(relativePath, content, now = dateOnly(new Date())) {
  const metadata = parseFrontMatter(content);
  if (!metadata) return [`${relativePath}: runbook sin front matter obligatorio`];
  const problems = [];
  for (const field of REQUIRED_RUNBOOK_FIELDS) {
    if (!metadata[field]) problems.push(`${relativePath}: falta metadata ${field}`);
  }
  if (metadata.documentType && metadata.documentType !== "runbook") {
    problems.push(`${relativePath}: documentType debe ser runbook`);
  }
  if (metadata.status && !RUNBOOK_STATES.has(metadata.status)) {
    problems.push(`${relativePath}: status de runbook no permitido: ${metadata.status}`);
  }
  if (metadata.issue && !ISSUE_ID.test(metadata.issue)) problems.push(`${relativePath}: issue inválido`);
  problems.push(...dateProblems(relativePath, "reviewDue", metadata.reviewDue, now));
  if (metadata.status === "active" && (!metadata.validatedAt || !metadata.releaseManifest)) {
    problems.push(`${relativePath}: un runbook active requiere validatedAt y releaseManifest`);
  }
  if (metadata.status === "active" && metadata.validatedAt) {
    problems.push(...validationDateProblems(relativePath, metadata.validatedAt, now));
  }
  return problems;
}

function inferredRunbookCell(relativePath) {
  const normalized = normalizePath(relativePath).toLowerCase();
  if (normalized === "docs/production.md" || normalized.startsWith("docs/ops/")) return "platform";
  if (normalized.endsWith("/hostname-edge.md")) return "platform";
  if (normalized.startsWith("docs/products/nova/") || /\/nova[-_]/.test(normalized)) return "nova";
  if (/\/lumen[-_]/.test(normalized)) return "lumen";
  if (/\/pulso[-_]/.test(normalized)) return "pulso";
  return null;
}

export async function activeRunbookReleaseProblems(root, relativePath, content, _now = dateOnly(new Date())) {
  const metadata = parseFrontMatter(content);
  if (metadata?.status !== "active" || !metadata.releaseManifest) return [];
  const problems = [];
  const reference = normalizePath(metadata.releaseManifest);
  const match = reference.match(
    /^releases\/manifests\/(platform|nova|lumen|pulso)\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\.json$/
  );
  if (!match) {
    return [`${relativePath}: releaseManifest debe apuntar a releases/manifests/<cell>/<semver>.json`];
  }
  const [, pathCell, pathVersion] = match;
  const expectedCell = inferredRunbookCell(relativePath);
  if (!expectedCell) problems.push(`${relativePath}: no se puede inferir la cell del runbook active`);
  else if (pathCell !== expectedCell) {
    problems.push(`${relativePath}: releaseManifest pertenece a ${pathCell}; esperado ${expectedCell}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, reference), "utf8"));
  } catch (error) {
    problems.push(`${relativePath}: releaseManifest ausente o JSON inválido (${error.message})`);
    return problems;
  }
  if (manifest.schemaVersion !== 1) problems.push(`${relativePath}: releaseManifest schemaVersion debe ser 1`);
  if (manifest.cell !== pathCell) {
    problems.push(`${relativePath}: releaseManifest declara cell ${manifest.cell ?? "ausente"}; esperado ${pathCell}`);
  }
  if (manifest.releaseVersion !== pathVersion) {
    problems.push(
      `${relativePath}: releaseManifest declara releaseVersion ${manifest.releaseVersion ?? "ausente"}; esperado ${pathVersion}`
    );
  }
  if (manifest.status !== "published" || manifest.imagesVerified !== true) {
    problems.push(`${relativePath}: un runbook active requiere un releaseManifest published con imágenes verificadas`);
  }

  const catalogReference = `releases/catalogs/${pathCell}/${manifest.catalogVersion}.json`;
  try {
    const catalog = JSON.parse(await readFile(path.join(root, catalogReference), "utf8"));
    if (catalog.cell !== pathCell || catalog.catalogVersion !== manifest.catalogVersion) {
      problems.push(`${relativePath}: el catálogo ${catalogReference} no es coherente con releaseManifest`);
    }
  } catch (error) {
    problems.push(
      `${relativePath}: catálogo de release ausente o JSON inválido ${catalogReference} (${error.message})`
    );
  }

  if (metadata.validatedAt && manifest.releasedAt) {
    const releasedDate = String(manifest.releasedAt).slice(0, 10);
    if (ISO_DATE.test(releasedDate) && metadata.validatedAt < releasedDate) {
      problems.push(`${relativePath}: validatedAt precede al release referenciado (${releasedDate})`);
    }
  }
  return problems;
}

export function catalogMetadataProblems(relativePath, catalog, now = dateOnly(new Date())) {
  const problems = [];
  if (catalog?.schemaVersion !== 1) problems.push(`${relativePath}: schemaVersion debe ser 1`);
  if (!/^\d+\.\d+\.\d+$/.test(catalog?.catalogVersion ?? "")) {
    problems.push(`${relativePath}: catalogVersion debe usar SemVer`);
  }
  if (!ISO_DATE.test(catalog?.updatedAt ?? "")) problems.push(`${relativePath}: updatedAt debe ser YYYY-MM-DD`);
  if (!Array.isArray(catalog?.items) || catalog.items.length === 0) {
    problems.push(`${relativePath}: items debe ser un arreglo no vacío`);
    return problems;
  }
  const ids = new Set();
  for (const item of catalog.items) {
    for (const field of REQUIRED_ITEM_FIELDS) {
      if (!item?.[field]) problems.push(`${relativePath}: ${item?.id ?? "<sin-id>"} no declara ${field}`);
    }
    if (ids.has(item.id)) problems.push(`${relativePath}: id duplicado ${item.id}`);
    ids.add(item.id);
    if (item.status && !CATALOG_STATES.has(item.status)) {
      problems.push(`${relativePath}: ${item.id} usa status no permitido ${item.status}`);
    }
    if (item.issue && !ISSUE_ID.test(item.issue)) problems.push(`${relativePath}: ${item.id} usa issue inválido`);
    problems.push(...dateProblems(`${relativePath}: ${item.id}`, "dueDate", item.dueDate, now));
  }
  return problems;
}

export async function productCatalogProblems(root, catalog) {
  const problems = [];
  const cells = new Set();
  for (const item of catalog.items ?? []) {
    if (!item.cell) problems.push(`${CATALOG_PATHS.products}: ${item.id} no declara cell`);
    if (cells.has(item.cell)) problems.push(`${CATALOG_PATHS.products}: cell duplicada ${item.cell}`);
    cells.add(item.cell);
    if (!item.spec || !(await exists(path.join(root, item.spec)))) {
      problems.push(`${CATALOG_PATHS.products}: ${item.id} apunta a spec inexistente`);
    }
    if (item.kind === "product" && !/^[A-Z]{3}$/.test(item.requirementPrefix ?? "")) {
      problems.push(`${CATALOG_PATHS.products}: ${item.id} no declara requirementPrefix válido`);
    }
  }
  return problems;
}

export async function serviceInventoryProblems(root, catalog) {
  const problems = [];
  const entriesByPath = new Map();
  for (const item of catalog.items ?? []) {
    const normalized = normalizePath(item.path ?? "");
    if (!normalized) {
      problems.push(`${CATALOG_PATHS.services}: ${item.id} no declara path`);
      continue;
    }
    if (entriesByPath.has(normalized)) problems.push(`${CATALOG_PATHS.services}: path duplicado ${normalized}`);
    entriesByPath.set(normalized, item);
    const packagePath = path.join(root, normalized, "package.json");
    const packageExists = await exists(packagePath);
    if (item.status === "planned") {
      if (packageExists) problems.push(`${CATALOG_PATHS.services}: ${item.id} ya existe y no puede seguir planned`);
      continue;
    }
    if (!packageExists) {
      problems.push(`${CATALOG_PATHS.services}: ${item.id} apunta a package inexistente`);
      continue;
    }
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    if (manifest.name !== item.packageName) {
      problems.push(`${CATALOG_PATHS.services}: ${item.id} packageName no coincide con ${manifest.name}`);
    }
    if (item.kind === "provider-migrations") {
      if (typeof manifest.scripts?.migrate !== "string" || !manifest.scripts.migrate.trim()) {
        problems.push(`${CATALOG_PATHS.services}: ${item.id} provider-migrations no declara scripts.migrate`);
      }
      const sqlRoot = path.join(root, normalized, "sql");
      if (!(await exists(sqlRoot))) {
        problems.push(`${CATALOG_PATHS.services}: ${item.id} provider-migrations no contiene directorio sql`);
      } else if (
        !(await readdir(sqlRoot, { withFileTypes: true })).some(
          (entry) => entry.isFile() && entry.name.endsWith(".sql")
        )
      ) {
        problems.push(`${CATALOG_PATHS.services}: ${item.id} provider-migrations no contiene migraciones SQL`);
      }
    }
  }

  for (const parent of ["apps", "services"]) {
    const parentPath = path.join(root, parent);
    if (!(await exists(parentPath))) continue;
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativePackage = normalizePath(path.join(parent, entry.name));
      if ((await exists(path.join(root, relativePackage, "package.json"))) && !entriesByPath.has(relativePackage)) {
        problems.push(`${CATALOG_PATHS.services}: package desplegable sin inventariar ${relativePackage}`);
      }
    }
  }

  const packagesPath = path.join(root, "packages");
  if (await exists(packagesPath)) {
    for (const entry of await readdir(packagesPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativePackage = normalizePath(path.join("packages", entry.name));
      const manifestPath = path.join(root, relativePackage, "package.json");
      if (!(await exists(manifestPath))) continue;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const scripts = manifest.scripts ?? {};
      const isDeployableOneShot = ["migrate", "bootstrap:database", "bootstrap:roles"].some(
        (name) => typeof scripts[name] === "string" && scripts[name].trim()
      );
      if (isDeployableOneShot && !entriesByPath.has(relativePackage)) {
        problems.push(`${CATALOG_PATHS.services}: package desplegable sin inventariar ${relativePackage}`);
      }
    }
  }

  const runtimeMapPath = path.join(root, "packages/service-runtime/src/index.ts");
  if (await exists(runtimeMapPath)) {
    const runtimeSource = await readFile(runtimeMapPath, "utf8");
    const normativeRoles = new Map(
      [...runtimeSource.matchAll(/^\s*"([a-z0-9-]+-service)":\s*"(hyperion_[a-z0-9_]+)",?$/gm)].map((match) => [
        match[1],
        match[2]
      ])
    );
    for (const [serviceName, expectedRole] of normativeRoles) {
      const item = entriesByPath.get(`services/${serviceName}`);
      if (!item) continue;
      if (item.databaseRole !== expectedRole) {
        problems.push(
          `${CATALOG_PATHS.services}: ${item.id} databaseRole ${item.databaseRole ?? "null"} no coincide con ${expectedRole}`
        );
      }
    }
  }
  return problems;
}

export function debtCoverageProblems(catalog, baseline) {
  const problems = [];
  const baselineFindings = baseline?.violations ?? [];
  const nonBaselineSources = new Set(["temporary-exception", "transition-inventory"]);
  for (const item of catalog.items ?? []) {
    if (item.source !== undefined && !nonBaselineSources.has(item.source)) {
      problems.push(`${CATALOG_PATHS.debt}: ${item.id} usa source no permitido ${item.source}`);
    }
    if (
      item.pathPrefixes !== undefined &&
      (!Array.isArray(item.pathPrefixes) ||
        item.pathPrefixes.length === 0 ||
        item.pathPrefixes.some(
          (prefix) => typeof prefix !== "string" || !prefix || prefix.startsWith("/") || prefix.includes("..")
        ))
    ) {
      problems.push(`${CATALOG_PATHS.debt}: ${item.id} usa pathPrefixes inválido`);
    }
  }
  const baselineItems = (catalog.items ?? []).filter((item) => item.source === undefined);
  for (const item of baselineItems) {
    if (item.edge === undefined && (!Array.isArray(item.pathPrefixes) || item.pathPrefixes.length === 0)) {
      problems.push(`${CATALOG_PATHS.debt}: ${item.id} sin edge debe declarar pathPrefixes`);
    }
  }
  const expectedStats = {
    findingGroups: baselineFindings.length,
    instances: baselineFindings.reduce((total, finding) => total + Number(finding.count ?? 0), 0),
    workstreams: baselineItems.length
  };
  for (const [field, expected] of Object.entries(expectedStats)) {
    if (catalog.baselineStats?.[field] !== expected) {
      problems.push(
        `${CATALOG_PATHS.debt}: baselineStats.${field}=${catalog.baselineStats?.[field] ?? "ausente"}; esperado ${expected}`
      );
    }
  }
  const matchedItems = new Map(baselineItems.map((item) => [item.id, 0]));
  for (const finding of baselineFindings) {
    const parts = String(finding.id).split("|");
    const findingType = parts[0];
    const findingPath = parts[1] ?? "";
    const edge = parts.find((part) => part.includes("->"));
    const matches = baselineItems.filter(
      (item) =>
        item.findingType === findingType &&
        item.edge === edge &&
        (item.pathPrefixes === undefined || item.pathPrefixes.some((prefix) => findingPath.startsWith(prefix)))
    );
    if (matches.length !== 1) {
      problems.push(
        `${CATALOG_PATHS.debt}: finding ${finding.id} debe mapear exactamente una entrada (mapea ${matches.length})`
      );
    } else {
      matchedItems.set(matches[0].id, (matchedItems.get(matches[0].id) ?? 0) + 1);
    }
  }
  for (const [id, count] of matchedItems) {
    if (count === 0) problems.push(`${CATALOG_PATHS.debt}: ${id} no cubre ningún finding del baseline`);
  }
  return problems;
}

export function temporaryExceptionProblems(exceptions, now = dateOnly(new Date()), debtCatalog) {
  if (!Array.isArray(exceptions)) return ["data-ownership: temporaryExceptions debe ser un arreglo"];
  const problems = [];
  for (const exception of exceptions) {
    const label = `data-ownership: ${exception?.id ?? "<sin-id>"}`;
    for (const field of ["id", "justification", "owner", "issue", "expiresAt"]) {
      if (!exception?.[field]) problems.push(`${label} no declara ${field}`);
    }
    if (exception?.issue && !ISSUE_ID.test(exception.issue)) problems.push(`${label} usa issue inválido`);
    if (
      exception?.issue &&
      debtCatalog &&
      !(debtCatalog.items ?? []).some(
        (item) =>
          item.source === "temporary-exception" && item.issue === exception.issue && item.owner === exception.owner
      )
    ) {
      problems.push(`${label} no está representada en debt.v1.json con el mismo issue y owner`);
    }
    problems.push(...dateProblems(label, "expiresAt", exception?.expiresAt, now));
  }
  return problems;
}

export async function novaTraceabilityProblems(root, novaSpec, traceability) {
  const problems = [];
  const specRows = requirementRows(section(novaSpec, "Contexto"), "NOV");
  const traceRows = requirementRows(section(traceability, "NOVA"), "NOV");
  const specById = expandRows(specRows, problems, "docs/products/NOVA.md");
  const traceById = expandRows(traceRows, problems, "docs/products/REQUIREMENTS-TRACEABILITY.md");

  for (const [id, specRow] of specById) {
    const traceRow = traceById.get(id);
    if (!traceRow) {
      problems.push(`trazabilidad NOVA: ${id} falta en REQUIREMENTS-TRACEABILITY.md`);
      continue;
    }
    const specState = normalizeState(specRow.cells[2]);
    const traceState = normalizeState(traceRow.cells[2]);
    if (!CONTROLLED_REQUIREMENT_STATES.has(specState)) {
      problems.push(`docs/products/NOVA.md: ${id} usa estado no controlado ${specState || "<vacío>"}`);
    }
    if (!CONTROLLED_REQUIREMENT_STATES.has(traceState)) {
      problems.push(`trazabilidad NOVA: ${id} usa estado no controlado ${traceState || "<vacío>"}`);
    }
    if (specState !== traceState) {
      problems.push(`trazabilidad NOVA: ${id} difiere entre spec (${specState}) y matriz (${traceState})`);
    }

    const evidence = evidencePaths(traceRow.cells[3]);
    if (evidence.length === 0) problems.push(`trazabilidad NOVA: ${id} no declara evidencia versionada`);
    for (const evidencePath of evidence) {
      const absolute = path.join(root, evidencePath);
      if (!(await exists(absolute)) || !(await stat(absolute)).isFile()) {
        problems.push(`trazabilidad NOVA: ${id} referencia evidencia inexistente ${evidencePath}`);
      }
    }
  }
  for (const id of traceById.keys()) {
    if (!specById.has(id)) problems.push(`trazabilidad NOVA: ${id} no está declarado en NOVA.md`);
  }
  return problems;
}

export function requirementRows(content, prefix) {
  const rows = [];
  const expressionPattern = new RegExp(
    `^${prefix}-\\d{3}(?:\\s*[–—-]\\s*(?:${prefix}-)?\\d{3})?` +
      `(?:\\s*,\\s*${prefix}-\\d{3}(?:\\s*[–—-]\\s*(?:${prefix}-)?\\d{3})?)*$`
  );
  for (const line of content.split(/\r?\n/)) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const expression = cells[0]?.replaceAll("`", "") ?? "";
    if (expressionPattern.test(expression)) rows.push({ expression, cells });
  }
  return rows;
}

export async function productTraceabilityEvidenceProblems(root, traceability, prefixes) {
  const problems = [];
  for (const prefix of prefixes) {
    const rows = requirementRows(traceability, prefix);
    const seen = new Set();
    for (const row of rows) {
      const state = normalizeState(row.cells[2]);
      if (!CONTROLLED_REQUIREMENT_STATES.has(state)) {
        problems.push(`trazabilidad ${prefix}: ${row.expression} usa estado no controlado ${state || "<vacío>"}`);
      }
      for (const id of expandRequirementExpression(row.expression)) {
        if (seen.has(id)) problems.push(`trazabilidad ${prefix}: requisito duplicado ${id}`);
        seen.add(id);
      }
      const evidence = evidencePaths(row.cells[3]);
      if (evidence.length === 0) {
        problems.push(`trazabilidad ${prefix}: ${row.expression} no declara evidencia versionada`);
      }
      for (const evidencePath of evidence) {
        const absolute = path.join(root, evidencePath);
        if (!(await exists(absolute)) || !(await stat(absolute)).isFile()) {
          problems.push(`trazabilidad ${prefix}: ${row.expression} referencia evidencia inexistente ${evidencePath}`);
        }
      }
    }
  }
  return problems;
}

function expandRows(rows, problems, label) {
  const result = new Map();
  for (const row of rows) {
    for (const id of expandRequirementExpression(row.expression)) {
      if (result.has(id)) problems.push(`${label}: requisito duplicado ${id}`);
      result.set(id, row);
    }
  }
  return result;
}

export function expandRequirementExpression(expression) {
  const result = [];
  const pattern = /([A-Z]{3})-(\d{3})(?:\s*[–—-]\s*(?:[A-Z]{3}-)?(\d{3}))?/g;
  for (const match of expression.matchAll(pattern)) {
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : start;
    for (let value = start; value <= end; value += 1) {
      result.push(`${match[1]}-${String(value).padStart(3, "0")}`);
    }
  }
  return result;
}

function evidencePaths(cell = "") {
  const paths = [];
  for (const match of cell.matchAll(/`((?:apps|services|packages|infra|scripts|docs)\/[^`]+)`/g)) {
    const candidate = match[1].split(/\s+\(/, 1)[0].trim();
    if (!candidate.includes("…")) paths.push(normalizePath(candidate));
    else paths.push(candidate);
  }
  return paths;
}

function normalizeState(value = "") {
  return value.replaceAll("`", "").trim().toLowerCase();
}

export function environmentReferenceProblems(relativePath, content, environmentExample) {
  const declared = new Set();
  for (const line of environmentExample.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (match) declared.add(match[1]);
  }
  const referenced = new Set();
  for (const match of content.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?=[:}?])/g)) referenced.add(match[1]);
  for (const block of content.matchAll(/```(?:dotenv|env)\s*\r?\n([\s\S]*?)```/gi)) {
    for (const line of block[1].split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
      if (match) referenced.add(match[1]);
    }
  }
  return [...referenced]
    .filter((name) => !declared.has(name))
    .sort()
    .map((name) => `${relativePath}: variable documentada no inventariada en .env.example: ${name}`);
}

export async function collectEnvironmentExampleFiles(root) {
  const files = [];
  await walkEnvironmentExamples(root, root, files);
  return files.sort();
}

async function walkEnvironmentExamples(root, directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ENVIRONMENT_GENERATED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkEnvironmentExamples(root, absolute, files);
    else if (entry.isFile() && entry.name.endsWith(".env.example")) {
      files.push(normalizePath(path.relative(root, absolute)));
    }
  }
}

export async function environmentExampleProblems(root) {
  const problems = [];
  let files;
  try {
    files = await collectEnvironmentExampleFiles(root);
  } catch (error) {
    return [`**/*.env.example: no se pudo escanear (${error.message})`];
  }
  for (const relativePath of files) {
    const content = await readFile(path.join(root, relativePath), "utf8");
    problems.push(...unsafeDocumentationProblems(relativePath, content));
  }
  return problems;
}

// Kept as a compatibility export for callers that used the old, narrower name.
export async function infraEnvironmentExampleProblems(root) {
  return environmentExampleProblems(root);
}

export function environmentDeclarations(content) {
  const names = new Set();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (match) names.add(match[1]);
  }
  return names;
}

export async function environmentUsageProblems(root) {
  const examples = await collectEnvironmentExampleFiles(root);
  const declaredByFile = new Map();
  for (const relativePath of examples) {
    const names = environmentDeclarations(await readFile(path.join(root, relativePath), "utf8"));
    declaredByFile.set(relativePath, names);
  }

  const runtimeFiles = await collectEnvironmentRuntimeFiles(root);
  const runtimeContent = new Map();
  for (const relativePath of runtimeFiles) {
    runtimeContent.set(relativePath, await readFile(path.join(root, relativePath), "utf8"));
  }

  const problems = [];
  for (const [relativePath, names] of declaredByFile) {
    const consumed = new Set();
    for (const runtimePath of environmentRuntimeScope(relativePath, runtimeFiles)) {
      const content = runtimeContent.get(runtimePath);
      if (content === undefined) continue;
      for (const name of environmentConsumptionNames(runtimePath, content, names)) consumed.add(name);
    }
    for (const name of [...names].sort()) {
      if (!consumed.has(name)) {
        problems.push(`${relativePath}: variable declarada sin consumo estático en Compose/código: ${name}`);
      }
    }
  }
  return problems;
}

export function environmentRuntimeScope(examplePath, runtimeFiles) {
  const normalizedExample = normalizePath(examplePath);
  const normalizedRuntimeFiles = runtimeFiles.map(normalizePath);
  const parent = path.posix.dirname(normalizedExample);

  // The repository-root example is the explicit aggregate inventory for the
  // transitional full stack. Every other example is validated independently.
  if (parent === ".") return normalizedRuntimeFiles;

  // An example owned by an application/package/service can only be justified
  // by runtime files from that same owned subtree.
  if (parent !== "infra" && !parent.startsWith("infra/")) {
    const prefix = `${parent}/`;
    return normalizedRuntimeFiles.filter((relativePath) => relativePath.startsWith(prefix));
  }

  const stem = path.posix.basename(normalizedExample, ".env.example");
  if (parent === "infra") {
    const operationalKey = stem.replace(/-ops$/, "");
    return normalizedRuntimeFiles.filter((relativePath) => {
      if (isNamedComposeScope(relativePath, stem)) return true;
      if (!stem.endsWith("-ops") || !relativePath.startsWith("scripts/ops/")) return false;
      return pathTokenMatches(path.posix.basename(relativePath), operationalKey);
    });
  }

  // Nested infra examples belong to their own directory (templates,
  // Dockerfiles, etc.) and to a Compose descriptor named after either the
  // example or its immediate operational directory.
  const prefix = `${parent}/`;
  const parentKey = path.posix.basename(parent);
  return normalizedRuntimeFiles.filter(
    (relativePath) =>
      relativePath.startsWith(prefix) ||
      isNamedComposeScope(relativePath, stem) ||
      isNamedComposeScope(relativePath, parentKey)
  );
}

function isNamedComposeScope(relativePath, scope) {
  return new RegExp(`^infra/docker-compose\\.${escapeRegularExpression(scope)}\\.ya?ml$`, "i").test(relativePath);
}

function pathTokenMatches(fileName, token) {
  return new RegExp(`(?:^|[-_.])${escapeRegularExpression(token)}(?:[-_.]|$)`, "i").test(fileName);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectEnvironmentRuntimeFiles(root) {
  const files = [];
  for (const sourceRoot of ENVIRONMENT_SCAN_ROOTS) {
    const absolute = path.join(root, sourceRoot);
    if (!(await exists(absolute))) continue;
    await walkEnvironmentRuntimeFiles(root, absolute, files);
  }
  return files.sort();
}

async function walkEnvironmentRuntimeFiles(root, directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ENVIRONMENT_GENERATED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkEnvironmentRuntimeFiles(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = normalizePath(path.relative(root, absolute));
    if (isEnvironmentRuntimeFile(relativePath)) files.push(relativePath);
  }
}

function isEnvironmentRuntimeFile(relativePath) {
  const normalized = normalizePath(relativePath);
  const base = path.posix.basename(normalized);
  if (base.endsWith(".env.example") || /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(base)) return false;
  if (normalized.split("/").some((segment) => /^(?:__tests__|fixtures|tests)$/i.test(segment))) return false;
  if (/^(?:package-lock|pnpm-lock|yarn\.lock)/i.test(base) || base.endsWith(".map")) return false;
  if (/^(?:Dockerfile|Containerfile)(?:\..+)?$/i.test(base)) return true;
  return ENVIRONMENT_SOURCE_EXTENSIONS.has(path.posix.extname(base).toLowerCase());
}

export function environmentConsumptionNames(relativePath, content, declaredNames) {
  const names = new Set();
  const normalized = normalizePath(relativePath);
  const extension = path.posix.extname(normalized).toLowerCase();
  const shellLike = new Set([".bash", ".ps1", ".sh", ".yaml", ".yml"]);
  const source = shellLike.has(extension) ? stripCommentLines(content) : stripCodeComments(content);

  const addMatches = (pattern, group = 1) => {
    for (const match of source.matchAll(pattern)) {
      const name = match[group];
      if (declaredNames.has(name)) names.add(name);
    }
  };

  addMatches(/\$\{([A-Z][A-Z0-9_]*)(?=[:}?+\-/])/g);
  if (shellLike.has(extension) || /^(?:Dockerfile|Containerfile)/i.test(path.posix.basename(normalized))) {
    addMatches(/(?<!\$)\$([A-Z][A-Z0-9_]*)\b/g);
  }
  addMatches(
    /\b(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|[A-Za-z_$][\w$]*(?:Env|Environment)|env|environment)\s*(?:\?\.|\.)\s*([A-Z][A-Z0-9_]*)\b/g
  );
  addMatches(
    /\b(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|[A-Za-z_$][\w$]*(?:Env|Environment)|env|environment)\s*\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g
  );
  addMatches(
    /\b(?:process\s*\.\s*env|[A-Za-z_$][\w$]*(?:Env|Environment)|env|environment)\s*,\s*["']([A-Z][A-Z0-9_]*)["']/g
  );

  const hasDynamicEnvironmentLookup =
    /\b(?:process\s*\.\s*env|[A-Za-z_$][\w$]*(?:Env|Environment)|env|environment)\s*\[\s*[A-Za-z_$]/.test(source);
  if (hasDynamicEnvironmentLookup) addMatches(/["']([A-Z][A-Z0-9_]*)["']/g);

  if (extension === ".yaml" || extension === ".yml") {
    addMatches(/^\s*-\s*([A-Z][A-Z0-9_]*)\s*$/gm);
    addMatches(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(?:null|~)?\s*$/gm);
  }
  if (/^(?:Dockerfile|Containerfile)/i.test(path.posix.basename(normalized))) {
    addMatches(/^\s*ARG\s+([A-Z][A-Z0-9_]*)(?:\s*=|\s*$)/gim);
  }
  return names;
}

function stripCommentLines(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function stripCodeComments(content) {
  let result = "";
  let state = "code";
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];
    if (state === "line-comment") {
      if (current === "\n") {
        state = "code";
        result += current;
      }
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        state = "code";
        index += 1;
      } else if (current === "\n") result += current;
      continue;
    }
    if (state === "code") {
      if (current === "/" && next === "/") {
        state = "line-comment";
        index += 1;
        continue;
      }
      if (current === "/" && next === "*") {
        state = "block-comment";
        index += 1;
        continue;
      }
      if (current === "'" || current === '"' || current === "`") state = current;
      result += current;
      continue;
    }
    result += current;
    if (escaped) escaped = false;
    else if (current === "\\") escaped = true;
    else if (current === state) state = "code";
  }
  return result;
}

export function unsafeDocumentationProblems(relativePath, content) {
  const problems = [];
  if (
    /(?:https?:\/\/[^\s)`"']*|(?:\.{0,2}\/)[^\s)`"']*|[^\s)`"']*)[?&](?:access[_-]?token|auth(?:orization)?|code|credential|jwt|key|api[_-]?key|password|pass|pwd|secret|session|signature|sig|token)=[^\s)`"']*/i.test(
      content
    )
  ) {
    problems.push(`${relativePath}: secreto o token en query string`);
  }
  if (/http:\/\/[^\s)`"']*webhooks?/i.test(content)) {
    problems.push(`${relativePath}: webhook HTTP sin TLS`);
  }
  for (const match of content.matchAll(/http:\/\/([^\s/:)`"']+)/gi)) {
    const host = match[1].toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || !host.includes(".");
    if (!local) problems.push(`${relativePath}: URL HTTP pública o remota no permitida (${match[0]})`);
  }
  const secretPatterns = [
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bsk-[A-Za-z0-9_-]{24,}\b/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
  ];
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    problems.push(`${relativePath}: posible credencial real en documentación`);
  }
  return problems;
}

export function catalogReadmeProblems(content, catalogs) {
  const expected = {
    products: catalogs.products?.items?.length ?? 0,
    services: catalogs.services?.items?.length ?? 0,
    debtItems: catalogs.debt?.items?.length ?? 0,
    findingGroups: catalogs.debt?.baselineStats?.findingGroups ?? 0,
    instances: catalogs.debt?.baselineStats?.instances ?? 0,
    workstreams: catalogs.debt?.baselineStats?.workstreams ?? 0,
    temporaryExceptions: (catalogs.debt?.items ?? []).filter((item) => item.source === "temporary-exception").length,
    transitionInventory: (catalogs.debt?.items ?? []).filter((item) => item.source === "transition-inventory").length
  };
  const match = content.match(
    /Estadísticas normativas:\s*`products=(\d+)`,\s*`services=(\d+)`,\s*`debtItems=(\d+)`,\s*`findingGroups=(\d+)`,\s*`instances=(\d+)`,\s*`workstreams=(\d+)`,\s*`temporaryExceptions=(\d+)`\s*y\s*`transitionInventory=(\d+)`\./
  );
  if (!match) return ["docs/catalogs/README.md: faltan estadísticas normativas parseables"];
  const fields = Object.keys(expected);
  const actual = Object.fromEntries(fields.map((field, index) => [field, Number(match[index + 1])]));
  return fields
    .filter((field) => actual[field] !== expected[field])
    .map(
      (field) => `docs/catalogs/README.md: ${field}=${actual[field]}; esperado ${expected[field]} según los catálogos`
    );
}

export function documentationCiProblems(packageManifest, fullStackWorkflow, cellWorkflow) {
  const problems = [];
  if (packageManifest?.scripts?.["docs:test"] !== "node --test scripts/docs/check-docs.test.mjs") {
    problems.push("package.json: docs:test no ejecuta las pruebas documentales normativas");
  }
  if (packageManifest?.scripts?.["docs:check"] !== "node scripts/docs/check-docs.mjs") {
    problems.push("package.json: docs:check no ejecuta el gate documental normativo");
  }
  for (const [label, workflow] of [
    [".github/workflows/check.yml", fullStackWorkflow],
    [".github/workflows/_cell-ci.yml", cellWorkflow]
  ]) {
    if (!/run:\s*pnpm docs:test\s*$/m.test(workflow)) problems.push(`${label}: no ejecuta pnpm docs:test`);
    if (!/run:\s*pnpm docs:check\s*$/m.test(workflow)) problems.push(`${label}: no ejecuta pnpm docs:check`);
  }
  return problems;
}

function section(content, heading) {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m");
  const match = pattern.exec(content);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const next = rest.search(/^##\s+/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function isRunbookPath(relativePath) {
  const normalized = normalizePath(relativePath);
  if (normalized === "docs/PRODUCTION.md") return true;
  if (normalized.startsWith("docs/operations/") || normalized.startsWith("docs/ops/")) return true;
  if (!normalized.startsWith("docs/products/nova/")) return false;
  return /(?:CUTOVER|CHECKLIST|CONTABO-TEST|POST-CALL-WHATSAPP).*\.md$/i.test(normalized);
}

function dateProblems(label, field, value, now) {
  if (!value) return [];
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!ISO_DATE.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    return [`${label}: ${field} inválida`];
  }
  if (value < now) return [`${label}: ${field} vencida (${value})`];
  return [];
}

function validationDateProblems(label, value, now) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!ISO_DATE.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    return [`${label}: validatedAt inválida`];
  }
  if (value > now) return [`${label}: validatedAt no puede estar en el futuro (${value})`];
  return [];
}

function dateOnly(value) {
  if (typeof value === "string" && ISO_DATE.test(value)) return value;
  return new Date(value).toISOString().slice(0, 10);
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function normalizePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const problems = await runDocsChecks(process.cwd());
  if (problems.length > 0) {
    throw new Error(`docs:check falló:\n- ${problems.join("\n- ")}`);
  }
  process.stdout.write("Documentation checks OK\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
