import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectFederationViolations,
  detectHardcodedTenantSlugSelections,
  detectHardcodedTenantSlugSqlSelections,
  detectProductBffPolicyViolations,
  extractModuleSpecifiers
} from "./check-federation-boundaries.mjs";

async function packageAt(root, directory, name, dependencies = {}) {
  await mkdir(path.join(root, directory, "src"), { recursive: true });
  await writeFile(path.join(root, directory, "package.json"), JSON.stringify({ name, dependencies }), "utf8");
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-federation-"));
  await mkdir(path.join(root, "scripts", "architecture"), { recursive: true });
  await writeFile(
    path.join(root, "scripts", "architecture", "legacy-global-migrations.json"),
    JSON.stringify({
      version: 3,
      algorithm: "sha256",
      files: [
        {
          name: "001-legacy.sql",
          sha256: "354b7196c9ba5fb4b21cf615bb6ec4cd5c07503c34229feef033fc081a8c03f4"
        }
      ]
    }),
    "utf8"
  );
  await packageAt(root, "packages/contracts", "@hyperion/contracts");
  await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service", {
    "@hyperion/contracts": "workspace:*"
  });
  await packageAt(root, "services/lumen-service", "@hyperion/lumen-service");
  await mkdir(path.join(root, "packages", "migrations", "sql"), { recursive: true });
  await writeFile(path.join(root, "packages", "migrations", "sql", "001-legacy.sql"), "select 1;", "utf8");
  return root;
}

async function configureHistoricalSlugDebt(
  root,
  { expiresOn = "2027-03-31", debtOwner = "platform-data", debtIssue = "HYP-DEBT-022", occurrences = 1 } = {}
) {
  const sql = "select id from platform.tenants where slug = 'historical-customer';";
  const sha256 = createHash("sha256").update(sql).digest("hex");
  await writeFile(path.join(root, "packages", "migrations", "sql", "001-legacy.sql"), sql, "utf8");
  await writeFile(
    path.join(root, "scripts", "architecture", "legacy-global-migrations.json"),
    JSON.stringify({
      version: 3,
      algorithm: "sha256",
      files: [
        {
          name: "001-legacy.sql",
          sha256,
          acceptedFindings: [
            {
              kind: "hardcoded-tenant-slug-selection",
              debtId: "DEBT-022",
              owner: "platform-data",
              issue: "HYP-DEBT-022",
              expiresOn,
              occurrences,
              rationale: "Live legacy customer seed retained only until the global migrator is retired."
            }
          ]
        }
      ]
    }),
    "utf8"
  );
  await mkdir(path.join(root, "docs", "catalogs"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "catalogs", "debt.v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id: "DEBT-022",
          source: "transition-inventory",
          owner: debtOwner,
          status: "retiring",
          issue: debtIssue,
          dueDate: expiresOn,
          evidence: ["packages/migrations/sql/001-legacy.sql", "scripts/architecture/legacy-global-migrations.json"]
        }
      ]
    }),
    "utf8"
  );
}

test("extracts static, dynamic, require and re-export module edges", () => {
  assert.deepEqual(
    extractModuleSpecifiers(`
      import "a";
      export { value } from "b";
      const c = import("c");
      const d = require("d");
    `),
    ["a", "b", "c", "d"]
  );
});

test("rejects runtime tenant selection by a hardcoded slug literal", () => {
  assert.deepEqual(
    detectHardcodedTenantSlugSelections(
      `await client.query("select id from platform.tenants where tenant.slug = 'customer-a'")`,
      "packages/tool/src/seed.ts"
    ).map((entry) => entry.kind),
    ["hardcoded-tenant-slug-selection"]
  );
  assert.deepEqual(
    detectHardcodedTenantSlugSelections(
      `await client.query("select id from platform.tenants where tenant.id = $1::uuid", [tenantId])`,
      "packages/tool/src/seed.ts"
    ),
    []
  );
});

