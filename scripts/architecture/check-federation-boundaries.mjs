import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { dependencyCellAllowed, discoverPackages, normalizeRepoPath, packageForPath } from "./cell-policy.mjs";

const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([
  ".docker-contexts",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "graphify-out",
  "node_modules"
]);
const GLOBAL_BUILD_PATTERNS = [
  /\bpnpm\s+(?:-r|--recursive)\s+(?:run\s+)?build\b/i,
  /\bpnpm\s+(?:run\s+)?build\s+(?:-r|--recursive)\b/i,
  /\bpnpm\s+recursive\s+(?:run\s+)?build\b/i
];
const SQL_IDENTIFIER_SOURCE = String.raw`(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)`;
const SQL_SLUG_REFERENCE_SOURCE = String.raw`(?:${SQL_IDENTIFIER_SOURCE}\s*\.\s*)?(?:"slug"|slug)`;
const SQL_ID_REFERENCE_SOURCE = String.raw`(?:${SQL_IDENTIFIER_SOURCE}\s*\.\s*)?(?:"(?:tenant_?id|id)"|tenant_?id|id)`;
const SQL_UUID_ANCHOR_SOURCE = String.raw`(?:\$[1-9]\d*|'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')(?:\s*::\s*uuid)?`;
const SQL_TYPE_REFERENCE_SOURCE = String.raw`${SQL_IDENTIFIER_SOURCE}(?:\s*\.\s*${SQL_IDENTIFIER_SOURCE})?(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?`;
const HISTORICAL_TENANT_SLUG_FINDING = "hardcoded-tenant-slug-selection";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DEBT_ID = /^DEBT-\d{3}$/u;
const ISSUE_ID = /^HYP-[A-Z]+-\d{3}$/u;
const OWNER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const LEGACY_GLOBAL_CONTRACTS = "@hyperion/contracts";
/** Empty: DEBT-021 closed; no runtime package may consume `@hyperion/contracts`. */
const LEGACY_GLOBAL_CONTRACT_CONSUMERS = new Set();
const PRODUCT_BFF_POLICIES = [
  {
    path: "apps/nova-bff/src/app.ts",
    policySources: ["packages/nova-contracts/src/bff-route-policies.ts"],
    exportName: "NOVA_BFF_TENANT_ROUTE_POLICIES",
    publicExportName: "NOVA_BFF_PUBLIC_ROUTE_POLICIES",
    allowedPublicNamespaces: ["auth", "liwa", "tenants", "voice"]
  },
  {
    path: "apps/lumen-bff/src/app.ts",
    policySources: ["packages/lumen-contracts/src/bff-route-policies.ts"],
    exportName: "LUMEN_BFF_TENANT_ROUTE_POLICIES",
    publicExportName: "LUMEN_BFF_PUBLIC_ROUTE_POLICIES",
    allowedPublicNamespaces: ["auth", "lumen", "tenants"]
  },
  {
    path: "apps/pulso-bff/src/app.ts",
    policySources: ["packages/pulso-contracts/src/bff-route-policies.ts"],
    exportName: "PULSO_BFF_TENANT_ROUTE_POLICIES",
    publicExportName: "PULSO_BFF_PUBLIC_ROUTE_POLICIES",
    allowedPublicNamespaces: ["auth", "tenants"]
  }
];
const PRODUCT_BFF_ROUTE_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"]);
const POLICY_HELPERS = {
  novaTenantRoute: { method: 0, component: 1, suffix: 2, capability: 3, roles: 4 },
  pulsoCoreRoute: { method: 0, componentValue: "pulso-iris", suffix: 1, capability: 2, roles: 3 },
  pulsoIntegrationRoute: { method: 0, componentValue: "integrations", suffix: 1, capability: 2, roles: 3 },
  pulsoTenantRoute: { method: 0, component: 1, suffix: 2, capability: 4, roles: 5 }
};

async function walk(root, predicate = () => true) {
  const files = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...(await walk(path.join(root, entry.name), predicate)));
    } else if (entry.isFile()) {
      const filePath = path.join(root, entry.name);
      if (predicate(filePath)) files.push(filePath);
    }
  }
  return files;
}

function scriptKind(filePath) {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function staticRouteText(node, placeholder = "*") {
  const value = unwrapExpression(node);
  if (!value) return undefined;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isTemplateExpression(value)) {
    return `${value.head.text}${value.templateSpans.map((span) => `${placeholder}${span.literal.text}`).join("")}`;
  }
  return undefined;
}

function objectProperty(object, name) {
  return object.properties.find((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const propertyName = property.name;
    return (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)) && propertyName.text === name;
  });
}

