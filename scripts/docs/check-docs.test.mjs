import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activeRunbookReleaseProblems,
  catalogMetadataProblems,
  catalogReadmeProblems,
  debtCoverageProblems,
  documentationCiProblems,
  environmentConsumptionNames,
  environmentExampleProblems,
  environmentReferenceProblems,
  environmentRuntimeScope,
  environmentUsageProblems,
  expandRequirementExpression,
  linkProblems,
  novaTraceabilityProblems,
  productTraceabilityEvidenceProblems,
  infraEnvironmentExampleProblems,
  runbookMetadataProblems,
  serviceInventoryProblems,
  temporaryExceptionProblems,
  unsafeDocumentationProblems
} from "./check-docs.mjs";

test("enlaces locales fallan cerrado cuando el destino no existe o sale del repositorio", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-doc-links-"));
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "target.md"), "# Target\n\n## Sección válida\n", "utf8");
    assert.deepEqual(await linkProblems(root, "README.md", "[ok](docs/target.md)"), []);
    assert.deepEqual(await linkProblems(root, "README.md", "[anchor](docs/target.md#sección-válida)"), []);
    assert.deepEqual(await linkProblems(root, "README.md", "[bad anchor](docs/target.md#ausente)"), [
      "README.md: anchor local inexistente: docs/target.md#ausente"
    ]);
    assert.deepEqual(await linkProblems(root, "README.md", "[missing](docs/missing.md)"), [
      "README.md: enlace local inexistente: docs/missing.md"
    ]);
    assert.deepEqual(await linkProblems(root, "README.md", "[broken](https://[invalid)"), [
      "README.md: enlace HTTP(S) inválido: https://[invalid"
    ]);
    assert.deepEqual(await linkProblems(root, "docs/source.md", "[escape](../../secret.md)"), [
      "docs/source.md: enlace local sale del repositorio: ../../secret.md"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata de catálogos exige SemVer, owner, issue y fecha vigente", () => {
  const valid = {
    schemaVersion: 1,
    catalogVersion: "1.0.0",
    updatedAt: "2026-07-17",
    items: [{ id: "nova", owner: "nova", status: "transitioning", issue: "HYP-NOVA-001", dueDate: "2026-09-30" }]
  };
  assert.deepEqual(catalogMetadataProblems("catalog.json", valid, "2026-07-17"), []);
  const invalid = structuredClone(valid);
  invalid.items[0].owner = "";
  invalid.items[0].issue = "TBD";
  invalid.items[0].dueDate = "2026-07-16";
  assert.deepEqual(catalogMetadataProblems("catalog.json", invalid, "2026-07-17"), [
    "catalog.json: nova no declara owner",
    "catalog.json: nova usa issue inválido",
    "catalog.json: nova: dueDate vencida (2026-07-16)"
  ]);
});

test("runbooks requieren estado y evidencia adicional antes de declararse activos", () => {
  const base = `---\ndocumentType: runbook\nstatus: not-current\nowner: ops\nissue: HYP-OPS-001\nreviewDue: 2026-09-30\n---\n# Runbook\n`;
  assert.deepEqual(runbookMetadataProblems("docs/ops/runbook.md", base, "2026-07-17"), []);
  assert.deepEqual(
    runbookMetadataProblems("docs/ops/runbook.md", base.replace("not-current", "active"), "2026-07-17"),
    ["docs/ops/runbook.md: un runbook active requiere validatedAt y releaseManifest"]
  );
  const active = base
    .replace("not-current", "active")
    .replace(
      "---\n# Runbook",
      "validatedAt: 2026-02-30\nreleaseManifest: releases/manifests/platform/1.0.0.json\n---\n# Runbook"
    );
  assert.deepEqual(runbookMetadataProblems("docs/ops/runbook.md", active, "2026-07-17"), [
    "docs/ops/runbook.md: validatedAt inválida"
  ]);
});