test("rejects new SQL tenant selectors by slug but allows an exact UUID predicate", () => {
  for (const sql of [
    "select id from platform.tenants t where t.slug = 'customer-a';",
    "select id from platform.tenants t where (t.slug = 'customer-a');",
    `select id from platform.tenants t where t."slug" = 'customer-a';`,
    "select id from platform.tenants t where lower(t.slug) = 'customer-a';",
    "select id from platform.tenants t where upper(trim(t.slug)) = 'CUSTOMER-A';",
    "select id from platform.tenants t where btrim(t.slug) = 'customer-a';",
    "select id from platform.tenants t where t.slug::text <> 'customer-a';",
    "select id from platform.tenants t where cast(t.slug as varchar(64)) != 'customer-a';",
    "select id from platform.tenants t where t.slug in ('customer-a');",
    "select id from platform.tenants t where 'customer-a' = t.slug;",
    "select id from platform.tenants t where 'customer-a' <> rtrim(t.slug);",
    "select t.id from platform.tenants t join audit.events unrelated on true where t.slug = 'customer-a' and unrelated.id = $1::uuid;"
  ]) {
    assert.deepEqual(
      detectHardcodedTenantSlugSqlSelections(sql, "packages/lumen-migrations/sql/002.sql").map((entry) => entry.kind),
      ["hardcoded-tenant-slug-selection"],
      sql
    );
  }
  assert.deepEqual(
    detectHardcodedTenantSlugSqlSelections(
      "select id from platform.tenants t where t.id = $1::uuid and t.slug = 'consistency-check';",
      "packages/lumen-migrations/sql/002.sql"
    ),
    []
  );
  assert.deepEqual(
    detectHardcodedTenantSlugSqlSelections(
      "select id from platform.tenants t where t.id = $1::uuid and cast(t.slug as text) = 'consistency-check';",
      "packages/lumen-migrations/sql/002.sql"
    ),
    []
  );
  assert.deepEqual(
    detectHardcodedTenantSlugSqlSelections(
      `-- where t.slug = 'comment-only'
       select id from platform.tenants t where t.id = $1::uuid;`,
      "packages/lumen-migrations/sql/002.sql"
    ),
    []
  );
});

test("wires hardcoded tenant slug detection into the repository federation gate", async () => {
  const root = await fixture();
  try {
    const runtimePath = path.join(root, "services", "lumen-service", "src", "tenant-context.ts");
    await writeFile(
      runtimePath,
      `export async function tenant(client) {
        return client.query("select id from platform.tenants where slug = 'customer-a'");
      }`,
      "utf8"
    );

    let violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "hardcoded-tenant-slug-selection").length, 1);

    await writeFile(
      runtimePath,
      `export async function tenant(client, tenantId) {
        return client.query("select id from platform.tenants where id = $1::uuid", [tenantId]);
      }`,
      "utf8"
    );
    violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "hardcoded-tenant-slug-selection").length, 0);

    const sqlPath = path.join(root, "services", "lumen-service", "sql", "tenant-context.sql");
    await mkdir(path.dirname(sqlPath), { recursive: true });
    await writeFile(sqlPath, "select id from platform.tenants where slug = 'customer-a';", "utf8");
    violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "hardcoded-tenant-slug-selection").length, 1);

    await writeFile(sqlPath, "select id from platform.tenants where id = $1::uuid;", "utf8");
    violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "hardcoded-tenant-slug-selection").length, 0);

    const operationalSqlPath = path.join(root, "scripts", "ops", "tenant-context.sql");
    await mkdir(path.dirname(operationalSqlPath), { recursive: true });
    await writeFile(operationalSqlPath, "select id from platform.tenants where slug = 'customer-a';", "utf8");
    violations = await detectFederationViolations(root);
    assert.deepEqual(
      violations.filter((entry) => entry.kind === "hardcoded-tenant-slug-selection").map((entry) => entry.path),
      ["scripts/ops/tenant-context.sql"]
    );

    await writeFile(
      operationalSqlPath,
      "select id from platform.tenants where id = $1::uuid and slug = 'consistency-check';",
      "utf8"
    );
    const scratchSqlPath = path.join(root, "tmp", "tenant-context.sql");
    await mkdir(path.dirname(scratchSqlPath), { recursive: true });
    await writeFile(scratchSqlPath, "select id from platform.tenants where slug = 'local-scratch';", "utf8");
    violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "hardcoded-tenant-slug-selection").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects open product BFF namespaces, .all() and method arrays", () => {
  const source = `
    export const NOVA_BFF_TENANT_ROUTE_POLICIES = [{
      method: "GET",
      path: "/v1/tenants/:tenantId/nova/contacts",
      capability: "nova:read"
    }];
    app.all("/v1/tenants/:tenantId/nova/*", handler);
    app.route({ method: ["GET", "POST"], url: "/v1/tenants/:tenantId/nova/records", handler });
    app.route({ method: "*", url: "/v1/tenants/:tenantId/nova/other", handler });
  `;
  const violations = detectProductBffPolicyViolations(
    source,
    "apps/nova-bff/src/app.ts",
    "NOVA_BFF_TENANT_ROUTE_POLICIES"
  );
  const kinds = new Set(violations.map((entry) => entry.kind));
  assert.equal(kinds.has("open-product-bff-all"), true);
  assert.equal(kinds.has("open-product-bff-wildcard"), true);
  assert.equal(kinds.has("open-product-bff-method-set"), true);
});