function resolvePolicyExpression(node, declarations) {
  const value = unwrapExpression(node);
  if (!value) return undefined;
  if (ts.isIdentifier(value)) {
    const declaration = declarations.get(value.text);
    return declaration ? resolvePolicyExpression(declaration, declarations) : value;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const owner = resolvePolicyExpression(value.expression, declarations);
    if (!owner || !ts.isObjectLiteralExpression(owner)) return value;
    const property = objectProperty(owner, value.name.text);
    return property ? resolvePolicyExpression(property.initializer, declarations) : value;
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.expression.getText() === "Object" &&
    value.expression.name.text === "freeze"
  ) {
    return resolvePolicyExpression(value.arguments[0], declarations);
  }
  return value;
}

function policyFromElement(element) {
  const value = unwrapExpression(element);
  if (ts.isObjectLiteralExpression(value)) {
    const methodProperty = objectProperty(value, "method");
    const pathProperty = objectProperty(value, "path");
    const capabilityProperty = objectProperty(value, "capability");
    return {
      method: methodProperty ? staticRouteText(methodProperty.initializer)?.toUpperCase() : undefined,
      path: pathProperty ? staticRouteText(pathProperty.initializer) : undefined,
      capability: capabilityProperty ? staticRouteText(capabilityProperty.initializer) : undefined,
      hasRoles: Boolean(objectProperty(value, "roles"))
    };
  }
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) return undefined;
  const signature = POLICY_HELPERS[value.expression.text];
  if (!signature) return undefined;
  const component = signature.componentValue ?? staticRouteText(value.arguments[signature.component]);
  const suffix = staticRouteText(value.arguments[signature.suffix]);
  return {
    method: staticRouteText(value.arguments[signature.method])?.toUpperCase(),
    path: component && suffix ? `/v1/tenants/:tenantId/${component}/${suffix}` : undefined,
    capability: staticRouteText(value.arguments[signature.capability]),
    hasRoles:
      value.arguments.length > signature.roles &&
      value.arguments[signature.roles].kind !== ts.SyntaxKind.UndefinedKeyword
  };
}