test("runbook active exige manifiesto publicado, existente y coherente con su cell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-active-runbook-"));
  try {
    await mkdir(path.join(root, "releases", "manifests", "nova"), { recursive: true });
    await mkdir(path.join(root, "releases", "catalogs", "nova"), { recursive: true });
    await writeFile(
      path.join(root, "releases", "manifests", "nova", "1.2.3.json"),
      JSON.stringify({
        schemaVersion: 1,
        cell: "nova",
        catalogVersion: "2.0.0",
        releaseVersion: "1.2.3",
        status: "published",
        releasedAt: "2026-07-16T00:00:00Z",
        imagesVerified: true
      }),
      "utf8"
    );
    await writeFile(
      path.join(root, "releases", "catalogs", "nova", "2.0.0.json"),
      JSON.stringify({ cell: "nova", catalogVersion: "2.0.0" }),
      "utf8"
    );
    const content = [
      "---",
      "documentType: runbook",
      "status: active",
      "owner: nova-operations",
      "issue: HYP-NOVA-001",
      "reviewDue: 2026-09-30",
      "validatedAt: 2026-07-17",
      "releaseManifest: releases/manifests/nova/1.2.3.json",
      "---",
      "# Runbook"
    ].join("\n");
    assert.deepEqual(
      await activeRunbookReleaseProblems(root, "docs/operations/NOVA-STANDALONE.md", content, "2026-07-17"),
      []
    );
    assert.deepEqual(
      await activeRunbookReleaseProblems(root, "docs/operations/LUMEN-STANDALONE.md", content, "2026-07-17"),
      ["docs/operations/LUMEN-STANDALONE.md: releaseManifest pertenece a nova; esperado lumen"]
    );
    const missing = content.replace("nova/1.2.3.json", "nova/9.9.9.json");
    assert.match(
      (await activeRunbookReleaseProblems(root, "docs/operations/NOVA-STANDALONE.md", missing))[0],
      /releaseManifest ausente o JSON inválido/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deuda versionada cubre cada finding exactamente una vez", () => {
  const baseline = {
    violations: [{ id: "sql-access|file.ts|pulso-core->audit|read|table|audit.events", count: 1 }]
  };
  const valid = {
    baselineStats: { findingGroups: 1, instances: 1, workstreams: 1 },
    items: [
      { id: "DEBT-001", findingType: "sql-access", edge: "pulso-core->audit" },
      { id: "DEBT-002", source: "temporary-exception" },
      { id: "DEBT-003", source: "transition-inventory" }
    ]
  };
  assert.deepEqual(debtCoverageProblems(valid, baseline), []);
  const invalidSource = structuredClone(valid);
  invalidSource.items[2].source = "inventario-libre";
  assert.deepEqual(debtCoverageProblems(invalidSource, baseline), [
    "docs/catalogs/debt.v1.json: DEBT-003 usa source no permitido inventario-libre"
  ]);
  assert.match(
    debtCoverageProblems({ baselineStats: { findingGroups: 1, instances: 1, workstreams: 0 }, items: [] }, baseline)[0],
    /debe mapear exactamente una entrada/
  );
});

test("deuda SECURITY DEFINER se clasifica por pathPrefix y no como catch-all entre productos", () => {
  const catalog = {
    baselineStats: { findingGroups: 2, instances: 2, workstreams: 1 },
    items: [
      {
        id: "DEBT-031",
        findingType: "security-definer-cross-owner",
        pathPrefixes: ["packages/pulso-migrations/sql/"]
      }
    ]
  };
  const baseline = {
    violations: [
      {
        id: "security-definer-cross-owner|packages/pulso-migrations/sql/001.sql|pulso.fn",
        count: 1
      },
      {
        id: "security-definer-cross-owner|packages/lumen-migrations/sql/001.sql|lumen.fn",
        count: 1
      }
    ]
  };
  assert.deepEqual(debtCoverageProblems(catalog, baseline), [
    "docs/catalogs/debt.v1.json: finding security-definer-cross-owner|packages/lumen-migrations/sql/001.sql|lumen.fn debe mapear exactamente una entrada (mapea 0)"
  ]);
});