test("requires complete, unique policies and explicit roles for admin capability", () => {
  const source = `
    export const PULSO_BFF_TENANT_ROUTE_POLICIES = [
      { method: "GET", path: "/v1/tenants/:tenantId/pulso-iris/overview" },
      {
        method: "POST",
        path: "/v1/tenants/:tenantId/integrations/whatsapp/connect",
        capability: "pulso:admin"
      },
      {
        method: "POST",
        path: "/v1/tenants/:tenantId/integrations/whatsapp/connect",
        capability: "pulso:admin",
        roles: ["admin"]
      }
    ];
  `;
  const violations = detectProductBffPolicyViolations(
    source,
    "apps/pulso-bff/src/app.ts",
    "PULSO_BFF_TENANT_ROUTE_POLICIES"
  );
  const kinds = violations.map((entry) => entry.kind);
  assert.equal(kinds.includes("incomplete-product-bff-policy"), true);
  assert.equal(kinds.includes("missing-product-bff-policy-roles"), true);
  assert.equal(kinds.includes("duplicate-product-bff-policy"), true);
});

test("accepts one closed product BFF policy catalog", () => {
  const source = `
    export const LUMEN_BFF_TENANT_ROUTE_POLICIES = [
      {
        method: "GET",
        path: "/v1/tenants/:tenantId/lumen/worklist",
        capability: "lumen:read"
      },
      {
        method: "POST",
        path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/start",
        capability: "lumen:write"
      }
    ];
    for (const policy of LUMEN_BFF_TENANT_ROUTE_POLICIES) {
      app.route({ method: policy.method, url: policy.path, handler });
    }
  `;
  assert.deepEqual(
    detectProductBffPolicyViolations(source, "apps/lumen-bff/src/app.ts", "LUMEN_BFF_TENANT_ROUTE_POLICIES"),
    []
  );
});

test("accepts only registered public routes present in the cell catalog", () => {
  const source = `
    export const NOVA_BFF_PUBLIC_ROUTE_POLICIES = Object.freeze({
      login: { method: "POST", path: "/v1/auth/login" },
      tenants: { method: "GET", path: "/v1/tenants" },
      liwaWebhook: { method: "POST", path: "/v1/liwa/webhooks" }
    });
    export const NOVA_BFF_TENANT_ROUTE_POLICIES = [{
      method: "GET",
      path: "/v1/tenants/:tenantId/nova/contacts",
      capability: "nova:read"
    }];
    app.post(NOVA_BFF_PUBLIC_ROUTE_POLICIES.login.path, handler);
    app.get(NOVA_BFF_PUBLIC_ROUTE_POLICIES.tenants.path, handler);
    app.post(NOVA_BFF_PUBLIC_ROUTE_POLICIES.liwaWebhook.path, handler);
  `;
  assert.deepEqual(
    detectProductBffPolicyViolations(source, "apps/nova-bff/src/app.ts", "NOVA_BFF_TENANT_ROUTE_POLICIES", {
      exportName: "NOVA_BFF_PUBLIC_ROUTE_POLICIES",
      allowedNamespaces: ["auth", "liwa", "tenants", "voice"]
    }),
    []
  );
});