export function detectProductBffPolicyViolations(sourceText, filePath, exportName, publicPolicy = undefined) {
  const violations = [];
  const ast = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const declarations = new Map();
  let policyInitializer;
  let publicPolicyInitializer;

  function visitDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, node.initializer);
      if (node.name.text === exportName) policyInitializer = node.initializer;
      if (node.name.text === publicPolicy?.exportName) publicPolicyInitializer = node.initializer;
    }
    ts.forEachChild(node, visitDeclarations);
  }
  visitDeclarations(ast);

  function add(kind, message) {
    violations.push({ kind, path: normalizeRepoPath(filePath), message });
  }

  const registeredV1Routes = [];

  function recordRegisteredRoute(method, routePath) {
    if (!method || !routePath?.startsWith("/v1/")) return;
    registeredV1Routes.push({ method: method.toUpperCase(), path: routePath });
    if (routePath.includes("*")) {
      add("open-product-bff-wildcard", `product route ${routePath} contains an open wildcard`);
    }
  }

  function visitRoutes(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const registration = node.expression.name.text.toLowerCase();
      if (registration === "all") {
        add("open-product-bff-all", ".all() is forbidden in product BFFs; register each method and path explicitly");
      }
      if (["get", "post", "patch", "put", "delete", "head", "all"].includes(registration)) {
        const routePath = staticRouteText(resolvePolicyExpression(node.arguments[0], declarations));
        recordRegisteredRoute(registration, routePath);
      }
      if (registration === "route") {
        const options = unwrapExpression(node.arguments[0]);
        if (options && ts.isObjectLiteralExpression(options)) {
          const methodProperty = objectProperty(options, "method");
          const urlProperty = objectProperty(options, "url") ?? objectProperty(options, "path");
          const methodValue = methodProperty ? unwrapExpression(methodProperty.initializer) : undefined;
          const resolvedMethodValue = methodProperty
            ? resolvePolicyExpression(methodProperty.initializer, declarations)
            : undefined;
          const routePath = urlProperty
            ? staticRouteText(resolvePolicyExpression(urlProperty.initializer, declarations))
            : undefined;
          if (
            methodValue &&
            (ts.isArrayLiteralExpression(methodValue) ||
              ts.isIdentifier(methodValue) ||
              staticRouteText(methodValue) === "*")
          ) {
            add(
              "open-product-bff-method-set",
              "route.method must be one explicit policy method, never an array, wildcard or shared METHODS identifier"
            );
          }
          recordRegisteredRoute(staticRouteText(resolvedMethodValue), routePath);
        }
      }
    }
    ts.forEachChild(node, visitRoutes);
  }
  visitRoutes(ast);

  if (publicPolicy) {
    const resolvedPublicPolicies = resolvePolicyExpression(publicPolicyInitializer, declarations);
    const publicRouteKeys = new Set();
    if (!resolvedPublicPolicies || !ts.isObjectLiteralExpression(resolvedPublicPolicies)) {
      add(
        "missing-product-bff-public-policy",
        `${publicPolicy.exportName} must resolve to a non-empty exact public /v1 route catalog`
      );
    } else {
      const entries = resolvedPublicPolicies.properties.filter(ts.isPropertyAssignment);
      if (entries.length === 0) {
        add(
          "missing-product-bff-public-policy",
          `${publicPolicy.exportName} must resolve to a non-empty exact public /v1 route catalog`
        );
      }
      for (const entry of entries) {
        const policy = resolvePolicyExpression(entry.initializer, declarations);
        const methodProperty =
          policy && ts.isObjectLiteralExpression(policy) ? objectProperty(policy, "method") : undefined;
        const pathProperty =
          policy && ts.isObjectLiteralExpression(policy) ? objectProperty(policy, "path") : undefined;
        const method = methodProperty
          ? staticRouteText(resolvePolicyExpression(methodProperty.initializer, declarations))?.toUpperCase()
          : undefined;
        const routePath = pathProperty
          ? staticRouteText(resolvePolicyExpression(pathProperty.initializer, declarations))
          : undefined;
        if (!method || !routePath || !PRODUCT_BFF_ROUTE_METHODS.has(method)) {
          add(
            "incomplete-product-bff-public-policy",
            `${publicPolicy.exportName} entries must declare one static HTTP method and path`
          );
          continue;
        }
        if (
          !routePath.startsWith("/v1/") ||
          routePath.includes("*") ||
          routePath.includes(":") ||
          routePath.includes("?") ||
          routePath.startsWith("/v1/tenants/")
        ) {
          add(
            "invalid-product-bff-public-policy-path",
            `${method} ${routePath} is not an exact non-tenant public /v1 route`
          );
        }
        const namespace = routePath.split("/")[2];
        if (!publicPolicy.allowedNamespaces.includes(namespace)) {
          add(
            "foreign-product-bff-public-namespace",
            `${method} ${routePath} uses namespace ${namespace ?? "<missing>"}, outside ${publicPolicy.allowedNamespaces.join(", ")}`
          );
        }
        const routeKey = `${method} ${routePath}`;
        if (publicRouteKeys.has(routeKey)) {
          add("duplicate-product-bff-public-policy", `${routeKey} is declared more than once`);
        }
        publicRouteKeys.add(routeKey);
      }
    }

    for (const route of registeredV1Routes) {
      if (route.path.startsWith("/v1/tenants/:tenantId/")) continue;
      const routeKey = `${route.method} ${route.path}`;
      const namespace = route.path.split("/")[2];
      if (!publicPolicy.allowedNamespaces.includes(namespace)) {
        add(
          "foreign-product-bff-public-namespace",
          `${routeKey} uses namespace ${namespace ?? "<missing>"}, outside ${publicPolicy.allowedNamespaces.join(", ")}`
        );
      }
      if (!publicRouteKeys.has(routeKey)) {
        add("uncatalogued-product-bff-route", `${routeKey} is registered outside ${publicPolicy.exportName}`);
      }
    }
  }

  const resolvedPolicies = resolvePolicyExpression(policyInitializer, declarations);
  if (!resolvedPolicies || !ts.isArrayLiteralExpression(resolvedPolicies) || resolvedPolicies.elements.length === 0) {
    add("missing-product-bff-policy", `${exportName} must resolve to a non-empty exact tenant policy array`);
    return violations;
  }

  const routeKeys = new Set();
  for (const element of resolvedPolicies.elements) {
    const policy = policyFromElement(element);
    if (!policy?.method || !policy.path || !policy.capability) {
      add(
        "incomplete-product-bff-policy",
        `${exportName} entries must declare one static method, tenant path and capability`
      );
      continue;
    }
    if (!policy.path.startsWith("/v1/tenants/:tenantId/") || policy.path.includes("*")) {
      add("invalid-product-bff-policy-path", `${policy.method} ${policy.path} is not an exact tenant policy path`);
    }
    const routeKey = `${policy.method} ${policy.path}`;
    if (routeKeys.has(routeKey)) {
      add("duplicate-product-bff-policy", `${routeKey} is declared more than once`);
    }
    routeKeys.add(routeKey);
    if (policy.capability.endsWith(":admin") && !policy.hasRoles) {
      add("missing-product-bff-policy-roles", `${routeKey} requires an explicit allowed role set for admin access`);
    }
  }

  return violations;
}

