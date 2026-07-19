import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const ANY_METHOD = "*";

const contracts = [
  {
    name: "NOVA",
    consoleRoot: "apps/nova-console/src",
    bffSource: "apps/nova-bff/src/app.ts",
    helpers: { novaPath: "nova", voicePath: "voice" },
    dynamicComponents: [],
    publicPolicyExport: "NOVA_BFF_PUBLIC_ROUTE_POLICIES",
    exactPolicy: {
      source: "packages/nova-contracts/src/bff-route-policies.ts",
      exportName: "NOVA_BFF_TENANT_ROUTE_POLICIES",
      method: "POST",
      path: "/v1/tenants/:tenantId/nova/lab/liwa-event",
      upstream: "nova"
    }
  },
  {
    name: "LUMEN",
    consoleRoot: "apps/lumen-console/src",
    bffSource: "apps/lumen-bff/src/app.ts",
    helpers: { lumenPath: "lumen" },
    dynamicComponents: [],
    publicPolicySource: "packages/lumen-contracts/src/bff-route-policies.ts",
    publicPolicyExport: "LUMEN_BFF_PUBLIC_ROUTE_POLICIES",
    tenantPolicy: {
      source: "packages/lumen-contracts/src/bff-route-policies.ts",
      exportName: "LUMEN_BFF_TENANT_ROUTE_POLICIES"
    },
    exactPolicy: {
      source: "packages/lumen-contracts/src/bff-route-policies.ts",
      exportName: "LUMEN_BFF_EXACT_ROUTE_POLICIES",
      method: "GET",
      path: "/v1/lumen/health",
      upstream: "lumen"
    }
  },
  {
    name: "PULSO",
    consoleRoot: "apps/pulso-console/src",
    bffSource: "apps/pulso-bff/src/app.ts",
    helpers: { tenantPath: "pulso-iris" },
    dynamicComponents: [],
    publicPolicyExport: "PULSO_BFF_PUBLIC_ROUTE_POLICIES",
    exactPolicy: {
      source: "packages/pulso-contracts/src/bff-route-policies.ts",
      exportName: "PULSO_BFF_TENANT_ROUTE_POLICIES",
      method: "GET",
      path: "/v1/tenants/:tenantId/pulso-iris/sofia/readiness",
      upstream: "integration"
    }
  },
  {
    name: "PLATFORM_ADMIN",
    consoleRoot: "apps/platform-admin-console/src",
    bffSource: "apps/platform-admin-bff/src/app.ts",
    helpers: {},
    dynamicComponents: [],
    publicPolicyExport: "PLATFORM_ADMIN_ROUTE_INVENTORY"
  }
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory)) {
    const target = join(directory, entry);
    if ((await stat(target)).isDirectory()) files.push(...(await walk(target)));
    else if (/\.(?:ts|tsx)$/.test(entry) && !/\.(?:test|spec)\.[^.]+$/.test(entry)) files.push(target);
  }
  return files;
}

