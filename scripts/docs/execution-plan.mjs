import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { compareSemver, isSemver, validateCatalog, validateManifest } from "../releases/release-model.mjs";

export const EXECUTION_PLAN_PATH = "docs/catalogs/execution-plan.v1.json";

export const EXECUTION_SOURCE_REFS = Object.freeze({
  products: "docs/catalogs/products.v1.json",
  requirements: "docs/products/REQUIREMENTS-TRACEABILITY.md",
  novaSpec: "docs/products/NOVA.md",
  lumenSpec: "docs/products/LUMEN.md",
  pulsoSpec: "docs/products/PULSO-IRIS.md",
  debt: "docs/catalogs/debt.v1.json",
  releaseCatalogs: "releases/catalogs",
  releaseManifests: "releases/manifests"
});

export const RELEASE_REQUIRED_GATES = Object.freeze([
  "code",
  "artifact",
  "isolation",
  "recovery",
  "staging",
  "operations"
]);

const CONTROLLED_REQUIREMENT_STATES = Object.freeze([
  "implementado",
  "parcial",
  "simulado",
  "demo sintética",
  "pendiente",
  "bloqueado por decisión"
]);
const CONTROLLED_REQUIREMENT_STATE_SET = new Set(CONTROLLED_REQUIREMENT_STATES);
const EXECUTION_STATES = new Set(["planned", "transitioning", "accepted"]);
const GATE_SET = new Set(RELEASE_REQUIRED_GATES);
const EVIDENCE_GATES = new Set(["code", "isolation", "recovery", "staging", "operations"]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "catalogVersion",
  "updatedAt",
  "reviewDue",
  "sourceRefs",
  "gatePolicy",
  "waves",
  "items"
]);
const SOURCE_REF_KEYS = new Set(Object.keys(EXECUTION_SOURCE_REFS));
const GATE_POLICY_KEYS = new Set(["releaseRequiredGates"]);
const WAVE_KEYS = new Set(["id", "order", "title", "dueDate"]);
const ITEM_KEYS = new Set([
  "id",
  "title",
  "productId",
  "owner",
  "status",
  "issue",
  "dueDate",
  "wave",
  "dependsOn",
  "requirementRefs",
  "debtRefs",
  "releaseGate",
  "gateRefs",
  "gateEvidence",
  "acceptedAt"
]);
const RELEASE_GATE_KEYS = new Set(["catalogVersion", "publishedRequired", "releaseVersion", "sourceRevision"]);
const EXECUTION_GATE_EVIDENCE_DIRECTORY = "docs/evidence/execution-gates";
const EXECUTION_GATE_MANIFEST_KEYS = new Set([
  "schemaVersion",
  "itemId",
  "productId",
  "gate",
  "timestamp",
  "revision",
  "snapshot",
  "release",
  "verifier",
  "sidecars"
]);
const EXECUTION_GATE_SNAPSHOT_KEYS = new Set(["id", "capturedAt"]);
const EXECUTION_GATE_RELEASE_KEYS = new Set(["cell", "catalogVersion", "releaseVersion", "sourceRevision"]);
const EXECUTION_GATE_VERIFIER_KEYS = new Set(["name", "command", "status", "resultSidecar"]);
const EXECUTION_GATE_SIDECAR_KEYS = new Set(["path", "sha256"]);
const RUNTIME_EVIDENCE_GATES = new Set(["recovery", "staging", "operations"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ISSUE_ID = /^HYP-[A-Z]+-\d{3}$/;
const GIT_REVISION = /^(?!0+$)(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;
const ITEM_ID = /^EXEC-(?:PLATFORM|NOVA|LUMEN|PULSO)-\d{3}$/;
const WAVE_ID = /^WAVE-\d{2}$/;
const OWNER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REQUIREMENT_EXPRESSION =
  /^[A-Z]{3}-\d{3}(?:\s*[–—-]\s*(?:[A-Z]{3}-)?\d{3})?(?:\s*,\s*[A-Z]{3}-\d{3}(?:\s*[–—-]\s*(?:[A-Z]{3}-)?\d{3})?)*$/;
const execFileAsync = promisify(execFile);

export const EXECUTION_GATE_VERIFIER_ALLOWLIST = Object.freeze([
  leafVerifier(
    "PLATFORM",
    "code",
    "platform-contract-tests",
    "pnpm --filter @hyperion/platform-contracts test",
    "packages/platform-contracts/package.json",
    { packageName: "@hyperion/platform-contracts", scriptName: "test", scriptBody: "vitest run" }
  ),
  leafVerifier(
    "NOVA",
    "code",
    "nova-core-tests",
    "pnpm --filter @hyperion/nova-core-service test",
    "services/nova-core-service/package.json",
    { packageName: "@hyperion/nova-core-service", scriptName: "test", scriptBody: "vitest run" }
  ),
  leafVerifier(
    "LUMEN",
    "code",
    "lumen-service-tests",
    "pnpm --filter @hyperion/lumen-service test",
    "services/lumen-service/package.json",
    { packageName: "@hyperion/lumen-service", scriptName: "test", scriptBody: "vitest run" }
  ),
  leafVerifier(
    "PULSO_IRIS",
    "code",
    "pulso-iris-service-tests",
    "pnpm --filter @hyperion/pulso-iris-service test",
    "services/pulso-iris-service/package.json",
    { packageName: "@hyperion/pulso-iris-service", scriptName: "test", scriptBody: "vitest run" }
  ),
  ...["PLATFORM", "NOVA", "LUMEN", "PULSO_IRIS"].map((productId) =>
    leafVerifier(
      productId,
      "isolation",
      "federation-boundary-check",
      "node scripts/architecture/check-federation-boundaries.mjs",
      "scripts/architecture/check-federation-boundaries.mjs"
    )
  ),
  leafVerifier(
    "PLATFORM",
    "recovery",
    "platform-postgres-recovery-tests",
    "node scripts/ops/run-postgres-backup-tests.mjs --cell platform",
    "scripts/ops/run-postgres-backup-tests.mjs"
  ),
  leafVerifier(
    "NOVA",
    "recovery",
    "nova-postgres-recovery-drill",
    "node scripts/ops/run-nova-postgres-recovery-drill.mjs",
    "scripts/ops/run-nova-postgres-recovery-drill.mjs"
  ),
  leafVerifier(
    "LUMEN",
    "recovery",
    "lumen-postgres-recovery-drill",
    "node scripts/ops/run-lumen-postgres-recovery-drill.mjs",
    "scripts/ops/run-lumen-postgres-recovery-drill.mjs"
  ),
  leafVerifier(
    "PULSO_IRIS",
    "recovery",
    "pulso-postgres-recovery-drill",
    "node scripts/ops/run-pulso-postgres-recovery-drill.mjs",
    "scripts/ops/run-pulso-postgres-recovery-drill.mjs"
  ),
  leafVerifier(
    "PLATFORM",
    "staging",
    "platform-nova-acceptance",
    "node scripts/autonomy/platform-nova-acceptance.e2e.mjs",
    "scripts/autonomy/platform-nova-acceptance.e2e.mjs"
  ),
  leafVerifier(
    "NOVA",
    "staging",
    "platform-nova-acceptance",
    "node scripts/autonomy/platform-nova-acceptance.e2e.mjs",
    "scripts/autonomy/platform-nova-acceptance.e2e.mjs"
  ),
  leafVerifier(
    "PULSO_IRIS",
    "staging",
    "pulso-real-flow-e2e",
    "node scripts/autonomy/real-flow.e2e.mjs",
    "scripts/autonomy/real-flow.e2e.mjs"
  ),
  leafVerifier(
    "PLATFORM",
    "operations",
    "registry-publish-path",
    "node scripts/releases/verify-registry-publish-path.mjs --verify-github-access",
    "scripts/releases/verify-registry-publish-path.mjs"
  ),
  leafVerifier(
    "NOVA",
    "operations",
    "nova-recovery-evidence",
    "node scripts/ops/verify-nova-recovery-evidence.mjs --evidence <sidecar>",
    "scripts/ops/verify-nova-recovery-evidence.mjs",
    undefined,
    { evidenceSidecarArgument: true }
  ),
  leafVerifier(
    "PULSO_IRIS",
    "operations",
    "pulso-recovery-evidence",
    "node scripts/ops/verify-pulso-postgres-recovery-evidence.mjs --evidence <sidecar>",
    "scripts/ops/verify-pulso-postgres-recovery-evidence.mjs",
    undefined,
    { evidenceSidecarArgument: true }
  )
]);

export async function loadExecutionPlanContext(root) {
  const [plan, products, debt, packageManifest, novaSpec, lumenSpec, pulsoSpec, traceability] = await Promise.all([
    readJson(root, EXECUTION_PLAN_PATH),
    readJson(root, EXECUTION_SOURCE_REFS.products),
    readJson(root, EXECUTION_SOURCE_REFS.debt),
    readJson(root, "package.json"),
    readText(root, EXECUTION_SOURCE_REFS.novaSpec),
    readText(root, EXECUTION_SOURCE_REFS.lumenSpec),
    readText(root, EXECUTION_SOURCE_REFS.pulsoSpec),
    readText(root, EXECUTION_SOURCE_REFS.requirements)
  ]);
  const canonical = canonicalRequirementIndex({ novaSpec, lumenSpec, pulsoSpec, traceability });
  return { plan, products, debt, packageManifest, canonical };
}

export function canonicalRequirementIndex({ novaSpec, lumenSpec, pulsoSpec, traceability }) {
  const requirements = new Map();
  const problems = [];
  addCanonicalRows(requirements, problems, requirementRows(novaSpec, "NOV"), "docs/products/NOVA.md");
  addCanonicalRows(requirements, problems, requirementRows(pulsoSpec, "PUL"), "docs/products/PULSO-IRIS.md");

  const lumenStatusSection = markdownSection(lumenSpec, "11. Estado real de las capacidades");
  addCanonicalRows(
    requirements,
    problems,
    requirementRows(lumenStatusSection, "LUM"),
    "docs/products/LUMEN.md#11-estado-real-de-las-capacidades"
  );

  const lumenFoundationRows = requirementRows(traceability, "LUM")
    .map((row) => ({
      ...row,
      ids: expandRequirementExpression(row.expression).filter((id) => /^LUM-00[1-6]$/.test(id))
    }))
    .filter((row) => row.ids.length > 0);
  addCanonicalRows(requirements, problems, lumenFoundationRows, "docs/products/REQUIREMENTS-TRACEABILITY.md#lumen");

  return { requirements, problems };
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

export function expandRequirementExpression(expression) {
  const result = [];
  const pattern = /([A-Z]{3})-(\d{3})(?:\s*[–—-]\s*(?:[A-Z]{3}-)?(\d{3}))?/g;
  for (const match of String(expression).matchAll(pattern)) {
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : start;
    if (end < start) continue;
    for (let value = start; value <= end; value += 1) {
      result.push(`${match[1]}-${String(value).padStart(3, "0")}`);
    }
  }
  return result;
}

export function normalizeRequirementState(value = "") {
  const normalized = String(value).replaceAll("`", "").trim().toLocaleLowerCase("es");
  return (
    CONTROLLED_REQUIREMENT_STATES.find(
      (state) =>
        normalized === state ||
        normalized.startsWith(`${state}:`) ||
        normalized.startsWith(`${state};`) ||
        normalized.startsWith(`${state}.`) ||
        normalized.startsWith(`${state}/`) ||
        normalized.startsWith(`${state} `)
    ) ?? normalized
  );
}

export async function analyzeExecutionPlan(context, { root, now = new Date() } = {}) {
  const problems = [...context.canonical.problems];
  const releaseStates = new Map();
  const today = dateOnly(now);
  const plan = context.plan;
  if (!isRecord(plan)) {
    return {
      problems: [`${EXECUTION_PLAN_PATH}: debe contener un objeto JSON`],
      summary: emptySummary(),
      releaseStates
    };
  }

  rejectUnknownKeys(plan, TOP_LEVEL_KEYS, EXECUTION_PLAN_PATH, problems);
  if (plan.schemaVersion !== 1) problems.push(`${EXECUTION_PLAN_PATH}: schemaVersion debe ser 1`);
  if (!isSemver(plan.catalogVersion)) problems.push(`${EXECUTION_PLAN_PATH}: catalogVersion debe usar SemVer`);
  validateDate(`${EXECUTION_PLAN_PATH}: updatedAt`, plan.updatedAt, problems);
  validateDate(`${EXECUTION_PLAN_PATH}: reviewDue`, plan.reviewDue, problems);
  if (isDate(plan.updatedAt) && plan.updatedAt > today) {
    problems.push(`${EXECUTION_PLAN_PATH}: updatedAt no puede estar en el futuro`);
  }
  if (isDate(plan.reviewDue) && plan.reviewDue < today) {
    problems.push(`${EXECUTION_PLAN_PATH}: reviewDue vencida (${plan.reviewDue})`);
  }
  if (isDate(plan.updatedAt) && isDate(plan.reviewDue)) {
    const cadenceDays = daysBetween(plan.updatedAt, plan.reviewDue);
    if (cadenceDays < 0 || cadenceDays > 14) {
      problems.push(`${EXECUTION_PLAN_PATH}: reviewDue debe quedar entre 0 y 14 días después de updatedAt`);
    }
  }

  validateSourceRefs(plan.sourceRefs, problems);
  validateGatePolicy(plan.gatePolicy, problems);

  const sourceDates = [context.products?.updatedAt, context.debt?.updatedAt].filter(isDate).sort();
  const newestSourceDate = sourceDates.at(-1);
  if (isDate(plan.updatedAt) && newestSourceDate && plan.updatedAt < newestSourceDate) {
    problems.push(`${EXECUTION_PLAN_PATH}: updatedAt ${plan.updatedAt} es anterior a una fuente (${newestSourceDate})`);
  }

  const productsById = new Map((context.products?.items ?? []).map((product) => [product.productId, product]));
  const debtsById = new Map((context.debt?.items ?? []).map((debt) => [debt.id, debt]));
  const canonicalIssues = canonicalIssueIndex(context.products?.items ?? [], context.debt?.items ?? [], problems);
  const openDebts = new Map([...debtsById].filter(([, debt]) => debt.status !== "accepted"));
  const waveResult = validateWaves(plan.waves, today, problems);
  const wavesById = waveResult.wavesById;
  const items = Array.isArray(plan.items) ? plan.items : [];
  if (items.length === 0) problems.push(`${EXECUTION_PLAN_PATH}: items debe ser un arreglo no vacío`);

  const itemsById = new Map();
  const requirementOwners = new Map();
  const debtOwners = new Map();
  const openItemsByProduct = new Map();
  const itemRequirements = new Map();

  for (const [index, item] of items.entries()) {
    const label = `${EXECUTION_PLAN_PATH}: items[${index}]`;
    if (!isRecord(item)) {
      problems.push(`${label} debe ser un objeto`);
      continue;
    }
    rejectUnknownKeys(item, ITEM_KEYS, label, problems);
    for (const field of ["id", "title", "productId", "owner", "status", "issue", "dueDate", "wave"]) {
      if (typeof item[field] !== "string" || item[field].trim().length === 0) {
        problems.push(`${label} no declara ${field}`);
      }
    }
    if (!ITEM_ID.test(item.id ?? "")) problems.push(`${label}.id debe usar EXEC-<PRODUCTO>-NNN`);
    if (itemsById.has(item.id)) problems.push(`${EXECUTION_PLAN_PATH}: id duplicado ${item.id}`);
    else if (typeof item.id === "string") itemsById.set(item.id, item);
    if (!OWNER.test(item.owner ?? "")) problems.push(`${label}.owner debe ser un identificador kebab-case`);
    if (!ISSUE_ID.test(item.issue ?? "")) problems.push(`${label}.issue debe usar HYP-<AREA>-NNN`);
    if (!EXECUTION_STATES.has(item.status)) problems.push(`${label}.status no permitido: ${item.status ?? "ausente"}`);
    validateDate(`${label}.dueDate`, item.dueDate, problems);
    if (item.status !== "accepted" && isDate(item.dueDate) && item.dueDate < today) {
      problems.push(`${label}.dueDate vencida (${item.dueDate})`);
    }
    if (item.status === "accepted") {
      validateDate(`${label}.acceptedAt`, item.acceptedAt, problems);
      if (isDate(item.acceptedAt) && item.acceptedAt > today)
        problems.push(`${label}.acceptedAt no puede estar en el futuro`);
    } else if (item.acceptedAt !== undefined) {
      problems.push(`${label}.acceptedAt solo se permite con status accepted`);
    }

    const product = productsById.get(item.productId);
    if (!product) problems.push(`${label}.productId desconocido: ${item.productId ?? "ausente"}`);
    else {
      if (isDate(item.dueDate) && isDate(product.dueDate) && item.dueDate > product.dueDate) {
        problems.push(
          `${label}.dueDate ${item.dueDate} supera el vencimiento de ${product.productId} (${product.dueDate})`
        );
      }
      if (item.status !== "accepted") {
        const productItems = openItemsByProduct.get(product.productId) ?? [];
        productItems.push(item.id);
        openItemsByProduct.set(product.productId, productItems);
      }
      const expectedToken = product.cell === "pulso" ? "PULSO" : product.productId;
      if (typeof item.id === "string" && !item.id.startsWith(`EXEC-${expectedToken}-`)) {
        problems.push(`${label}.id no corresponde a productId ${product.productId}`);
      }
      if (!ownerBelongsToCell(item.owner, product.cell)) {
        problems.push(`${label}.owner ${item.owner} no pertenece a la cell ${product.cell}`);
      }
    }

    const wave = wavesById.get(item.wave);
    if (!wave) problems.push(`${label}.wave desconocida: ${item.wave ?? "ausente"}`);
    else if (isDate(item.dueDate) && isDate(wave.dueDate) && item.dueDate > wave.dueDate) {
      problems.push(`${label}.dueDate ${item.dueDate} supera el cierre de ${wave.id} (${wave.dueDate})`);
    }

    validateStringArray(item.dependsOn, `${label}.dependsOn`, problems);
    validateStringArray(item.requirementRefs, `${label}.requirementRefs`, problems);
    validateStringArray(item.debtRefs, `${label}.debtRefs`, problems);
    validateStringArray(item.gateRefs, `${label}.gateRefs`, problems, { nonEmpty: true });
    validateCanonicalIssue(item, product, debtsById, canonicalIssues, label, problems);
    validateGateRefs(item, label, problems);
    validateReleaseGateShape(item, label, problems);
    let releaseState;
    if (item.releaseGate && product) {
      releaseState = await inspectReleaseGate(root, product.cell, item.releaseGate.catalogVersion, now);
      releaseStates.set(item.id, releaseState);
      problems.push(...releaseState.catalogProblems.map((problem) => `${label}.releaseGate: ${problem}`));
      if (item.status === "accepted" && item.releaseGate.publishedRequired && releaseState.status !== "published") {
        problems.push(`${label} requiere release published para ${product.cell}@${item.releaseGate.catalogVersion}`);
      }
      if (
        item.status === "accepted" &&
        item.releaseGate.publishedRequired &&
        !releaseState.publishedReleases.some(
          (candidate) =>
            candidate.releaseVersion === item.releaseGate.releaseVersion &&
            candidate.sourceRevision === item.releaseGate.sourceRevision
        )
      ) {
        problems.push(`${label}.releaseGate no coincide con un manifest published válido del catálogo`);
      }
    }
    await validateGateEvidence(root, item, product, releaseState, label, problems, now);

    const expanded = [];
    for (const expression of Array.isArray(item.requirementRefs) ? item.requirementRefs : []) {
      if (!REQUIREMENT_EXPRESSION.test(expression)) {
        problems.push(`${label}.requirementRefs usa expresión inválida ${JSON.stringify(expression)}`);
        continue;
      }
      for (const id of expandRequirementExpression(expression)) {
        if (expanded.includes(id)) problems.push(`${label}.requirementRefs repite ${id}`);
        expanded.push(id);
        const requirement = context.canonical.requirements.get(id);
        if (!requirement) {
          problems.push(`${label}.requirementRefs referencia requisito canónico inexistente ${id}`);
          continue;
        }
        if (product?.requirementPrefix !== requirement.prefix) {
          problems.push(
            `${label}.requirementRefs asigna ${id} a ${item.productId}, cuyo prefijo es ${product?.requirementPrefix ?? "ninguno"}`
          );
        }
        const owners = requirementOwners.get(id) ?? [];
        owners.push(item.id);
        requirementOwners.set(id, owners);
        if (item.status !== "accepted" && requirement.state === "implementado") {
          problems.push(`${label}.requirementRefs mantiene ${id} implementado en trabajo abierto`);
        }
      }
    }
    itemRequirements.set(item.id, expanded);

    for (const debtId of Array.isArray(item.debtRefs) ? item.debtRefs : []) {
      const debt = debtsById.get(debtId);
      if (!debt) {
        problems.push(`${label}.debtRefs referencia deuda abierta inexistente ${debtId}`);
        continue;
      }
      if (product && !ownerBelongsToCell(debt.owner, product.cell)) {
        problems.push(`${label}.debtRefs asigna ${debtId} de ${debt.owner} a la cell ${product.cell}`);
      }
      const owners = debtOwners.get(debtId) ?? [];
      owners.push(item.id);
      debtOwners.set(debtId, owners);
      if (isDate(item.dueDate) && isDate(debt.dueDate) && item.dueDate > debt.dueDate) {
        problems.push(`${label}.dueDate ${item.dueDate} supera el vencimiento de ${debtId} (${debt.dueDate})`);
      }
      if (item.status === "accepted" && debt.status !== "accepted") {
        problems.push(`${label} no puede aceptarse mientras ${debtId} permanezca abierto`);
      }
    }

    const scoped =
      expanded.length > 0 ||
      (Array.isArray(item.debtRefs) && item.debtRefs.length > 0) ||
      item.releaseGate !== undefined ||
      Object.values(item.gateEvidence ?? {}).some((evidence) => Array.isArray(evidence) && evidence.length > 0);
    if (!scoped) problems.push(`${label} no posee requisitos, deuda ni gate de release`);
  }

  validateCoverage(context.canonical.requirements, requirementOwners, openDebts, debtOwners, problems);
  validateProductCoverage(context.products?.items ?? [], openItemsByProduct, problems);
  validateDependencies(itemsById, wavesById, problems);

  for (const item of itemsById.values()) {
    if (item.status !== "accepted") continue;
    for (const id of itemRequirements.get(item.id) ?? []) {
      const requirement = context.canonical.requirements.get(id);
      if (requirement?.state !== "implementado") {
        problems.push(
          `${EXECUTION_PLAN_PATH}: ${item.id} no puede aceptarse con ${id} en ${requirement?.state ?? "estado desconocido"}`
        );
      }
    }
    for (const dependencyId of item.dependsOn ?? []) {
      if (itemsById.get(dependencyId)?.status !== "accepted") {
        problems.push(`${EXECUTION_PLAN_PATH}: ${item.id} no puede aceptarse antes de ${dependencyId}`);
      }
    }
    for (const gate of item.gateRefs ?? []) {
      if (gate === "artifact") continue;
      if (EVIDENCE_GATES.has(gate) && (item.gateEvidence?.[gate]?.length ?? 0) === 0) {
        problems.push(`${EXECUTION_PLAN_PATH}: ${item.id} accepted carece de evidencia para gate ${gate}`);
      }
    }
  }

  const summary = buildSummary(context, itemsById, requirementOwners, debtOwners);
  return {
    problems: [...new Set(problems)].sort(),
    summary,
    releaseStates,
    context: { ...context, itemsById, wavesById }
  };
}

export async function validateExecutionPlanRepository(root, options = {}) {
  try {
    const context = await loadExecutionPlanContext(root);
    return await analyzeExecutionPlan(context, { root, now: options.now ?? new Date() });
  } catch (error) {
    return {
      problems: [`${EXECUTION_PLAN_PATH}: no se pudo cargar o validar (${error.message})`],
      summary: emptySummary(),
      releaseStates: new Map()
    };
  }
}

export function renderExecutionPlanStatus(result) {
  const { summary } = result;
  const lines = [
    `Execution plan ${summary.catalogVersion ?? "invalid"} | updated ${summary.updatedAt ?? "unknown"} | review ${summary.reviewDue ?? "unknown"}`,
    `Coverage: requirements ${summary.coveredRequirements}/${summary.openRequirements} | debts ${summary.coveredDebts}/${summary.openDebts} | items ${summary.items} | waves ${summary.waves}`
  ];
  for (const product of summary.products) {
    const states = Object.entries(product.states)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([state, count]) => `${state}=${count}`)
      .join(", ");
    lines.push(
      `${product.productId}: ${product.covered}/${product.open} open requirements${states ? ` (${states})` : ""}`
    );
  }
  if (result.context) {
    const waves = [...result.context.wavesById.values()].sort((left, right) => left.order - right.order);
    for (const wave of waves) {
      lines.push(`\n${wave.id} ${wave.title} | due ${wave.dueDate}`);
      const items = [...result.context.itemsById.values()]
        .filter((item) => item.wave === wave.id)
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const item of items) {
        const requirementCount = (item.requirementRefs ?? []).flatMap(expandRequirementExpression).length;
        const release = result.releaseStates.get(item.id);
        const releaseLabel = release ? ` | release=${release.cell}@${release.catalogVersion}:${release.status}` : "";
        lines.push(
          `- ${item.id} [${item.status}] due=${item.dueDate} requirements=${requirementCount} debts=${item.debtRefs?.length ?? 0} gates=${(item.gateRefs ?? []).join(",")}${releaseLabel}`
        );
      }
    }
  }
  if (result.problems.length > 0) {
    lines.push(`\nProblems: ${result.problems.length}`);
    for (const problem of result.problems) lines.push(`- ${problem}`);
  }
  return `${lines.join("\n")}\n`;
}

function addCanonicalRows(index, problems, rows, source) {
  for (const row of rows) {
    const state = normalizeRequirementState(row.cells[2]);
    if (!CONTROLLED_REQUIREMENT_STATE_SET.has(state)) {
      problems.push(`${source}: ${row.expression} usa estado no controlado ${state || "<vacío>"}`);
      continue;
    }
    const ids = row.ids ?? expandRequirementExpression(row.expression);
    for (const id of ids) {
      if (index.has(id)) problems.push(`${source}: requisito canónico duplicado ${id}`);
      else index.set(id, { id, prefix: id.slice(0, 3), state, source });
    }
  }
}

function canonicalIssueIndex(products, debts, problems) {
  const index = new Map();
  const sources = [
    ...products.map((product) => ({
      entry: product,
      source: `docs/catalogs/products.v1.json:${product.productId ?? "?"}`
    })),
    ...debts.map((debt) => ({ entry: debt, source: `docs/catalogs/debt.v1.json:${debt.id ?? "?"}` }))
  ];
  for (const { entry, source } of sources) {
    if (!ISSUE_ID.test(entry?.issue ?? "")) {
      problems.push(`${source}.issue debe usar HYP-<AREA>-NNN`);
      continue;
    }
    const previous = index.get(entry.issue);
    if (previous) problems.push(`${entry.issue} no es canónico: aparece en ${previous.source} y ${source}`);
    else index.set(entry.issue, { entry, source });
  }
  return index;
}

function validateCanonicalIssue(item, product, debtsById, canonicalIssues, label, problems) {
  if (!ISSUE_ID.test(item.issue ?? "")) return;
  if (!canonicalIssues.has(item.issue)) {
    problems.push(`${label}.issue ${item.issue} no existe en products.v1.json ni debt.v1.json`);
    return;
  }
  const scopedIssues = new Set([product?.issue]);
  for (const debtId of Array.isArray(item.debtRefs) ? item.debtRefs : []) {
    scopedIssues.add(debtsById.get(debtId)?.issue);
  }
  if (!scopedIssues.has(item.issue)) {
    problems.push(`${label}.issue ${item.issue} no pertenece a ${item.productId} ni a sus debtRefs`);
  }
}

function ownerBelongsToCell(owner, cell) {
  return typeof owner === "string" && typeof cell === "string" && (owner === cell || owner.startsWith(`${cell}-`));
}

function validateSourceRefs(sourceRefs, problems) {
  const label = `${EXECUTION_PLAN_PATH}: sourceRefs`;
  if (!isRecord(sourceRefs)) {
    problems.push(`${label} debe ser un objeto`);
    return;
  }
  rejectUnknownKeys(sourceRefs, SOURCE_REF_KEYS, label, problems);
  for (const [key, expected] of Object.entries(EXECUTION_SOURCE_REFS)) {
    if (sourceRefs[key] !== expected) problems.push(`${label}.${key} debe ser ${expected}`);
  }
}

function validateGatePolicy(gatePolicy, problems) {
  const label = `${EXECUTION_PLAN_PATH}: gatePolicy`;
  if (!isRecord(gatePolicy)) {
    problems.push(`${label} debe ser un objeto`);
    return;
  }
  rejectUnknownKeys(gatePolicy, GATE_POLICY_KEYS, label, problems);
  if (JSON.stringify(gatePolicy.releaseRequiredGates) !== JSON.stringify(RELEASE_REQUIRED_GATES)) {
    problems.push(`${label}.releaseRequiredGates debe declarar ${RELEASE_REQUIRED_GATES.join(", ")} en ese orden`);
  }
}

function validateWaves(waves, today, problems) {
  const wavesById = new Map();
  if (!Array.isArray(waves) || waves.length === 0) {
    problems.push(`${EXECUTION_PLAN_PATH}: waves debe ser un arreglo no vacío`);
    return { wavesById };
  }
  const orders = new Set();
  for (const [index, wave] of waves.entries()) {
    const label = `${EXECUTION_PLAN_PATH}: waves[${index}]`;
    if (!isRecord(wave)) {
      problems.push(`${label} debe ser un objeto`);
      continue;
    }
    rejectUnknownKeys(wave, WAVE_KEYS, label, problems);
    if (!WAVE_ID.test(wave.id ?? "")) problems.push(`${label}.id debe usar WAVE-NN`);
    if (WAVE_ID.test(wave.id ?? "") && Number(wave.id.slice(-2)) !== wave.order) {
      problems.push(`${label}.id y order deben representar el mismo número`);
    }
    if (wavesById.has(wave.id)) problems.push(`${EXECUTION_PLAN_PATH}: wave duplicada ${wave.id}`);
    else wavesById.set(wave.id, wave);
    if (!Number.isInteger(wave.order) || wave.order < 0) problems.push(`${label}.order debe ser entero no negativo`);
    if (orders.has(wave.order)) problems.push(`${EXECUTION_PLAN_PATH}: order de wave duplicado ${wave.order}`);
    orders.add(wave.order);
    if (typeof wave.title !== "string" || wave.title.trim().length === 0)
      problems.push(`${label}.title es obligatorio`);
    validateDate(`${label}.dueDate`, wave.dueDate, problems);
    if (isDate(wave.dueDate) && wave.dueDate < today) problems.push(`${label}.dueDate vencida (${wave.dueDate})`);
  }
  const sorted = [...wavesById.values()].sort((left, right) => left.order - right.order);
  sorted.forEach((wave, index) => {
    if (wave.order !== index) problems.push(`${EXECUTION_PLAN_PATH}: waves debe usar orders consecutivos desde 0`);
    if (
      index > 0 &&
      isDate(wave.dueDate) &&
      isDate(sorted[index - 1].dueDate) &&
      wave.dueDate <= sorted[index - 1].dueDate
    ) {
      problems.push(`${EXECUTION_PLAN_PATH}: ${wave.id}.dueDate debe ser posterior a ${sorted[index - 1].id}`);
    }
  });
  return { wavesById };
}

function validateGateRefs(item, label, problems) {
  const gateRefs = Array.isArray(item.gateRefs) ? item.gateRefs : [];
  for (const gate of gateRefs) {
    if (!GATE_SET.has(gate)) problems.push(`${label}.gateRefs usa gate desconocido ${gate}`);
  }
  if (gateRefs.includes("artifact") !== Boolean(item.releaseGate)) {
    problems.push(`${label}: gate artifact y releaseGate deben declararse juntos`);
  }
  if (item.releaseGate?.publishedRequired) {
    const missing = RELEASE_REQUIRED_GATES.filter((gate) => !gateRefs.includes(gate));
    if (missing.length > 0) problems.push(`${label}: release published requiere gates ${missing.join(", ")}`);
  }
}

async function validateGateEvidence(root, item, product, releaseState, label, problems, now) {
  if (!isRecord(item.gateEvidence)) {
    problems.push(`${label}.gateEvidence debe ser un objeto`);
    return;
  }
  if (item.status !== "accepted" && Object.keys(item.gateEvidence).length > 0) {
    problems.push(`${label}.gateEvidence solo puede declararse al aceptar el item`);
  }
  for (const [gate, evidence] of Object.entries(item.gateEvidence)) {
    if (!GATE_SET.has(gate)) problems.push(`${label}.gateEvidence usa gate desconocido ${gate}`);
    if (!item.gateRefs?.includes(gate))
      problems.push(`${label}.gateEvidence declara ${gate} sin incluirlo en gateRefs`);
    if (!Array.isArray(evidence) || evidence.length === 0) {
      problems.push(`${label}.gateEvidence.${gate} debe ser un arreglo no vacío`);
      continue;
    }
    const seen = new Set();
    for (const evidencePath of evidence) {
      if (seen.has(evidencePath)) problems.push(`${label}.gateEvidence.${gate} repite ${evidencePath}`);
      seen.add(evidencePath);
      problems.push(
        ...(await validateExecutionGateManifest({
          root,
          item,
          product,
          releaseState,
          gate,
          evidencePath,
          now,
          label: `${label}.gateEvidence.${gate}`
        }))
      );
    }
  }
}

export async function validateExecutionGateManifest({
  root,
  item,
  product,
  releaseState,
  gate,
  evidencePath,
  now = new Date(),
  label = `${EXECUTION_PLAN_PATH}: ${item?.id ?? "item"}.gateEvidence.${gate ?? "gate"}`
}) {
  const problems = [];
  if (
    !isSafeRepositoryPath(evidencePath) ||
    path.posix.dirname(evidencePath) !== EXECUTION_GATE_EVIDENCE_DIRECTORY ||
    path.posix.extname(evidencePath) !== ".json"
  ) {
    problems.push(`${label} debe apuntar a un manifest JSON directo en ${EXECUTION_GATE_EVIDENCE_DIRECTORY}/`);
    return problems;
  }
  if (typeof root !== "string" || root.length === 0) {
    problems.push(`${label} no puede verificar ${evidencePath} sin raíz del repositorio`);
    return problems;
  }

  let manifestBytes;
  try {
    manifestBytes = await readRegularRepositoryFile(root, evidencePath, "manifest de gate");
  } catch (error) {
    problems.push(`${label} referencia manifest inexistente o ilegible ${evidencePath} (${error.message})`);
    return problems;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    problems.push(`${label} referencia JSON inválido ${evidencePath} (${error.message})`);
    return problems;
  }
  const manifestLabel = `${label} (${evidencePath})`;
  if (!isRecord(manifest)) {
    problems.push(`${manifestLabel} debe contener un objeto JSON`);
    return problems;
  }
  rejectUnknownKeys(manifest, EXECUTION_GATE_MANIFEST_KEYS, manifestLabel, problems);
  if (manifest.schemaVersion !== 1) problems.push(`${manifestLabel}.schemaVersion debe ser 1`);
  if (manifest.itemId !== item?.id) problems.push(`${manifestLabel}.itemId debe ser ${item?.id ?? "<desconocido>"}`);
  if (manifest.productId !== item?.productId) {
    problems.push(`${manifestLabel}.productId debe ser ${item?.productId ?? "<desconocido>"}`);
  }
  if (manifest.gate !== gate) problems.push(`${manifestLabel}.gate debe ser ${gate}`);
  validateUtcTimestamp(`${manifestLabel}.timestamp`, manifest.timestamp, problems, now);
  if (
    item?.status === "accepted" &&
    isDate(item.acceptedAt) &&
    isUtcTimestamp(manifest.timestamp) &&
    manifest.timestamp.slice(0, 10) > item.acceptedAt
  ) {
    problems.push(`${manifestLabel}.timestamp no puede ser posterior a acceptedAt ${item.acceptedAt}`);
  }

  const hasRevision = manifest.revision !== undefined;
  const hasSnapshot = manifest.snapshot !== undefined;
  if (hasRevision && !GIT_REVISION.test(manifest.revision ?? "")) {
    problems.push(`${manifestLabel}.revision debe ser un commit Git SHA-1/SHA-256 completo y no nulo`);
  } else if (hasRevision) {
    await validateRepositoryRevision(root, manifest.revision, `${manifestLabel}.revision`, problems);
  }
  if (!hasRevision && !hasSnapshot) {
    problems.push(`${manifestLabel} debe ligar la evidencia a revision o snapshot`);
  }
  validateExecutionSnapshot(manifest.snapshot, manifest.timestamp, manifestLabel, problems);
  if (RUNTIME_EVIDENCE_GATES.has(gate) && !hasSnapshot) {
    problems.push(`${manifestLabel}.${gate} requiere snapshot del entorno observado`);
  }

  validateExecutionRelease(manifest, item, product, releaseState, manifestLabel, problems);
  const sidecarContents = await validateExecutionSidecars(root, manifest.sidecars, item, gate, manifestLabel, problems);
  await validateExecutionVerifier(
    root,
    item,
    gate,
    manifest.verifier,
    manifest,
    sidecarContents,
    manifestLabel,
    problems
  );
  return problems;
}

function validateExecutionSnapshot(snapshot, timestamp, label, problems) {
  if (snapshot === undefined) return;
  if (!isRecord(snapshot)) {
    problems.push(`${label}.snapshot debe ser un objeto`);
    return;
  }
  rejectUnknownKeys(snapshot, EXECUTION_GATE_SNAPSHOT_KEYS, `${label}.snapshot`, problems);
  if (!SNAPSHOT_ID.test(snapshot.id ?? "")) {
    problems.push(`${label}.snapshot.id debe ser un identificador opaco seguro`);
  }
  validateUtcTimestamp(`${label}.snapshot.capturedAt`, snapshot.capturedAt, problems);
  if (
    isUtcTimestamp(snapshot.capturedAt) &&
    isUtcTimestamp(timestamp) &&
    Date.parse(snapshot.capturedAt) > Date.parse(timestamp)
  ) {
    problems.push(`${label}.snapshot.capturedAt no puede ser posterior a timestamp`);
  }
}

function validateExecutionRelease(manifest, item, product, releaseState, label, problems) {
  const release = manifest.release;
  if (!item?.releaseGate) {
    if (release !== undefined) problems.push(`${label}.release solo se permite cuando el item declara releaseGate`);
    return;
  }
  if (!isRecord(release)) {
    problems.push(`${label}.release es obligatorio cuando el item declara releaseGate`);
    return;
  }
  rejectUnknownKeys(release, EXECUTION_GATE_RELEASE_KEYS, `${label}.release`, problems);
  if (release.cell !== product?.cell)
    problems.push(`${label}.release.cell debe ser ${product?.cell ?? "<desconocido>"}`);
  if (release.catalogVersion !== item.releaseGate.catalogVersion) {
    problems.push(`${label}.release.catalogVersion debe ser ${item.releaseGate.catalogVersion}`);
  }
  if (!isSemver(release.releaseVersion)) problems.push(`${label}.release.releaseVersion debe usar SemVer`);
  if (!GIT_REVISION.test(release.sourceRevision ?? "")) {
    problems.push(`${label}.release.sourceRevision debe ser un commit Git completo y no nulo`);
  }
  const publishedMatch = releaseState?.publishedReleases?.some(
    (candidate) =>
      candidate.releaseVersion === release.releaseVersion && candidate.sourceRevision === release.sourceRevision
  );
  if (!publishedMatch) {
    problems.push(`${label}.release no coincide con un manifest published válido del catálogo`);
  }
  if (release.releaseVersion !== item.releaseGate.releaseVersion) {
    problems.push(`${label}.release.releaseVersion debe coincidir con releaseGate.releaseVersion`);
  }
  if (release.sourceRevision !== item.releaseGate.sourceRevision) {
    problems.push(`${label}.release.sourceRevision debe coincidir con releaseGate.sourceRevision`);
  }
  const publishedRelease = releaseState?.publishedReleases?.find(
    (candidate) =>
      candidate.releaseVersion === release.releaseVersion && candidate.sourceRevision === release.sourceRevision
  );
  if (
    publishedRelease &&
    isDate(item.acceptedAt) &&
    isUtcTimestamp(publishedRelease.releasedAt) &&
    publishedRelease.releasedAt.slice(0, 10) > item.acceptedAt
  ) {
    problems.push(`${label}.release fue publicado después de acceptedAt ${item.acceptedAt}`);
  }
  if (manifest.revision !== release.sourceRevision) {
    problems.push(`${label}.revision debe coincidir con release.sourceRevision`);
  }
}

async function validateExecutionVerifier(root, item, gate, verifier, manifest, sidecarContents, label, problems) {
  if (!isRecord(verifier)) {
    problems.push(`${label}.verifier debe ser un objeto`);
    return;
  }
  rejectUnknownKeys(verifier, EXECUTION_GATE_VERIFIER_KEYS, `${label}.verifier`, problems);
  for (const field of ["name", "command"]) {
    if (typeof verifier[field] !== "string" || verifier[field].trim().length === 0) {
      problems.push(`${label}.verifier.${field} debe ser un string no vacío`);
    }
  }
  if (verifier.status !== "passed") problems.push(`${label}.verifier.status debe ser passed`);
  await validateAllowlistedVerifier(root, item, gate, verifier, manifest, label, problems);
  if (typeof verifier.resultSidecar !== "string" || !sidecarContents.has(verifier.resultSidecar)) {
    problems.push(`${label}.verifier.resultSidecar debe referenciar uno de los sidecars verificados`);
    return;
  }
  let result;
  try {
    result = JSON.parse(sidecarContents.get(verifier.resultSidecar).toString("utf8"));
  } catch (error) {
    problems.push(`${label}.verifier.resultSidecar debe contener JSON válido (${error.message})`);
    return;
  }
  validateVerifierResult(result, manifest, verifier, `${label}.verifier.resultSidecar`, problems);
}

function validateVerifierResult(result, manifest, verifier, label, problems) {
  if (!isRecord(result)) {
    problems.push(`${label} debe contener un objeto JSON`);
    return;
  }
  rejectUnknownKeys(
    result,
    new Set([
      "schemaVersion",
      "itemId",
      "productId",
      "gate",
      "timestamp",
      "revision",
      "snapshot",
      "release",
      "verifier"
    ]),
    label,
    problems
  );
  if (result.schemaVersion !== 1) problems.push(`${label}.schemaVersion debe ser 1`);
  for (const field of ["itemId", "productId", "gate", "timestamp", "revision"]) {
    if (result[field] !== manifest[field]) problems.push(`${label}.${field} no coincide con el manifest de gate`);
  }
  for (const field of ["snapshot", "release"]) {
    if (JSON.stringify(result[field]) !== JSON.stringify(manifest[field])) {
      problems.push(`${label}.${field} no coincide con el manifest de gate`);
    }
  }
  if (!isRecord(result.verifier)) {
    problems.push(`${label}.verifier debe ser un objeto`);
    return;
  }
  rejectUnknownKeys(result.verifier, new Set(["name", "command", "status"]), `${label}.verifier`, problems);
  for (const field of ["name", "command", "status"]) {
    if (result.verifier[field] !== verifier[field]) {
      problems.push(`${label}.verifier.${field} no coincide con el manifest de gate`);
    }
  }
}

function leafVerifier(productId, gate, name, command, sourcePath, packageScript, options = {}) {
  return Object.freeze({
    productId,
    gate,
    name,
    command,
    sourcePath,
    packageScript: packageScript ? Object.freeze(packageScript) : undefined,
    evidenceSidecarArgument: options.evidenceSidecarArgument === true
  });
}

function verifierCommandMatches(candidate, command, manifest) {
  if (!candidate.evidenceSidecarArgument) return command === candidate.command;
  const prefix = candidate.command.replace("<sidecar>", "");
  if (typeof command !== "string" || !command.startsWith(prefix)) return false;
  const evidencePath = command.slice(prefix.length);
  if (!isSafeRepositoryPath(evidencePath) || /\s/.test(evidencePath)) return false;
  return manifest.sidecars?.some((sidecar) => sidecar?.path === evidencePath) === true;
}

async function validateAllowlistedVerifier(root, item, gate, verifier, manifest, label, problems) {
  const scoped = EXECUTION_GATE_VERIFIER_ALLOWLIST.filter(
    (candidate) => candidate.productId === item?.productId && candidate.gate === gate
  );
  const allowed = scoped.find(
    (candidate) => candidate.name === verifier?.name && verifierCommandMatches(candidate, verifier?.command, manifest)
  );
  if (!allowed) {
    const options = scoped.map((candidate) => `${candidate.name} => ${candidate.command}`).join("; ");
    problems.push(
      `${label}.verifier no pertenece a la allowlist leaf de ${item?.productId ?? "producto"}/${gate}` +
        `${options ? ` (permitidos: ${options})` : " (sin verifier aprobado)"}`
    );
    return;
  }

  const sourceRevision = GIT_REVISION.test(manifest.revision ?? "") ? manifest.revision : "HEAD";
  let source;
  try {
    const tree = await execFileAsync("git", ["-C", root, "ls-tree", sourceRevision, "--", allowed.sourcePath], {
      windowsHide: true
    });
    const [metadata, trackedPath] = tree.stdout.trim().split("\t");
    const [mode, type] = metadata?.split(/\s+/) ?? [];
    if (!/^100(?:644|755)$/.test(mode ?? "") || type !== "blob" || trackedPath !== allowed.sourcePath) {
      throw new Error("la fuente no es un archivo regular versionado");
    }
    source = (
      await execFileAsync("git", ["-C", root, "show", `${sourceRevision}:${allowed.sourcePath}`], {
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      })
    ).stdout;
  } catch (error) {
    problems.push(
      `${label}.verifier no puede acreditar ${allowed.sourcePath} como fuente leaf en ${sourceRevision} (${error.message})`
    );
    return;
  }

  if (/\bexecution:(?:check|status)\b|scripts[\\/]docs[\\/]execution-plan\.mjs/.test(source)) {
    problems.push(`${label}.verifier source leaf referencia el propio validador del plan`);
  }
  if (!allowed.packageScript) return;
  try {
    const packageManifest = JSON.parse(source);
    if (packageManifest.name !== allowed.packageScript.packageName) {
      problems.push(`${label}.verifier package name no coincide con ${allowed.packageScript.packageName}`);
    }
    if (packageManifest.scripts?.[allowed.packageScript.scriptName] !== allowed.packageScript.scriptBody) {
      problems.push(
        `${label}.verifier script ${allowed.packageScript.scriptName} dejó de ser leaf (${allowed.packageScript.scriptBody})`
      );
    }
  } catch (error) {
    problems.push(`${label}.verifier package source no contiene JSON válido (${error.message})`);
  }
}

async function validateExecutionSidecars(root, sidecars, item, gate, label, problems) {
  const contents = new Map();
  if (!Array.isArray(sidecars) || sidecars.length === 0) {
    problems.push(`${label}.sidecars debe ser un arreglo no vacío`);
    return contents;
  }
  const expectedDirectory = `${EXECUTION_GATE_EVIDENCE_DIRECTORY}/sidecars/${item?.id ?? "unknown"}/${gate}/`;
  const seen = new Set();
  for (const [index, sidecar] of sidecars.entries()) {
    const sidecarLabel = `${label}.sidecars[${index}]`;
    if (!isRecord(sidecar)) {
      problems.push(`${sidecarLabel} debe ser un objeto`);
      continue;
    }
    rejectUnknownKeys(sidecar, EXECUTION_GATE_SIDECAR_KEYS, sidecarLabel, problems);
    if (seen.has(sidecar.path)) problems.push(`${label}.sidecars repite ${sidecar.path}`);
    seen.add(sidecar.path);
    if (!isSafeRepositoryPath(sidecar.path) || !sidecar.path.startsWith(expectedDirectory)) {
      problems.push(`${sidecarLabel}.path debe estar dentro de ${expectedDirectory}`);
      continue;
    }
    if (!SHA256.test(sidecar.sha256 ?? "")) {
      problems.push(`${sidecarLabel}.sha256 debe ser un SHA-256 no nulo en minúsculas`);
    }
    try {
      const bytes = await readRegularRepositoryFile(root, sidecar.path, "sidecar de gate");
      contents.set(sidecar.path, bytes);
      if (bytes.length === 0) problems.push(`${sidecarLabel}.path no puede estar vacío`);
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (sidecar.sha256 !== actualSha256) {
        problems.push(`${sidecarLabel}.sha256 no coincide con los bytes de ${sidecar.path}`);
      }
    } catch (error) {
      problems.push(`${sidecarLabel}.path es inexistente o ilegible (${error.message})`);
    }
  }
  return contents;
}

function validateReleaseGateShape(item, label, problems) {
  if (item.releaseGate === undefined) return;
  if (!isRecord(item.releaseGate)) {
    problems.push(`${label}.releaseGate debe ser un objeto`);
    return;
  }
  rejectUnknownKeys(item.releaseGate, RELEASE_GATE_KEYS, `${label}.releaseGate`, problems);
  if (!isSemver(item.releaseGate.catalogVersion)) problems.push(`${label}.releaseGate.catalogVersion debe usar SemVer`);
  if (item.releaseGate.publishedRequired !== true)
    problems.push(`${label}.releaseGate.publishedRequired debe ser true`);
  const hasReleaseVersion = item.releaseGate.releaseVersion !== undefined;
  const hasSourceRevision = item.releaseGate.sourceRevision !== undefined;
  if (hasReleaseVersion !== hasSourceRevision) {
    problems.push(`${label}.releaseGate debe fijar releaseVersion y sourceRevision juntos`);
  }
  if (hasReleaseVersion && !isSemver(item.releaseGate.releaseVersion)) {
    problems.push(`${label}.releaseGate.releaseVersion debe usar SemVer`);
  }
  if (hasSourceRevision && !GIT_REVISION.test(item.releaseGate.sourceRevision ?? "")) {
    problems.push(`${label}.releaseGate.sourceRevision debe ser un commit Git SHA-1/SHA-256 completo y no nulo`);
  }
  if (item.status === "accepted" && (!hasReleaseVersion || !hasSourceRevision)) {
    problems.push(`${label}.releaseGate accepted debe fijar releaseVersion y sourceRevision`);
  }
}

async function inspectReleaseGate(root, cell, catalogVersion, now = new Date()) {
  const state = {
    cell,
    catalogVersion,
    status: "missing",
    catalogProblems: [],
    publishedReleases: []
  };
  if (!root || !cell || !isSemver(catalogVersion)) return state;
  const catalogPath = `releases/catalogs/${cell}/${catalogVersion}.json`;
  let catalog;
  try {
    catalog = await readJson(root, catalogPath);
    state.catalogProblems.push(...validateCatalog(catalog, { context: catalogPath, root }));
  } catch (error) {
    state.catalogProblems.push(`${catalogPath} ausente o inválido (${error.message})`);
    return state;
  }
  if (catalog.cell !== cell) state.catalogProblems.push(`${catalogPath}.cell debe ser ${cell}`);
  try {
    const catalogEntries = await readdir(path.join(root, "releases", "catalogs", cell), { withFileTypes: true });
    const versions = catalogEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .filter(isSemver)
      .sort(compareSemver);
    const latest = versions.at(-1);
    if (latest !== catalogVersion) {
      state.catalogProblems.push(
        `${catalogPath} no es el catálogo vigente de ${cell}; esperado ${latest ?? "ninguno"}`
      );
    }
  } catch (error) {
    state.catalogProblems.push(`no se pudo determinar el catálogo vigente de ${cell}: ${error.message}`);
  }
  let entries;
  try {
    entries = await readdir(path.join(root, "releases", "manifests", cell), { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT")
      state.catalogProblems.push(`no se pudieron leer manifests de ${cell}: ${error.message}`);
    return state;
  }
  let matchingDraft = false;
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
    let manifest;
    try {
      manifest = await readJson(root, `releases/manifests/${cell}/${entry.name}`);
    } catch {
      continue;
    }
    if (manifest.catalogVersion !== catalogVersion) continue;
    if (manifest.status === "draft") matchingDraft = true;
    if (manifest.status === "published" && validateManifest(manifest, catalog, { publishable: true }).length === 0) {
      const manifestPath = `releases/manifests/${cell}/${entry.name}`;
      const publicationProblems = [];
      if (entry.name !== `${manifest.releaseVersion}.json`) {
        publicationProblems.push(`${manifestPath} debe llamarse ${manifest.releaseVersion}.json`);
      }
      validateUtcTimestamp(`${manifestPath}.releasedAt`, manifest.releasedAt, publicationProblems, now);
      if (GIT_REVISION.test(manifest.sourceRevision ?? "")) {
        await validateRepositoryRevision(
          root,
          manifest.sourceRevision,
          `${manifestPath}.sourceRevision`,
          publicationProblems
        );
      }
      if (publicationProblems.length > 0) {
        state.catalogProblems.push(...publicationProblems);
        continue;
      }
      state.publishedReleases.push({
        releaseVersion: manifest.releaseVersion,
        sourceRevision: manifest.sourceRevision,
        releasedAt: manifest.releasedAt,
        manifestPath
      });
    }
  }
  if (state.publishedReleases.length > 0) {
    state.publishedReleases.sort((left, right) => compareSemver(left.releaseVersion, right.releaseVersion));
    const latestPublished = state.publishedReleases.at(-1);
    state.status = "published";
    state.releaseVersion = latestPublished.releaseVersion;
    state.sourceRevision = latestPublished.sourceRevision;
  } else if (matchingDraft) state.status = "draft";
  return state;
}

function validateCoverage(requirements, requirementOwners, openDebts, debtOwners, problems) {
  for (const requirement of requirements.values()) {
    if (requirement.state === "implementado") continue;
    const owners = requirementOwners.get(requirement.id) ?? [];
    if (owners.length !== 1) {
      problems.push(
        `${EXECUTION_PLAN_PATH}: ${requirement.id} debe tener exactamente un owner de ejecución (tiene ${owners.length})`
      );
    }
  }
  for (const [id, owners] of requirementOwners) {
    if (owners.length > 1) problems.push(`${EXECUTION_PLAN_PATH}: ${id} está asignado a ${owners.join(", ")}`);
  }
  for (const debtId of openDebts.keys()) {
    const owners = debtOwners.get(debtId) ?? [];
    if (owners.length !== 1) {
      problems.push(
        `${EXECUTION_PLAN_PATH}: ${debtId} debe tener exactamente un owner de ejecución (tiene ${owners.length})`
      );
    }
  }
  for (const [id, owners] of debtOwners) {
    if (owners.length > 1) problems.push(`${EXECUTION_PLAN_PATH}: ${id} está asignada a ${owners.join(", ")}`);
  }
}

function validateProductCoverage(products, openItemsByProduct, problems) {
  for (const product of products) {
    if (!["planned", "transitioning"].includes(product.status)) continue;
    if ((openItemsByProduct.get(product.productId)?.length ?? 0) === 0) {
      problems.push(`${EXECUTION_PLAN_PATH}: producto ${product.productId} ${product.status} no tiene trabajo abierto`);
    }
  }
}

function validateDependencies(itemsById, wavesById, problems) {
  for (const item of itemsById.values()) {
    const seen = new Set();
    for (const dependencyId of item.dependsOn ?? []) {
      if (seen.has(dependencyId))
        problems.push(`${EXECUTION_PLAN_PATH}: ${item.id} repite dependencia ${dependencyId}`);
      seen.add(dependencyId);
      if (dependencyId === item.id) problems.push(`${EXECUTION_PLAN_PATH}: ${item.id} depende de sí mismo`);
      const dependency = itemsById.get(dependencyId);
      if (!dependency) {
        problems.push(`${EXECUTION_PLAN_PATH}: ${item.id} depende de item inexistente ${dependencyId}`);
        continue;
      }
      const itemWave = wavesById.get(item.wave);
      const dependencyWave = wavesById.get(dependency.wave);
      if (itemWave && dependencyWave && dependencyWave.order > itemWave.order) {
        problems.push(`${EXECUTION_PLAN_PATH}: ${item.id} depende de ${dependencyId} en una wave posterior`);
      }
      if (isDate(item.dueDate) && isDate(dependency.dueDate) && dependency.dueDate > item.dueDate) {
        problems.push(`${EXECUTION_PLAN_PATH}: ${dependencyId} vence después de su dependiente ${item.id}`);
      }
      if (
        item.status === "accepted" &&
        dependency.status === "accepted" &&
        isDate(item.acceptedAt) &&
        isDate(dependency.acceptedAt) &&
        dependency.acceptedAt > item.acceptedAt
      ) {
        problems.push(`${EXECUTION_PLAN_PATH}: ${dependencyId} fue aceptado después de su dependiente ${item.id}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id, trail) {
    if (visiting.has(id)) {
      problems.push(`${EXECUTION_PLAN_PATH}: ciclo de dependencias ${[...trail, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const item = itemsById.get(id);
    for (const dependency of item?.dependsOn ?? []) {
      if (itemsById.has(dependency)) visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of itemsById.keys()) visit(id, []);
}

function buildSummary(context, itemsById, requirementOwners, debtOwners) {
  const productsByPrefix = new Map(
    (context.products?.items ?? [])
      .filter((product) => product.requirementPrefix)
      .map((product) => [product.requirementPrefix, product.productId])
  );
  const products = new Map();
  let openRequirements = 0;
  let coveredRequirements = 0;
  for (const requirement of context.canonical.requirements.values()) {
    if (requirement.state === "implementado") continue;
    openRequirements += 1;
    if ((requirementOwners.get(requirement.id)?.length ?? 0) === 1) coveredRequirements += 1;
    const productId = productsByPrefix.get(requirement.prefix) ?? requirement.prefix;
    const summary = products.get(productId) ?? { productId, open: 0, covered: 0, states: {} };
    summary.open += 1;
    if ((requirementOwners.get(requirement.id)?.length ?? 0) === 1) summary.covered += 1;
    summary.states[requirement.state] = (summary.states[requirement.state] ?? 0) + 1;
    products.set(productId, summary);
  }
  const openDebts = (context.debt?.items ?? []).filter((debt) => debt.status !== "accepted").length;
  const coveredDebts = (context.debt?.items ?? []).filter(
    (debt) => debt.status !== "accepted" && (debtOwners.get(debt.id)?.length ?? 0) === 1
  ).length;
  return {
    catalogVersion: context.plan?.catalogVersion,
    updatedAt: context.plan?.updatedAt,
    reviewDue: context.plan?.reviewDue,
    openRequirements,
    coveredRequirements,
    openDebts,
    coveredDebts,
    items: itemsById.size,
    waves: context.plan?.waves?.length ?? 0,
    products: [...products.values()].sort((left, right) => left.productId.localeCompare(right.productId))
  };
}

function emptySummary() {
  return {
    openRequirements: 0,
    coveredRequirements: 0,
    openDebts: 0,
    coveredDebts: 0,
    items: 0,
    waves: 0,
    products: []
  };
}

function validateStringArray(value, label, problems, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    problems.push(`${label} debe ser un arreglo${nonEmpty ? " no vacío" : ""}`);
    return;
  }
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) problems.push(`${label} solo admite strings no vacíos`);
    if (seen.has(entry)) problems.push(`${label} repite ${entry}`);
    seen.add(entry);
  }
}

function validateDate(label, value, problems) {
  if (!isDate(value)) problems.push(`${label} debe usar YYYY-MM-DD válido`);
}

function isDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateUtcTimestamp(label, value, problems, now) {
  if (!isUtcTimestamp(value)) {
    problems.push(`${label} debe usar RFC 3339 UTC`);
    return;
  }
  if (now instanceof Date && Number.isFinite(now.getTime()) && Date.parse(value) > now.getTime()) {
    problems.push(`${label} no puede estar en el futuro`);
  }
}

function isUtcTimestamp(value) {
  if (typeof value !== "string" || !RFC3339_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction = "") => `.${fraction.padEnd(3, "0")}Z`);
  return new Date(parsed).toISOString() === normalized;
}

async function validateRepositoryRevision(root, revision, label, problems) {
  try {
    await execFileAsync("git", ["-C", root, "cat-file", "-e", `${revision}^{commit}`], {
      windowsHide: true
    });
  } catch {
    problems.push(`${label} no identifica un commit existente en el repositorio`);
    return;
  }
  try {
    await execFileAsync("git", ["-C", root, "merge-base", "--is-ancestor", revision, "HEAD"], {
      windowsHide: true
    });
  } catch {
    problems.push(`${label} no es alcanzable desde HEAD`);
  }
}

function daysBetween(left, right) {
  return Math.round((Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)) / 86_400_000);
}

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function markdownSection(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^##\\s+${escaped}\\s*$`, "m").exec(content);
  if (!match) return "";
  const rest = content.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function rejectUnknownKeys(value, allowed, label, problems) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) problems.push(`${label} contiene propiedad no soportada ${key}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.isAbsolute(value)) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function readRegularRepositoryFile(root, relativePath, label) {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`${label} atraviesa un enlace simbólico o junction`);
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new Error(`${label} atraviesa un componente que no es directorio`);
    }
    if (index === segments.length - 1 && !metadata.isFile()) {
      throw new Error(`${label} no es un archivo regular`);
    }
  }
  const canonicalFile = await realpath(current);
  const fromRoot = path.relative(canonicalRoot, canonicalFile);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`${label} escapa de la raíz del repositorio`);
  }
  return readFile(canonicalFile);
}

async function readJson(root, relativePath) {
  const content = await readText(root, relativePath);
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${relativePath} no es JSON válido: ${error.message}`, { cause: error });
  }
}

async function readText(root, relativePath) {
  try {
    return await readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    throw new Error(`${relativePath} no se pudo leer: ${error.message}`, { cause: error });
  }
}

async function main() {
  const argumentsSet = new Set(process.argv.slice(2));
  if ([...argumentsSet].some((argument) => !["--check", "--status"].includes(argument))) {
    throw new Error("Usage: node scripts/docs/execution-plan.mjs [--check|--status]");
  }
  const result = await validateExecutionPlanRepository(process.cwd());
  if (argumentsSet.has("--status")) process.stdout.write(renderExecutionPlanStatus(result));
  if (result.problems.length > 0) {
    if (!argumentsSet.has("--status")) {
      process.stderr.write(`Execution plan validation failed with ${result.problems.length} error(s):\n`);
      for (const problem of result.problems) process.stderr.write(`- ${problem}\n`);
    }
    process.exitCode = 1;
    return;
  }
  if (!argumentsSet.has("--status")) {
    process.stdout.write(
      `Execution plan OK: ${result.summary.coveredRequirements}/${result.summary.openRequirements} open requirements and ${result.summary.coveredDebts}/${result.summary.openDebts} open debts covered.\n`
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