export function extractModuleSpecifiers(sourceText, filePath = "source.ts") {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const specifiers = new Set();

  function addLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addLiteral(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addLiteral(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") addLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...specifiers].sort();
}

export function detectHardcodedTenantSlugSelections(sourceText, filePath = "source.ts") {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind(filePath));
  const violations = [];

  function visit(node) {
    let text;
    if (ts.isStringLiteralLike(node)) text = node.text;
    if (ts.isTemplateExpression(node)) {
      text = `${node.head.text}${node.templateSpans.map((span) => `*${span.literal.text}`).join("")}`;
    }
    if (text && detectHardcodedTenantSlugSqlSelections(text, filePath).length > 0) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        kind: HISTORICAL_TENANT_SLUG_FINDING,
        path: filePath,
        message: `runtime tenant selection must use an explicit UUID, not a slug literal (line ${location.line + 1})`
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function normalizeSqlIdentifier(value) {
  return value.replace(/^"|"$/gu, "").replaceAll('""', '"').toLowerCase();
}

function sqlIdNode(reference) {
  const match = new RegExp(
    String.raw`^(?:(${SQL_IDENTIFIER_SOURCE})\s*\.\s*)?("(?:tenant_?id|id)"|tenant_?id|id)$`,
    "iu"
  ).exec(reference.trim());
  if (!match) return undefined;
  const alias = match[1] ? `${normalizeSqlIdentifier(match[1])}.` : "";
  return `${alias}${normalizeSqlIdentifier(match[2])}`;
}

function sqlSlugAlias(reference) {
  const match = new RegExp(String.raw`^(?:(${SQL_IDENTIFIER_SOURCE})\s*\.\s*)?(?:"slug"|slug)$`, "iu").exec(
    reference.trim()
  );
  return match?.[1] ? normalizeSqlIdentifier(match[1]) : undefined;
}

function addGraphEdge(graph, left, right) {
  if (!graph.has(left)) graph.set(left, new Set());
  if (!graph.has(right)) graph.set(right, new Set());
  graph.get(left).add(right);
  graph.get(right).add(left);
}

function uuidIdentityGraph(statement) {
  const graph = new Map();
  const operand = String.raw`(?:${SQL_ID_REFERENCE_SOURCE}|${SQL_UUID_ANCHOR_SOURCE})`;
  const equality = new RegExp(String.raw`(?=(${operand})\s*=\s*(${operand}))`, "giu");
  for (const match of statement.matchAll(equality)) {
    const left = sqlIdNode(match[1]) ?? "__uuid_anchor__";
    const right = sqlIdNode(match[2]) ?? "__uuid_anchor__";
    addGraphEdge(graph, left, right);
  }
  return graph;
}

function graphReachesUuid(graph, start) {
  const pending = [start];
  const visited = new Set();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === "__uuid_anchor__") return true;
    if (!node || visited.has(node)) continue;
    visited.add(node);
    pending.push(...(graph.get(node) ?? []));
  }
  return false;
}

function hasSameTenantUuidAssertion(statement, slugAlias) {
  if (/\bor\b/iu.test(statement.replace(/'(?:''|[^'])*'/gu, "''"))) return false;
  const graph = uuidIdentityGraph(statement);
  const candidates = slugAlias ? [`${slugAlias}.id`, `${slugAlias}.tenant_id`] : ["id", "tenant_id"];
  return candidates.some((candidate) => graphReachesUuid(graph, candidate));
}

function stripSqlComments(sourceText) {
  return sourceText
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\r\n]/gu, " "))
    .replace(/--[^\r\n]*/gu, "");
}

function normalizeTenantSlugCasts(statement) {
  return statement
    .replace(
      new RegExp(
        String.raw`cast\s*\(\s*(${SQL_SLUG_REFERENCE_SOURCE})\s+as\s+${SQL_TYPE_REFERENCE_SOURCE}\s*\)`,
        "giu"
      ),
      "$1"
    )
    .replace(new RegExp(String.raw`(${SQL_SLUG_REFERENCE_SOURCE})\s*::\s*${SQL_TYPE_REFERENCE_SOURCE}`, "giu"), "$1");
}