test("excepciones temporales exigen owner, issue y expiración futura", () => {
  const debtCatalog = {
    items: [{ source: "temporary-exception", issue: "HYP-DEBT-001", owner: "pulso" }]
  };
  assert.deepEqual(
    temporaryExceptionProblems(
      [
        {
          id: "finding",
          justification: "compatibilidad N-1",
          owner: "pulso",
          issue: "HYP-DEBT-001",
          expiresAt: "2026-10-31"
        }
      ],
      "2026-07-17",
      debtCatalog
    ),
    []
  );
  assert.deepEqual(temporaryExceptionProblems([{ id: "finding", justification: "legacy" }], "2026-07-17"), [
    "data-ownership: finding no declara owner",
    "data-ownership: finding no declara issue",
    "data-ownership: finding no declara expiresAt"
  ]);
});

test("expansión de requisitos conserva rangos e IDs individuales", () => {
  assert.deepEqual(expandRequirementExpression("NOV-001–NOV-003, NOV-019"), [
    "NOV-001",
    "NOV-002",
    "NOV-003",
    "NOV-019"
  ]);
});

test("trazabilidad NOVA exige cobertura, estado coincidente y evidencia real", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-nova-trace-"));
  try {
    await mkdir(path.join(root, "services", "nova", "src"), { recursive: true });
    await writeFile(path.join(root, "services", "nova", "src", "feature.ts"), "export {};\n", "utf8");
    const spec = [
      "## Contexto",
      "| ID | Requisito | Estado | Límite |",
      "| --- | --- | --- | --- |",
      "| NOV-001 | Importar | `parcial` | Falta carga |"
    ].join("\n");
    const trace = [
      "## NOVA",
      "| ID | Requisito | Estado | Evidencia | Brecha |",
      "| --- | --- | --- | --- | --- |",
      "| NOV-001 | Importar | `parcial` | `services/nova/src/feature.ts` | Falta carga |"
    ].join("\n");
    assert.deepEqual(await novaTraceabilityProblems(root, spec, trace), []);
    assert.deepEqual(await novaTraceabilityProblems(root, spec, trace.replace("feature.ts", "missing.ts")), [
      "trazabilidad NOVA: NOV-001 referencia evidencia inexistente services/nova/src/missing.ts"
    ]);
    assert.deepEqual(await novaTraceabilityProblems(root, spec, "## NOVA\n"), [
      "trazabilidad NOVA: NOV-001 falta en REQUIREMENTS-TRACEABILITY.md"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trazabilidad PULSO y LUMEN valida evidencia para rangos compuestos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-product-trace-"));
  try {
    await mkdir(path.join(root, "apps", "lumen"), { recursive: true });
    await writeFile(path.join(root, "apps", "lumen", "view.ts"), "export {};\n", "utf8");
    const traceability = [
      "| ID | Requisito | Estado | Evidencia | Brecha |",
      "| --- | --- | --- | --- | --- |",
      "| LUM-020–LUM-021, LUM-045–LUM-046 | Flujo | `parcial` | `apps/lumen/view.ts` | Falta |"
    ].join("\n");
    assert.deepEqual(await productTraceabilityEvidenceProblems(root, traceability, ["LUM"]), []);
    assert.deepEqual(
      await productTraceabilityEvidenceProblems(root, traceability.replace("view.ts", "missing.ts"), ["LUM"]),
      ["trazabilidad LUM: LUM-020–LUM-021, LUM-045–LUM-046 referencia evidencia inexistente apps/lumen/missing.ts"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventario de servicios cubre cada package desplegable y verifica el manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-service-catalog-"));
  try {
    await mkdir(path.join(root, "apps", "api"), { recursive: true });
    await mkdir(path.join(root, "services", "core-service"), { recursive: true });
    await mkdir(path.join(root, "packages", "migrator"), { recursive: true });
    await mkdir(path.join(root, "packages", "library"), { recursive: true });
    await mkdir(path.join(root, "packages", "service-runtime", "src"), { recursive: true });
    await writeFile(path.join(root, "apps", "api", "package.json"), '{"name":"@test/api"}\n', "utf8");
    await writeFile(path.join(root, "services", "core-service", "package.json"), '{"name":"@test/core"}\n', "utf8");
    await writeFile(
      path.join(root, "packages", "migrator", "package.json"),
      '{"name":"@test/migrator","scripts":{"migrate":"node dist/index.js"}}\n',
      "utf8"
    );
    await writeFile(
      path.join(root, "packages", "library", "package.json"),
      '{"name":"@test/library","scripts":{"build":"tsc"}}\n',
      "utf8"
    );
    await writeFile(
      path.join(root, "packages", "service-runtime", "src", "index.ts"),
      'const DATABASE_ROLE_BY_SERVICE = {\n  "core-service": "hyperion_core"\n};\n',
      "utf8"
    );
    const catalog = {
      items: [
        { id: "api", path: "apps/api", packageName: "@test/api", status: "active" },
        {
          id: "core",
          path: "services/core-service",
          packageName: "@test/core",
          status: "active",
          databaseRole: "hyperion_core"
        },
        {
          id: "migrator",
          path: "packages/migrator",
          packageName: "@test/migrator",
          status: "active"
        },
        { id: "future", path: "apps/future", packageName: "@test/future", status: "planned" }
      ]
    };
    assert.deepEqual(await serviceInventoryProblems(root, catalog), []);
    catalog.items = catalog.items.filter((item) => item.id === "api");
    assert.deepEqual(await serviceInventoryProblems(root, catalog), [
      "docs/catalogs/services.v1.json: package desplegable sin inventariar services/core-service",
      "docs/catalogs/services.v1.json: package desplegable sin inventariar packages/migrator"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventario provider-migrations exige script y SQL reales", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-provider-migration-catalog-"));
  try {
    await mkdir(path.join(root, "packages", "alpha-migrations", "sql"), { recursive: true });
    await writeFile(
      path.join(root, "packages", "alpha-migrations", "package.json"),
      JSON.stringify({ name: "@test/alpha-migrations", scripts: {} }),
      "utf8"
    );
    await writeFile(path.join(root, "packages", "alpha-migrations", "sql", "001.sql"), "select 1;\n", "utf8");
    const catalog = {
      items: [
        {
          id: "alpha-migrations",
          path: "packages/alpha-migrations",
          packageName: "@test/alpha-migrations",
          kind: "provider-migrations",
          status: "active"
        }
      ]
    };
    assert.deepEqual(await serviceInventoryProblems(root, catalog), [
      "docs/catalogs/services.v1.json: alpha-migrations provider-migrations no declara scripts.migrate"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("variables operativas deben existir en .env.example", () => {
  const content = "```dotenv\nREAL_TOKEN=\nMISSING_SECRET=\n```\n`${REAL_TOKEN}` `${MISSING_SECRET}`";
  assert.deepEqual(environmentReferenceProblems("docs/runbook.md", content, "REAL_TOKEN=replace-me\n"), [
    "docs/runbook.md: variable documentada no inventariada en .env.example: MISSING_SECRET"
  ]);
});

test("variables inventariadas requieren consumo real y pruebas o comentarios no lo simulan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-env-usage-"));
  try {
    await mkdir(path.join(root, "apps", "runtime", "src"), { recursive: true });
    await mkdir(path.join(root, "infra"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, ".env.example"),
      "COMPOSE_TOKEN=replace-me\nCODE_TOKEN=replace-me\nDYNAMIC_TOKEN=replace-me\nDEAD_TOKEN=replace-me\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "infra", "docker-compose.yml"),
      'services:\n  api:\n    environment:\n      COMPOSE_TOKEN: "${COMPOSE_TOKEN}"\n',
      "utf8"
    );
    await writeFile(
      path.join(root, "apps", "runtime", "src", "config.ts"),
      [
        "export const token = process.env.CODE_TOKEN;",
        'const names = ["DYNAMIC_TOKEN"];',
        "export const dynamic = names.map((name) => process.env[name]);",
        "// process.env.DEAD_TOKEN must not make dead configuration look consumed"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "apps", "runtime", "src", "config.test.ts"),
      "process.env.DEAD_TOKEN = 'test-only';\n",
      "utf8"
    );
    assert.deepEqual(await environmentUsageProblems(root), [
      ".env.example: variable declarada sin consumo estático en Compose/código: DEAD_TOKEN"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cada env example exige consumo dentro de su propia célula aunque el nombre esté duplicado", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-env-scope-collision-"));
  try {
    await mkdir(path.join(root, "infra"), { recursive: true });
    await writeFile(path.join(root, "infra", "alpha.env.example"), "SHARED_TOKEN=replace-me\n", "utf8");
    await writeFile(path.join(root, "infra", "beta.env.example"), "SHARED_TOKEN=replace-me\n", "utf8");
    await writeFile(
      path.join(root, "infra", "docker-compose.alpha.yml"),
      'services:\n  api:\n    environment:\n      SHARED_TOKEN: "${SHARED_TOKEN}"\n',
      "utf8"
    );
    await writeFile(
      path.join(root, "infra", "docker-compose.beta.yml"),
      "services:\n  api:\n    image: example.test/api\n",
      "utf8"
    );

    assert.deepEqual(await environmentUsageProblems(root), [
      "infra/beta.env.example: variable declarada sin consumo estático en Compose/código: SHARED_TOKEN"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scope de env example es fail-closed para células, ops y subárboles propietarios", () => {
  const runtimeFiles = [
    "infra/docker-compose.alpha.yml",
    "infra/docker-compose.beta.yml",
    "scripts/ops/alpha-postgres-backup.sh",
    "scripts/ops/beta-postgres-backup.sh",
    "apps/customer/src/config.ts",
    "apps/other/src/config.ts",
    "infra/docker/edge/default.conf.template",
    "infra/docker-compose.edge.yml"
  ];
  assert.deepEqual(environmentRuntimeScope("infra/alpha.env.example", runtimeFiles), [
    "infra/docker-compose.alpha.yml"
  ]);
  assert.deepEqual(environmentRuntimeScope("infra/alpha-ops.env.example", runtimeFiles), [
    "scripts/ops/alpha-postgres-backup.sh"
  ]);
  assert.deepEqual(environmentRuntimeScope("apps/customer/.env.example", runtimeFiles), [
    "apps/customer/src/config.ts"
  ]);
  assert.deepEqual(environmentRuntimeScope("infra/docker/edge/edge.env.example", runtimeFiles), [
    "infra/docker/edge/default.conf.template",
    "infra/docker-compose.edge.yml"
  ]);
});

test("extractor de consumo reconoce Compose, código, shell y acceso dinámico sin comentarios", () => {
  const declared = new Set(["COMPOSE_KEY", "CODE_KEY", "SHELL_KEY", "DYNAMIC_KEY", "COMMENT_ONLY"]);
  assert.deepEqual(
    [...environmentConsumptionNames("infra/docker-compose.yml", "A: ${COMPOSE_KEY:-x}\n", declared)],
    ["COMPOSE_KEY"]
  );
  assert.deepEqual(
    [
      ...environmentConsumptionNames(
        "apps/api/config.ts",
        'const names = ["DYNAMIC_KEY"]; process.env.CODE_KEY; names.map((name) => process.env[name]); // process.env.COMMENT_ONLY',
        declared
      )
    ].sort(),
    ["CODE_KEY", "DYNAMIC_KEY"]
  );
  assert.deepEqual(
    [...environmentConsumptionNames("scripts/run.sh", '# $COMMENT_ONLY\necho "$SHELL_KEY"\n', declared)],
    ["SHELL_KEY"]
  );
});

test("prácticas inseguras detectan HTTP remoto, webhooks sin TLS, query secrets y credenciales", () => {
  const content = [
    "http://203.0.113.10/service",
    "http://localhost:8080/webhooks",
    "https://example.test/callback?token=visible",
    "https://example.test/callback?password=visible",
    "https://example.test/oauth?code=visible",
    "/callback?access_token=visible",
    `ghp_${"a".repeat(24)}`
  ].join("\n");
  assert.deepEqual(unsafeDocumentationProblems("docs/runbook.md", content), [
    "docs/runbook.md: secreto o token en query string",
    "docs/runbook.md: webhook HTTP sin TLS",
    "docs/runbook.md: URL HTTP pública o remota no permitida (http://203.0.113.10)",
    "docs/runbook.md: posible credencial real en documentación"
  ]);
});

test("docs:check inspecciona también infra/*.env.example", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-infra-env-docs-"));
  try {
    await mkdir(path.join(root, "infra"), { recursive: true });
    await writeFile(
      path.join(root, "infra", "nova.env.example"),
      "SAFE_URL=https://example.test/callback\nUNSAFE_URL=https://example.test/callback?password=replace-me\n",
      "utf8"
    );
    assert.deepEqual(await infraEnvironmentExampleProblems(root), [
      "infra/nova.env.example: secreto o token en query string"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("docs:check inspecciona recursivamente todos los *.env.example", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-all-env-docs-"));
  try {
    await mkdir(path.join(root, "apps", "customer"), { recursive: true });
    await mkdir(path.join(root, "infra", "docker", "edge"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(root, ".env.example"), "CALLBACK=/login?token=visible\n", "utf8");
    await writeFile(
      path.join(root, "apps", "customer", ".env.example"),
      "CALLBACK=https://example.test/login?password=visible\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "infra", "docker", "edge", "edge.env.example"),
      "WEBHOOK=http://example.test/webhook\n",
      "utf8"
    );
    await writeFile(
      path.join(root, "node_modules", "ignored", ".env.example"),
      "CALLBACK=/ignored?secret=visible\n",
      "utf8"
    );
    assert.deepEqual(await environmentExampleProblems(root), [
      ".env.example: secreto o token en query string",
      "apps/customer/.env.example: secreto o token en query string",
      "infra/docker/edge/edge.env.example: webhook HTTP sin TLS",
      "infra/docker/edge/edge.env.example: URL HTTP pública o remota no permitida (http://example.test)"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("README de catálogos publica estadísticas derivadas y no cifras manuales obsoletas", () => {
  const catalogs = {
    products: { items: [{ id: "platform" }, { id: "nova" }] },
    services: { items: [{ id: "api" }] },
    debt: {
      baselineStats: { findingGroups: 4, instances: 5, workstreams: 2 },
      items: [
        { id: "baseline" },
        { id: "temporary", source: "temporary-exception" },
        { id: "transition", source: "transition-inventory" }
      ]
    }
  };
  const valid =
    "Estadísticas normativas: `products=2`, `services=1`, `debtItems=3`, `findingGroups=4`, " +
    "`instances=5`, `workstreams=2`, `temporaryExceptions=1` y `transitionInventory=1`.";
  assert.deepEqual(catalogReadmeProblems(valid, catalogs), []);
  assert.deepEqual(catalogReadmeProblems(valid.replace("services=1", "services=9"), catalogs), [
    "docs/catalogs/README.md: services=9; esperado 1 según los catálogos"
  ]);
});

test("docs:check permanece conectado a scripts y workflows", () => {
  const manifest = {
    scripts: {
      "docs:test": "node --test scripts/docs/check-docs.test.mjs",
      "docs:check": "node scripts/docs/check-docs.mjs"
    }
  };
  const workflow = "steps:\n  - run: pnpm docs:test\n  - run: pnpm docs:check\n";
  assert.deepEqual(documentationCiProblems(manifest, workflow, workflow), []);
  assert.deepEqual(documentationCiProblems(manifest, "steps: []\n", workflow), [
    ".github/workflows/check.yml: no ejecuta pnpm docs:test",
    ".github/workflows/check.yml: no ejecuta pnpm docs:check"
  ]);
});