test("rejects foreign, wildcard and uncatalogued product BFF public routes", () => {
  const source = `
    export const NOVA_BFF_PUBLIC_ROUTE_POLICIES = {
      login: { method: "POST", path: "/v1/auth/login" },
      foreignHealth: { method: "GET", path: "/v1/lumen/health" }
    };
    export const NOVA_BFF_TENANT_ROUTE_POLICIES = [{
      method: "GET",
      path: "/v1/tenants/:tenantId/nova/contacts",
      capability: "nova:read"
    }];
    app.post(NOVA_BFF_PUBLIC_ROUTE_POLICIES.login.path, handler);
    app.get(NOVA_BFF_PUBLIC_ROUTE_POLICIES.foreignHealth.path, handler);
    app.get("/v1/auth/debug", handler);
    app.get("/v1/auth/*", handler);
  `;
  const violations = detectProductBffPolicyViolations(
    source,
    "apps/nova-bff/src/app.ts",
    "NOVA_BFF_TENANT_ROUTE_POLICIES",
    {
      exportName: "NOVA_BFF_PUBLIC_ROUTE_POLICIES",
      allowedNamespaces: ["auth", "liwa", "tenants", "voice"]
    }
  );
  const kinds = new Set(violations.map((entry) => entry.kind));
  assert.equal(kinds.has("foreign-product-bff-public-namespace"), true);
  assert.equal(kinds.has("open-product-bff-wildcard"), true);
  assert.equal(kinds.has("uncatalogued-product-bff-route"), true);
});