function tenantSlugPredicates(statement) {
  const predicates = [];
  const wrappedSlug = String.raw`(?:(?:lower|upper|trim|btrim|ltrim|rtrim)\s*\(\s*|\(\s*)*(?<slugReference>${SQL_SLUG_REFERENCE_SOURCE})(?:\s*\))*`;
  const operator = String.raw`(?<operator>is\s+(?:not\s+)?distinct\s+from\b|(?:not\s+)?in\s*\(|(?:not\s+)?i?like\b|<>|!=|<=|>=|=|<|>)`;
  const forward = new RegExp(String.raw`${wrappedSlug}\s*${operator}`, "giu");
  for (const match of statement.matchAll(forward)) {
    predicates.push({
      index: match.index,
      reference: match.groups.slugReference,
      operator: match.groups.operator.trim().toLowerCase()
    });
  }
  const reversed = new RegExp(String.raw`(?:'[^']*'|\$[1-9]\d*)\s*${operator}\s*${wrappedSlug}`, "giu");
  for (const match of statement.matchAll(reversed)) {
    predicates.push({
      index: match.index,
      reference: match.groups.slugReference,
      operator: match.groups.operator.trim().toLowerCase()
    });
  }
  return predicates.filter(
    (predicate, index) =>
      predicates.findIndex(
        (candidate) => candidate.index === predicate.index && candidate.reference === predicate.reference
      ) === index
  );
}

export function detectHardcodedTenantSlugSqlSelections(sourceText, filePath = "migration.sql") {
  const violations = [];
  for (const rawStatement of stripSqlComments(sourceText).split(/;\s*(?:\r?\n|$)/u)) {
    const statement = normalizeTenantSlugCasts(rawStatement);
    for (const predicate of tenantSlugPredicates(statement)) {
      const slugAlias = sqlSlugAlias(predicate.reference);
      if (predicate.operator === "=" && hasSameTenantUuidAssertion(statement, slugAlias)) continue;
      violations.push({
        kind: HISTORICAL_TENANT_SLUG_FINDING,
        path: normalizeRepoPath(filePath),
        message: "SQL executable must select tenant context by an opaque UUID, never by a hardcoded slug"
      });
    }
  }
  return violations;
}

function isIsoCalendarDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isExecutableRuntimeSource(filePath) {
  const normalized = normalizeRepoPath(filePath);
  return (
    !/(?:^|\/)(?:fixtures?|tests?)(?:\/|$)/iu.test(normalized) &&
    !/\.(?:integration\.)?(?:spec|test)\.[cm]?[jt]sx?$/iu.test(normalized) &&
    !/\.d\.ts$/iu.test(normalized)
  );
}

function targetPackageForSpecifier(root, packages, packagesByName, sourceFile, specifier) {
  if (specifier.startsWith(".")) {
    const targetPath = normalizeRepoPath(path.relative(root, path.resolve(path.dirname(sourceFile), specifier)));
    return packageForPath(packages, targetPath);
  }

  for (const [packageName, packageEntry] of packagesByName) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return packageEntry;
  }
  return null;
}

function migrationPolicyPath(root) {
  return path.join(root, "scripts", "architecture", "legacy-global-migrations.json");
}

function normalizeAcceptedFinding(entry, policyPath) {
  const acceptedFindings = entry.acceptedFindings ?? [];
  if (!Array.isArray(acceptedFindings)) {
    throw new Error(`${policyPath} contains invalid acceptedFindings for ${entry.name}`);
  }
  const kinds = new Set();
  return acceptedFindings.map((finding) => {
    if (
      !finding ||
      finding.kind !== HISTORICAL_TENANT_SLUG_FINDING ||
      !DEBT_ID.test(finding.debtId ?? "") ||
      !OWNER_ID.test(finding.owner ?? "") ||
      !ISSUE_ID.test(finding.issue ?? "") ||
      !isIsoCalendarDate(finding.expiresOn) ||
      !Number.isSafeInteger(finding.occurrences) ||
      finding.occurrences < 1 ||
      typeof finding.rationale !== "string" ||
      finding.rationale.trim().length < 20
    ) {
      throw new Error(`${policyPath} contains an invalid accepted finding for ${entry.name}`);
    }
    if (kinds.has(finding.kind)) {
      throw new Error(`${policyPath} contains duplicate accepted finding ${finding.kind} for ${entry.name}`);
    }
    kinds.add(finding.kind);
    return { ...finding, rationale: finding.rationale.trim() };
  });
}