function sourceFile(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function unwrap(node) {
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

function staticTextVariants(node, placeholder = "*", seen = new Set()) {
  const value = unwrap(node);
  if (!value) return [];
  if (ts.isStringLiteralLike(value)) return [value.text];
  if (ts.isTemplateExpression(value)) {
    return [`${value.head.text}${value.templateSpans.map((span) => `${placeholder}${span.literal.text}`).join("")}`];
  }
  if (ts.isConditionalExpression(value)) {
    return [
      ...staticTextVariants(value.whenTrue, placeholder, seen),
      ...staticTextVariants(value.whenFalse, placeholder, seen)
    ];
  }
  if (ts.isIdentifier(value) && !seen.has(value.text)) {
    let initializer;
    let position = -1;
    function visit(candidate) {
      if (
        ts.isVariableDeclaration(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === value.text &&
        candidate.getStart() < value.getStart() &&
        candidate.getStart() > position
      ) {
        initializer = candidate.initializer;
        position = candidate.getStart();
      }
      ts.forEachChild(candidate, visit);
    }
    visit(value.getSourceFile());
    if (initializer) return staticTextVariants(initializer, placeholder, new Set([...seen, value.text]));
  }
  return [];
}

function staticText(node, placeholder = "*") {
  return staticTextVariants(node, placeholder)[0];
}

function resolveObjectExpression(node, seen = new Set()) {
  const value = unwrap(node);
  if (!value) return undefined;
  const key = `${value.pos}:${value.end}`;
  if (seen.has(key)) return undefined;
  const nextSeen = new Set([...seen, key]);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.expression.getText() === "Object" &&
    value.expression.name.text === "freeze"
  ) {
    return resolveObjectExpression(value.arguments[0], nextSeen);
  }
  if (ts.isIdentifier(value)) {
    let initializer;
    let position = -1;
    function visit(candidate) {
      if (
        ts.isVariableDeclaration(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === value.text &&
        candidate.getStart() < value.getStart() &&
        candidate.getStart() > position
      ) {
        initializer = candidate.initializer;
        position = candidate.getStart();
      }
      ts.forEachChild(candidate, visit);
    }
    visit(value.getSourceFile());
    return initializer ? resolveObjectExpression(initializer, nextSeen) : undefined;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const parent = resolveObjectExpression(value.expression, nextSeen);
    if (!parent) return undefined;
    for (const property of [...parent.properties].reverse()) {
      if (ts.isPropertyAssignment(property) && property.name.getText().replaceAll(/["']/g, "") === value.name.text) {
        return resolveObjectExpression(property.initializer, nextSeen);
      }
    }
  }
  return undefined;
}

function propertyValue(object, name, seen = new Set()) {
  const key = `${object.pos}:${object.end}:${name}`;
  if (seen.has(key)) return undefined;
  const nextSeen = new Set([...seen, key]);
  for (const property of [...object.properties].reverse()) {
    if (ts.isPropertyAssignment(property) && property.name.getText().replaceAll(/["']/g, "") === name) {
      return staticText(property.initializer);
    }
    if (ts.isSpreadAssignment(property)) {
      const spread = resolveObjectExpression(property.expression);
      if (!spread) continue;
      const inherited = propertyValue(spread, name, nextSeen);
      if (inherited !== undefined) return inherited;
    }
  }
  return undefined;
}

function extractPolicies(file, source, exportName, requireUpstream = true) {
  const ast = sourceFile(file, source);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === exportName) {
      initializer = unwrap(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const policies = [];
  function collect(node) {
    const value = unwrap(node);
    if (ts.isCallExpression(value)) {
      if (
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.expression.getText() === "Object" &&
        value.expression.name.text === "freeze"
      ) {
        collect(value.arguments[0]);
        return;
      }
      if (!ts.isIdentifier(value.expression)) return;
      const helper = value.expression.text;
      const method = staticText(value.arguments[0])?.toUpperCase();
      let component;
      let suffix;
      let upstream;
      let capability;
      if (helper === "novaTenantRoute") {
        component = staticText(value.arguments[1]);
        suffix = staticText(value.arguments[2]);
        upstream = component;
        capability = staticText(value.arguments[3]);
      } else if (helper === "pulsoCoreRoute") {
        component = "pulso-iris";
        suffix = staticText(value.arguments[1]);
        upstream = "core";
        capability = staticText(value.arguments[2]);
      } else if (helper === "pulsoIntegrationRoute") {
        component = "integrations";
        suffix = staticText(value.arguments[1]);
        upstream = "integration";
        capability = staticText(value.arguments[2]);
      } else if (helper === "pulsoTenantRoute") {
        component = staticText(value.arguments[1]);
        suffix = staticText(value.arguments[2]);
        upstream = staticText(value.arguments[3]);
        capability = staticText(value.arguments[4]);
      }
      if (method && component && suffix && upstream && capability) {
        policies.push({
          method,
          path: `/v1/tenants/:tenantId/${component}/${suffix}`,
          upstream,
          capability
        });
      }
      return;
    }
    if (ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) collect(element);
      return;
    }
    if (!ts.isObjectLiteralExpression(value)) return;
    const policy = {
      method: propertyValue(value, "method")?.toUpperCase(),
      path: propertyValue(value, "path"),
      upstream: propertyValue(value, "upstream"),
      capability: propertyValue(value, "capability")
    };
    if (policy.method && policy.path && (!requireUpstream || policy.upstream)) {
      policies.push(policy);
      return;
    }
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property)) collect(property.initializer);
    }
  }
  if (initializer) collect(initializer);
  return policies;
}

function readFastifyRoutes(file, source) {
  const ast = sourceFile(file, source);
  const routes = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text.toUpperCase();
      if (["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"].includes(methodName)) {
        const path = staticText(node.arguments[0]);
        if (path?.startsWith("/v1/")) routes.push({ method: methodName, path: stripQuery(path) });
      } else if (methodName === "ROUTE") {
        const options = unwrap(node.arguments[0]);
        if (options && ts.isObjectLiteralExpression(options)) {
          const path = propertyValue(options, "url");
          if (path?.startsWith("/v1/") && !path.includes("*component*")) {
            routes.push({ method: ANY_METHOD, path: stripQuery(path) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return routes;
}

const apiMethods = new Map([
  ["get", "GET"],
  ["text", "GET"],
  ["post", "POST"],
  ["form", "POST"],
  ["patch", "PATCH"],
  ["put", "PUT"],
  ["delete", "DELETE"]
]);

function helperRoutes(call, helpers) {
  if (!ts.isIdentifier(call.expression)) return [];
  const component = helpers[call.expression.text];
  if (!component) return [];
  const suffixes = staticTextVariants(call.arguments[1]);
  return (suffixes.length > 0 ? suffixes : ["*"]).map((suffix) =>
    stripQuery(`/v1/tenants/:tenantId/${component}/${suffix}`)
  );
}

function routesFromExpression(expression, helpers) {
  const values = staticTextVariants(expression)
    .filter((value) => value.startsWith("/v1/"))
    .map(stripQuery);
  if (values.length > 0) return values;
  const unwrapped = unwrap(expression);
  return unwrapped && ts.isCallExpression(unwrapped) ? helperRoutes(unwrapped, helpers) : [];
}

function inferredHelperMethod(call) {
  let current = call.parent;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    if (ts.isPropertyAccessExpression(current.expression) && current.expression.expression.getText() === "api") {
      return apiMethods.get(current.expression.name.text) ?? ANY_METHOD;
    }
    if (ts.isIdentifier(current.expression) && ["usePolling", "useResource"].includes(current.expression.text)) {
      return "GET";
    }
  }
  return ANY_METHOD;
}

function readConsoleRoutes(file, source, helpers) {
  const ast = sourceFile(file, source);
  const routes = [];
  function add(method, path, node) {
    if (!path) return;
    routes.push({
      method,
      path,
      source: `${relative(repositoryRoot, file).replaceAll("\\", "/")}:${lineOf(ast, node)}`
    });
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      for (const helper of helperRoutes(node, helpers)) add(inferredHelperMethod(node), helper, node);

      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === "api") {
        const method = apiMethods.get(node.expression.name.text);
        if (method) for (const route of routesFromExpression(node.arguments[0], helpers)) add(method, route, node);
      } else if (ts.isIdentifier(node.expression) && ["usePolling", "useResource"].includes(node.expression.text)) {
        for (const route of routesFromExpression(node.arguments[0], helpers)) add("GET", route, node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return routes;
}

function lineOf(ast, node) {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}

function stripQuery(path) {
  return path.split("?", 1)[0].replace(/\/$/, "") || "/";
}

function routeRegex(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "*") {
      expression += ".*";
      continue;
    }
    if (pattern[index] === ":") {
      while (index + 1 < pattern.length && /[A-Za-z0-9_]/.test(pattern[index + 1])) index += 1;
      expression += "[^/]+";
      continue;
    }
    expression += pattern[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

function isAllowed(consumed, allowed) {
  return allowed.some(
    (route) =>
      (route.method === ANY_METHOD || consumed.method === ANY_METHOD || route.method === consumed.method) &&
      routeRegex(route.path).test(consumed.path)
  );
}

const violations = [];
for (const contract of contracts) {
  const bffPath = join(repositoryRoot, contract.bffSource);
  const bffSource = await readFile(bffPath, "utf8");
  const allowed = readFastifyRoutes(bffPath, bffSource);

  async function policySource(relativePath) {
    const file = join(repositoryRoot, relativePath ?? contract.bffSource);
    return { file, source: file === bffPath ? bffSource : await readFile(file, "utf8") };
  }

  if (contract.dynamicComponents.length > 0) {
    if (!contract.dynamicMarker?.test(bffSource)) {
      violations.push(`${contract.name}: BFF tenant wildcard is not tied to its provider component allowlist`);
    } else {
      for (const component of contract.dynamicComponents) {
        allowed.push({ method: ANY_METHOD, path: `/v1/tenants/:tenantId/${component}` });
        allowed.push({ method: ANY_METHOD, path: `/v1/tenants/:tenantId/${component}/*` });
      }
    }
  }

  if (contract.publicPolicyExport) {
    const publicOwner = await policySource(contract.publicPolicySource);
    const publicPolicies = extractPolicies(publicOwner.file, publicOwner.source, contract.publicPolicyExport, false);
    allowed.push(...publicPolicies.map(({ method, path }) => ({ method, path })));
    if (publicPolicies.length === 0) {
      violations.push(`${contract.name}: ${contract.publicPolicyExport} does not expose any static BFF routes`);
    }
    const references = bffSource.match(new RegExp(`\\b${contract.publicPolicyExport}\\b`, "g"))?.length ?? 0;
    if (references < 2) violations.push(`${contract.name}: ${contract.publicPolicyExport} is declared but not used`);
  }

  if (contract.tenantPolicy) {
    const tenantOwner = await policySource(contract.tenantPolicy.source);
    const tenantPolicies = extractPolicies(tenantOwner.file, tenantOwner.source, contract.tenantPolicy.exportName);
    allowed.push(...tenantPolicies.map(({ method, path }) => ({ method, path })));
    if (tenantPolicies.length === 0) {
      violations.push(
        `${contract.name}: ${contract.tenantPolicy.exportName} does not expose any provider-owned BFF routes`
      );
    }
    const references = bffSource.match(new RegExp(`\\b${contract.tenantPolicy.exportName}\\b`, "g"))?.length ?? 0;
    if (references < 2) {
      violations.push(`${contract.name}: ${contract.tenantPolicy.exportName} is declared but not registered`);
    }
  }

  if (contract.exactPolicy) {
    const exactOwner = await policySource(contract.exactPolicy.source);
    const policies = extractPolicies(exactOwner.file, exactOwner.source, contract.exactPolicy.exportName);
    allowed.push(...policies.map(({ method, path }) => ({ method, path })));
    const required = contract.exactPolicy;
    if (
      !policies.some(
        (policy) =>
          policy.method === required.method && policy.path === required.path && policy.upstream === required.upstream
      )
    ) {
      violations.push(
        `${contract.name}: ${required.method} ${required.path} must have exact BFF policy upstream=${required.upstream}`
      );
    }
    const references = bffSource.match(new RegExp(`\\b${required.exportName}\\b`, "g"))?.length ?? 0;
    if (references < 2) violations.push(`${contract.name}: ${required.exportName} is declared but not registered`);
  }

  const consoleFiles = await walk(join(repositoryRoot, contract.consoleRoot));
  const consumed = [];
  for (const file of consoleFiles)
    consumed.push(...readConsoleRoutes(file, await readFile(file, "utf8"), contract.helpers));
  const unique = [...new Map(consumed.map((route) => [`${route.method} ${route.path}`, route])).values()];
  for (const route of unique) {
    if (!isAllowed(route, allowed)) {
      violations.push(
        `${contract.name}: console consumes ${route.method} ${route.path} at ${route.source}, absent from BFF allowlist`
      );
    }
  }
  if (contract.exactPolicy && !unique.some((route) => route.path === contract.exactPolicy.path)) {
    violations.push(
      `${contract.name}: expected regression route ${contract.exactPolicy.path} is no longer exercised by console`
    );
  }
}

if (violations.length > 0) {
  console.error(`Console/BFF route contract failed (${violations.length}):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Console/BFF route contract OK (${contracts.length} consoles checked)`);
}