test("allows product-to-platform dependencies but rejects product-to-product dependencies", async () => {
  const root = await fixture();
  try {
    let violations = await detectFederationViolations(root);
    assert.equal(
      violations.some((entry) => entry.kind === "cross-cell-dependency"),
      false
    );

    await packageAt(root, "services/lumen-service", "@hyperion/lumen-service", {
      "@hyperion/nova-core-service": "workspace:*"
    });
    violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "cross-cell-dependency").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects provider contract dependencies from the compatibility gateway", async () => {
  const root = await fixture();
  try {
    await packageAt(root, "apps/api-gateway", "@hyperion/api-gateway", {
      "@hyperion/nova-contracts": "1.1.0"
    });
    await packageAt(root, "packages/nova-contracts", "@hyperion/nova-contracts");
    await writeFile(
      path.join(root, "apps", "api-gateway", "src", "compatibility.ts"),
      `export { NOVA_BFF_TENANT_ROUTE_POLICIES } from "@hyperion/nova-contracts";`,
      "utf8"
    );

    let violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "cross-cell-dependency").length, 1);
    assert.equal(violations.filter((entry) => entry.kind === "cross-cell-import").length, 1);

    await packageAt(root, "services/nova-core-service", "@hyperion/nova-core-service");
    await writeFile(
      path.join(root, "apps", "api-gateway", "src", "forbidden.ts"),
      `export { app } from "@hyperion/nova-core-service";`,
      "utf8"
    );
    violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "cross-cell-import").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects the closed global contract catalog outside the compatibility gateway", async () => {
  const root = await fixture();
  try {
    await packageAt(root, "apps/api-gateway", "@hyperion/api-gateway", {
      "@hyperion/contracts": "workspace:*"
    });
    await writeFile(
      path.join(root, "apps", "api-gateway", "src", "legacy.ts"),
      `export { envelope } from "@hyperion/contracts";`,
      "utf8"
    );
    await writeFile(
      path.join(root, "services", "nova-core-service", "src", "legacy.ts"),
      `export { envelope } from "@hyperion/contracts";`,
      "utf8"
    );

    const violations = await detectFederationViolations(root);
    assert.deepEqual(
      violations
        .filter((entry) => entry.kind.startsWith("legacy-global-contract"))
        .map((entry) => `${entry.kind}|${entry.path}`),
      [
        "legacy-global-contract-dependency|services/nova-core-service/package.json",
        "legacy-global-contract-import|services/nova-core-service/src/legacy.ts"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects relative imports that bypass package dependency declarations", async () => {
  const root = await fixture();
  try {
    await writeFile(
      path.join(root, "services", "lumen-service", "src", "leak.ts"),
      `export { value } from "../../nova-core-service/src/value.js";`,
      "utf8"
    );
    const violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "cross-cell-import").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("freezes the legacy global migration directory", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "packages", "migrations", "sql", "002-new.sql"), "select 2;", "utf8");
    const violations = await detectFederationViolations(root);
    assert.deepEqual(
      violations.filter((entry) => entry.kind === "new-global-migration").map((entry) => entry.path),
      ["packages/migrations/sql/002-new.sql"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects edits to and deletion of checksum-frozen global migrations", async () => {
  const root = await fixture();
  const migrationPath = path.join(root, "packages", "migrations", "sql", "001-legacy.sql");
  try {
    await writeFile(migrationPath, "select 42;", "utf8");
    let violations = await detectFederationViolations(root);
    assert.deepEqual(
      violations.filter((entry) => entry.kind === "global-migration-drift").map((entry) => entry.path),
      ["packages/migrations/sql/001-legacy.sql"]
    );

    await rm(migrationPath);
    violations = await detectFederationViolations(root);
    assert.deepEqual(
      violations.filter((entry) => entry.kind === "missing-global-migration").map((entry) => entry.path),
      ["packages/migrations/sql/001-legacy.sql"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a live legacy slug selector only while exact DEBT metadata remains valid", async () => {
  const root = await fixture();
  try {
    await configureHistoricalSlugDebt(root);
    let violations = await detectFederationViolations(root, { now: "2026-07-18" });
    assert.deepEqual(
      violations.filter((entry) => entry.kind.includes("tenant-slug")).map((entry) => entry.kind),
      []
    );

    await configureHistoricalSlugDebt(root, { expiresOn: "2026-07-17" });
    violations = await detectFederationViolations(root, { now: "2026-07-18" });
    assert.deepEqual(
      violations.filter((entry) => entry.kind.includes("tenant-slug")).map((entry) => entry.kind),
      ["hardcoded-tenant-slug-selection", "invalid-historical-tenant-slug-exception"]
    );

    await configureHistoricalSlugDebt(root, { debtOwner: "unrelated-owner" });
    violations = await detectFederationViolations(root, { now: "2026-07-18" });
    assert.deepEqual(
      violations.filter((entry) => entry.kind.includes("tenant-slug")).map((entry) => entry.kind),
      ["hardcoded-tenant-slug-selection", "invalid-historical-tenant-slug-exception"]
    );

    await configureHistoricalSlugDebt(root, { debtIssue: "HYP-DEBT-999" });
    violations = await detectFederationViolations(root, { now: "2026-07-18" });
    assert.deepEqual(
      violations.filter((entry) => entry.kind.includes("tenant-slug")).map((entry) => entry.kind),
      ["hardcoded-tenant-slug-selection", "invalid-historical-tenant-slug-exception"]
    );

    await configureHistoricalSlugDebt(root, { occurrences: 2 });
    violations = await detectFederationViolations(root, { now: "2026-07-18" });
    assert.deepEqual(
      violations.filter((entry) => entry.kind.includes("tenant-slug")).map((entry) => entry.kind),
      ["hardcoded-tenant-slug-selection", "invalid-historical-tenant-slug-exception"]
    );

    await configureHistoricalSlugDebt(root, { expiresOn: "2027-02-30" });
    await assert.rejects(detectFederationViolations(root, { now: "2026-07-18" }), /invalid accepted finding/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects recursive monorepo builds in every Dockerfile naming convention", async () => {
  const root = await fixture();
  try {
    await mkdir(path.join(root, "infra", "docker"), { recursive: true });
    await writeFile(
      path.join(root, "infra", "docker", "node-service.Dockerfile"),
      "FROM node:22\nRUN pnpm \\\n  --recursive build\n",
      "utf8"
    );
    const violations = await detectFederationViolations(root);
    assert.equal(violations.filter((entry) => entry.kind === "recursive-docker-build").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