async function readDefaultMigrationBaseline(root) {
  const policyPath = path.join(root, "scripts", "architecture", "legacy-global-migrations.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  if (policy.version !== 3 || policy.algorithm !== "sha256" || !Array.isArray(policy.files)) {
    throw new Error(
      `${normalizeRepoPath(path.relative(root, policyPath))} must be a version 3 sha256 migration catalog`
    );
  }
  const entries = new Map();
  for (const entry of policy.files) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !/^[0-9]{3}-[a-z0-9-]+\.sql$/u.test(entry.name) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(
        `${normalizeRepoPath(path.relative(root, policyPath))} contains an invalid migration checksum entry`
      );
    }
    if (entries.has(entry.name)) {
      throw new Error(`${normalizeRepoPath(path.relative(root, policyPath))} contains duplicate entry ${entry.name}`);
    }
    entries.set(entry.name, {
      name: entry.name,
      sha256: entry.sha256,
      acceptedFindings: normalizeAcceptedFinding(entry, normalizeRepoPath(path.relative(root, policyPath)))
    });
  }

  const hasAcceptedFindings = [...entries.values()].some((entry) => entry.acceptedFindings.length > 0);
  const debtItems = new Map();
  if (hasAcceptedFindings) {
    const debtPath = path.join(root, "docs", "catalogs", "debt.v1.json");
    const debtCatalog = JSON.parse(await readFile(debtPath, "utf8"));
    if (debtCatalog.schemaVersion !== 1 || !Array.isArray(debtCatalog.items)) {
      throw new Error(`${normalizeRepoPath(path.relative(root, debtPath))} must be a version 1 debt catalog`);
    }
    for (const debt of debtCatalog.items) {
      if (typeof debt?.id === "string") debtItems.set(debt.id, debt);
    }
  }
  return { entries, debtItems };
}

function migrationBaseline(input) {
  if (input?.entries instanceof Map && input?.debtItems instanceof Map) return input;
  if (input instanceof Map) {
    return {
      entries: new Map(
        [...input].map(([name, value]) => [
          name,
          typeof value === "string"
            ? { name, sha256: value, acceptedFindings: [] }
            : { ...value, name, acceptedFindings: value.acceptedFindings ?? [] }
        ])
      ),
      debtItems: new Map()
    };
  }
  if (!Array.isArray(input)) {
    throw new Error("legacyGlobalMigrations must be a migration policy, Map or checksum entry array");
  }
  return {
    entries: new Map(input.map((entry) => [entry.name, { ...entry, acceptedFindings: entry.acceptedFindings ?? [] }])),
    debtItems: new Map()
  };
}

function currentDate(value = new Date()) {
  if (typeof value === "string") {
    if (!isIsoCalendarDate(value)) throw new Error("now must be a valid ISO calendar date");
    return value;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error("now must be a Date or ISO date");
  return parsed.toISOString().slice(0, 10);
}

function historicalTenantSlugExceptionProblems(root, migrationPath, entry, policy, today, observedOccurrences) {
  const accepted = entry.acceptedFindings.find((finding) => finding.kind === HISTORICAL_TENANT_SLUG_FINDING);
  if (!accepted) return ["no exact historical exception is declared"];
  const debt = policy.debtItems.get(accepted.debtId);
  const relativePolicyPath = normalizeRepoPath(path.relative(root, migrationPolicyPath(root)));
  const problems = [];
  if (!debt) {
    problems.push(`debt ${accepted.debtId} is missing`);
  } else {
    if (debt.source !== "transition-inventory") problems.push(`debt ${accepted.debtId} is not transition-inventory`);
    if (debt.status !== "retiring") problems.push(`debt ${accepted.debtId} is not retiring`);
    if (debt.owner !== accepted.owner) problems.push(`owner differs from debt ${accepted.debtId}`);
    if (debt.issue !== accepted.issue) problems.push(`issue differs from debt ${accepted.debtId}`);
    if (debt.dueDate !== accepted.expiresOn) problems.push(`expiration differs from debt ${accepted.debtId}`);
    const evidence = new Set(Array.isArray(debt.evidence) ? debt.evidence.map(normalizeRepoPath) : []);
    if (!evidence.has(migrationPath)) problems.push(`debt ${accepted.debtId} does not evidence ${migrationPath}`);
    if (!evidence.has(relativePolicyPath))
      problems.push(`debt ${accepted.debtId} does not evidence ${relativePolicyPath}`);
  }
  if (accepted.occurrences !== observedOccurrences) {
    problems.push(`exception declares ${accepted.occurrences} occurrence(s), detected ${observedOccurrences}`);
  }
  if (accepted.expiresOn < today) problems.push(`exception expired on ${accepted.expiresOn}`);
  return problems;
}

export async function detectFederationViolations(root, options = {}) {
  const violations = [];
  const scannedSqlPaths = new Set();
  const packages = await discoverPackages(root);
  const packagesByName = new Map(packages.filter((entry) => entry.name).map((entry) => [entry.name, entry]));

  for (const packageEntry of packages) {
    if (!packageEntry.name) {
      violations.push({
        kind: "unnamed-package",
        path: `${packageEntry.directory}/package.json`,
        message: "workspace packages must declare a stable name"
      });
      continue;
    }
    if (!packageEntry.cell) {
      violations.push({
        kind: "unclassified-package",
        path: `${packageEntry.directory}/package.json`,
        message: "package must be assigned to platform, nova, lumen or pulso"
      });
      continue;
    }

    for (const dependencyName of packageEntry.dependencyNames) {
      if (dependencyName === LEGACY_GLOBAL_CONTRACTS && !LEGACY_GLOBAL_CONTRACT_CONSUMERS.has(packageEntry.name)) {
        violations.push({
          kind: "legacy-global-contract-dependency",
          path: `${packageEntry.directory}/package.json`,
          message: `${packageEntry.name} must consume provider-owned contracts; @hyperion/contracts is retired (DEBT-021)`
        });
      }
      const targetPackage = packagesByName.get(dependencyName);
      if (!targetPackage?.cell || dependencyCellAllowed(packageEntry.cell, targetPackage.cell)) continue;
      violations.push({
        kind: "cross-cell-dependency",
        path: `${packageEntry.directory}/package.json`,
        message: `${packageEntry.name} (${packageEntry.cell}) cannot depend on ${dependencyName} (${targetPackage.cell})`
      });
    }
  }

  for (const packageEntry of packages) {
    if (!packageEntry.cell) continue;
    const sourceFiles = await walk(packageEntry.absoluteDirectory, (filePath) =>
      SOURCE_EXTENSIONS.has(path.extname(filePath))
    );
    for (const sourceFile of sourceFiles) {
      const sourceText = await readFile(sourceFile, "utf8");
      const relativeSourcePath = normalizeRepoPath(path.relative(root, sourceFile));
      if (isExecutableRuntimeSource(relativeSourcePath)) {
        violations.push(...detectHardcodedTenantSlugSelections(sourceText, relativeSourcePath));
      }
      for (const specifier of extractModuleSpecifiers(sourceText, sourceFile)) {
        if (
          (specifier === LEGACY_GLOBAL_CONTRACTS || specifier.startsWith(`${LEGACY_GLOBAL_CONTRACTS}/`)) &&
          !LEGACY_GLOBAL_CONTRACT_CONSUMERS.has(packageEntry.name)
        ) {
          violations.push({
            kind: "legacy-global-contract-import",
            path: relativeSourcePath,
            message: `${packageEntry.name} must import its provider-owned contract package; @hyperion/contracts is retired (DEBT-021)`
          });
        }
        const targetPackage = targetPackageForSpecifier(root, packages, packagesByName, sourceFile, specifier);
        if (!targetPackage?.cell || targetPackage === packageEntry) continue;
        if (dependencyCellAllowed(packageEntry.cell, targetPackage.cell)) continue;
        violations.push({
          kind: "cross-cell-import",
          path: relativeSourcePath,
          message: `${packageEntry.cell} source imports ${targetPackage.cell} module ${specifier}`
        });
      }
    }

    const sqlFiles = await walk(packageEntry.absoluteDirectory, (filePath) => filePath.endsWith(".sql"));
    for (const sqlFile of sqlFiles) {
      const relativeSqlPath = normalizeRepoPath(path.relative(root, sqlFile));
      if (relativeSqlPath.startsWith("packages/migrations/sql/")) continue;
      scannedSqlPaths.add(relativeSqlPath);
      violations.push(...detectHardcodedTenantSlugSqlSelections(await readFile(sqlFile, "utf8"), relativeSqlPath));
    }
  }

  for (const sqlFile of await walk(root, (filePath) => filePath.endsWith(".sql"))) {
    const relativeSqlPath = normalizeRepoPath(path.relative(root, sqlFile));
    if (
      relativeSqlPath.startsWith("packages/migrations/sql/") ||
      relativeSqlPath.startsWith("tmp/") ||
      scannedSqlPaths.has(relativeSqlPath) ||
      !isExecutableRuntimeSource(relativeSqlPath)
    ) {
      continue;
    }
    violations.push(...detectHardcodedTenantSlugSqlSelections(await readFile(sqlFile, "utf8"), relativeSqlPath));
  }

  const legacyGlobalMigrationPolicy = migrationBaseline(
    options.legacyGlobalMigrations ?? (await readDefaultMigrationBaseline(root))
  );
  const legacyGlobalMigrations = legacyGlobalMigrationPolicy.entries;
  const today = currentDate(options.now);
  const globalMigrationRoot = path.join(root, "packages", "migrations", "sql");
  const observedGlobalMigrations = new Set();
  for (const migrationPath of await walk(globalMigrationRoot, (filePath) => filePath.endsWith(".sql"))) {
    const migrationName = normalizeRepoPath(path.relative(globalMigrationRoot, migrationPath));
    const relativeMigrationPath = normalizeRepoPath(path.relative(root, migrationPath));
    observedGlobalMigrations.add(migrationName);
    const expectedEntry = legacyGlobalMigrations.get(migrationName);
    const migrationBytes = await readFile(migrationPath);
    const tenantSlugFindings = detectHardcodedTenantSlugSqlSelections(
      migrationBytes.toString("utf8"),
      relativeMigrationPath
    );
    if (!expectedEntry) {
      violations.push({
        kind: "new-global-migration",
        path: relativeMigrationPath,
        message: "new SQL must live in a cell-owned migrator; packages/migrations/sql is frozen legacy debt"
      });
      violations.push(...tenantSlugFindings);
      continue;
    }
    const actualChecksum = createHash("sha256").update(migrationBytes).digest("hex");
    if (actualChecksum !== expectedEntry.sha256) {
      violations.push({
        kind: "global-migration-drift",
        path: relativeMigrationPath,
        message: `frozen migration checksum changed: expected ${expectedEntry.sha256}, received ${actualChecksum}`
      });
      violations.push(...tenantSlugFindings);
      continue;
    }

    const acceptedTenantSlugFinding = expectedEntry.acceptedFindings.find(
      (finding) => finding.kind === HISTORICAL_TENANT_SLUG_FINDING
    );
    if (tenantSlugFindings.length > 0) {
      const exceptionProblems = historicalTenantSlugExceptionProblems(
        root,
        relativeMigrationPath,
        expectedEntry,
        legacyGlobalMigrationPolicy,
        today,
        tenantSlugFindings.length
      );
      if (exceptionProblems.length > 0) {
        violations.push({
          kind: "invalid-historical-tenant-slug-exception",
          path: relativeMigrationPath,
          message: exceptionProblems.join("; ")
        });
        violations.push(...tenantSlugFindings);
      }
    } else if (acceptedTenantSlugFinding) {
      violations.push({
        kind: "unused-historical-tenant-slug-exception",
        path: relativeMigrationPath,
        message: `${acceptedTenantSlugFinding.debtId} no longer corresponds to a detected tenant slug selector`
      });
    }
  }
  for (const migrationName of legacyGlobalMigrations.keys()) {
    if (observedGlobalMigrations.has(migrationName)) continue;
    violations.push({
      kind: "missing-global-migration",
      path: normalizeRepoPath(path.join("packages", "migrations", "sql", migrationName)),
      message: "frozen historical migration is missing; remove it only through an explicit extraction migration"
    });
  }

  for (const dockerfile of await walk(root, (filePath) => /dockerfile/i.test(path.basename(filePath)))) {
    const contents = (await readFile(dockerfile, "utf8")).replace(/\\\r?\n/g, " ");
    if (!GLOBAL_BUILD_PATTERNS.some((pattern) => pattern.test(contents))) continue;
    violations.push({
      kind: "recursive-docker-build",
      path: normalizeRepoPath(path.relative(root, dockerfile)),
      message: "Docker builds must compile only the selected component dependency closure; pnpm -r build is forbidden"
    });
  }

  for (const productBff of PRODUCT_BFF_POLICIES) {
    const absolutePath = path.join(root, productBff.path);
    let sourceText;
    try {
      sourceText = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const policySource of productBff.policySources ?? []) {
      try {
        sourceText += `\n${await readFile(path.join(root, policySource), "utf8")}`;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    violations.push(
      ...detectProductBffPolicyViolations(sourceText, productBff.path, productBff.exportName, {
        exportName: productBff.publicExportName,
        allowedNamespaces: productBff.allowedPublicNamespaces
      })
    );
  }

  return violations.sort((left, right) =>
    `${left.kind}|${left.path}|${left.message}`.localeCompare(`${right.kind}|${right.path}|${right.message}`)
  );
}

async function main() {
  const violations = await detectFederationViolations(process.cwd());
  if (violations.length === 0) {
    process.stdout.write("Federation boundaries OK: cells, migrations and Docker builds are isolated.\n");
    return;
  }

  process.stderr.write("Federation boundary check failed:\n");
  for (const violation of violations) {
    process.stderr.write(`- [${violation.kind}] ${violation.path}: ${violation.message}\n`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
