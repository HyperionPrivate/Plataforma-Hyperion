import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CELL_CONTEXT_FILES,
  calculateContextClosureSha256,
  generateCellContext,
  readGeneratedManifest,
  temporaryContextRoot
} from "./generate-cell-contexts.mjs";
import {
  COOPFUTURO_CONTEXT_ALLOWLIST,
  generateCoopfuturoContext,
  readCoopfuturoManifest
} from "./generate-coopfuturo-context.mjs";
import { CELL_COMPOSE_SERVICES } from "../architecture/cell-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("pnpm tolera un registro lento sin confiar ciegamente en el lockfile", async () => {
  const workspace = await readFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");

  assert.match(workspace, /^networkConcurrency: 8$/m);
  assert.match(workspace, /^fetchRetries: 4$/m);
  assert.match(workspace, /^fetchRetryMaxtimeout: 120000$/m);
  assert.match(workspace, /^fetchTimeout: 180000$/m);
  assert.doesNotMatch(workspace, /^trustLockfile:\s*true$/m);
  assert.doesNotMatch(workspace, /^minimumReleaseAge:\s*0$/m);
});

test("el contexto NOVA materializa sólo fuentes de su celda", async (context) => {
  const outputRoot = await temporaryContextRoot();
  context.after(() => rm(outputRoot, { recursive: true, force: true }));

  const result = await generateCellContext(repositoryRoot, outputRoot, "nova");
  const manifest = await readGeneratedManifest(outputRoot, "nova");

  assert.equal(manifest.cell, "nova");
  assert.equal(manifest.closure.algorithm, "sha256-path-null-content-sha256-lf-v1");
  assert.match(manifest.closure.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.closure.sha256, result.closureSha256);
  assert.equal(await calculateContextClosureSha256(result.target, result.files), result.closureSha256);
  assert(result.files.includes("apps/nova-bff/package.json"));
  assert(result.files.includes("apps/nova-console/package.json"));
  assert(result.files.includes("packages/nova-migrations/package.json"));
  assert(result.files.includes("packages/nova-contracts/package.json"));
  assert(!result.files.some((file) => /(?:^|\/)(?:lumen|pulso)(?:-|\/)/i.test(file)));
  assert(result.files.includes("services/nova-core-service/package.json"));
  assert(result.files.includes("services/voice-channel-service/package.json"));
  assert(result.files.includes("services/liwa-channel-service/package.json"));
  assert(result.files.includes("services/documents-service/package.json"));
  assert(
    !result.files.some(
      (file) =>
        /^services\//.test(file) &&
        !/^services\/(?:nova-core-service|voice-channel-service|liwa-channel-service|documents-service)\//.test(file)
    )
  );
  assert(!result.files.includes("packages/contracts/src/lumen.ts"));
  assert(!result.files.includes("packages/contracts/src/pulso.ts"));
  assert(!result.files.some((file) => /^packages\/(?:contracts|config|service-runtime|durable-events)\//.test(file)));

  const repeated = await generateCellContext(repositoryRoot, outputRoot, "nova");
  assert.equal(repeated.closureSha256, result.closureSha256, "generation time must not change the source closure");
});

test("Coopfuturo usa un contexto customer-owned con allowlist y provenance propios", async (context) => {
  const outputRoot = await temporaryContextRoot();
  context.after(() => rm(outputRoot, { recursive: true, force: true }));

  const result = await generateCoopfuturoContext(repositoryRoot, outputRoot);
  const manifest = await readCoopfuturoManifest(outputRoot);

  assert.equal(manifest.kind, "customer-console-context");
  assert.equal(manifest.cell, "nova");
  assert.equal(manifest.client, "coopfuturo-console");
  assert.equal(manifest.sourceRoot, "apps/coopfuturo-console");
  assert.deepEqual(manifest.allowlist, COOPFUTURO_CONTEXT_ALLOWLIST);
  assert.deepEqual(manifest.files, result.files);
  assert(result.files.some((file) => file.path === "Dockerfile"));
  assert(result.files.some((file) => file.path === "package-lock.json"));
  assert(result.files.some((file) => file.path === "scripts/check-bundle.mjs"));
  assert(result.files.some((file) => file.path.startsWith("src/")));
  assert(
    result.files.every((file) =>
      COOPFUTURO_CONTEXT_ALLOWLIST.some(
        (allowedPath) => file.path === allowedPath || file.path.startsWith(`${allowedPath}/`)
      )
    )
  );
  assert(result.files.every((file) => file.source === `apps/coopfuturo-console/${file.path}`));
  assert(!result.files.some((file) => /^(?:tests|node_modules|\.next|.*\.env)/.test(file.path)));
  assert(!result.files.some((file) => /(?:^|\/)(?:lumen|pulso)(?:-|\/)/i.test(file.path)));

  for (const file of result.files) {
    const contents = await readFile(path.join(result.target, file.path));
    assert.equal(file.bytes, contents.byteLength, file.path);
    assert.equal(file.sha256, createHash("sha256").update(contents).digest("hex"), file.path);
  }
});

test("cada contexto declara una allowlist sin aplicaciones de otra celda", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(CELL_CONTEXT_FILES).map(([cell, paths]) => [cell, paths.filter((p) => p.startsWith("apps/"))])
    ),
    {
      nova: ["apps/nova-bff", "apps/nova-console"],
      lumen: ["apps/lumen-bff", "apps/lumen-console"],
      pulso: ["apps/pulso-bff", "apps/pulso-console"],
      platform: ["apps/platform-admin-bff", "apps/platform-admin-console"]
    }
  );
});

test("el contexto de plataforma contiene la clausura autónoma de Access, Audit y administración", async (context) => {
  const outputRoot = await temporaryContextRoot();
  context.after(() => rm(outputRoot, { recursive: true, force: true }));

  const result = await generateCellContext(repositoryRoot, outputRoot, "platform");
  const manifest = await readGeneratedManifest(outputRoot, "platform");

  for (const requiredFile of [
    "apps/platform-admin-bff/package.json",
    "apps/platform-admin-console/package.json",
    "services/audit-service/package.json",
    "services/identity-service/package.json",
    "services/tenant-service/package.json",
    "packages/access-migrations/package.json",
    "packages/audit-contracts/package.json",
    "packages/audit-migrations/package.json",
    "packages/config/package.json",
    "packages/database/package.json",
    "packages/durable-events/package.json",
    "packages/frontend-build-provenance/index.d.mts",
    "packages/frontend-build-provenance/index.mjs",
    "packages/frontend-build-provenance/package.json",
    "packages/logger/package.json",
    "packages/platform-contracts/package.json",
    "packages/service-runtime/package.json",
    "Dockerfile",
    "infra/docker/console.nginx.conf.template"
  ]) {
    assert(result.files.includes(requiredFile), `Platform context is missing ${requiredFile}`);
  }

  assert(manifest.sources.includes("infra/docker/cells/platform.Dockerfile"));
  assert(!result.files.some((file) => /^apps\/(?!(?:platform-admin-bff|platform-admin-console)\/)/.test(file)));
  assert(!result.files.some((file) => /^services\/(?!(?:audit-service|identity-service|tenant-service)\/)/.test(file)));
  for (const forbiddenSource of [
    "apps/api-gateway/",
    "apps/web-console/",
    "packages/migrations/",
    "packages/platform-migrations/"
  ]) {
    assert(!result.files.some((file) => file.startsWith(forbiddenSource)), `Platform copied ${forbiddenSource}`);
    assert(
      !manifest.sources.some((source) => source.startsWith(forbiddenSource)),
      `Platform allowed ${forbiddenSource}`
    );
  }
  assert(!result.files.some((file) => /^packages\/(?:nova|lumen|pulso)(?:-|\/)/.test(file)));
});

test("LUMEN y PULSO no transmiten el catálogo global de contratos", async (context) => {
  const outputRoot = await temporaryContextRoot();
  context.after(() => rm(outputRoot, { recursive: true, force: true }));

  for (const cell of ["lumen", "pulso"]) {
    const result = await generateCellContext(repositoryRoot, outputRoot, cell);
    assert(!result.files.some((file) => file.startsWith("packages/contracts/")), `${cell} copied global contracts`);
    assert(result.files.includes(`packages/${cell}-contracts/package.json`));
    assert(result.files.includes("packages/platform-contracts/package.json"));
  }
});

test("el contexto LUMEN contiene la clausura autónoma del proveedor", async (context) => {
  const outputRoot = await temporaryContextRoot();
  context.after(() => rm(outputRoot, { recursive: true, force: true }));

  const result = await generateCellContext(repositoryRoot, outputRoot, "lumen");
  const manifest = await readGeneratedManifest(outputRoot, "lumen");

  for (const requiredFile of [
    "apps/lumen-bff/package.json",
    "apps/lumen-console/package.json",
    "services/lumen-service/package.json",
    "packages/audit-contracts/package.json",
    "packages/config/package.json",
    "packages/database/package.json",
    "packages/durable-events/package.json",
    "packages/frontend-build-provenance/index.d.mts",
    "packages/frontend-build-provenance/index.mjs",
    "packages/frontend-build-provenance/package.json",
    "packages/logger/package.json",
    "packages/lumen-contracts/package.json",
    "packages/lumen-migrations/package.json",
    "packages/platform-contracts/package.json",
    "packages/service-runtime/package.json",
    "Dockerfile",
    "infra/docker/console.nginx.conf.template"
  ]) {
    assert(result.files.includes(requiredFile), `LUMEN context is missing ${requiredFile}`);
  }

  assert(manifest.sources.includes("infra/docker/cells/lumen.Dockerfile"));
  assert(!manifest.sources.includes("infra/docker/cells/frontend.Dockerfile"));
  assert(
    !result.files.some(
      (file) => /^apps\/(?:nova|pulso|platform-admin)-/.test(file) || /^services\/(?!lumen-service\/)/.test(file)
    )
  );
  assert(!result.files.some((file) => /^packages\/(?:contracts|migrations|nova(?:-|\/)|pulso(?:-|\/))/.test(file)));
});

test("ningún Dockerfile ejecuta un build recursivo global", async () => {
  const dockerfiles = [
    "infra/docker/node-service.Dockerfile",
    "infra/docker/cells/lumen.Dockerfile",
    "infra/docker/cells/nova.Dockerfile",
    "infra/docker/cells/platform.Dockerfile",
    "infra/docker/cells/pulso.Dockerfile",
    "infra/docker/legacy/Dockerfile",
    "apps/coopfuturo-console/Dockerfile"
  ];
  for (const relativePath of dockerfiles) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /pnpm\s+(?:--recursive|-r)\s+build/, relativePath);
  }
});

test("la arquitectura federada no conserva el Dockerfile frontend multiproducto", async () => {
  await assert.rejects(
    readFile(path.join(repositoryRoot, "infra/docker/cells/frontend.Dockerfile"), "utf8"),
    (error) => error?.code === "ENOENT"
  );
});

test("cada target LUMEN compila y publica sólo su deployable y dependencias", async () => {
  const dockerfile = await readFile(path.join(repositoryRoot, "infra/docker/cells/lumen.Dockerfile"), "utf8");
  const deployables = {
    "lumen-migrations": "@hyperion/lumen-migrations",
    "lumen-service": "@hyperion/lumen-service",
    "lumen-bff": "@hyperion/lumen-bff",
    "lumen-console": "@hyperion/lumen-console"
  };

  assert.doesNotMatch(dockerfile, /@hyperion\/(?:contracts|migrations)(?:[".\s]|$)/);
  assert.doesNotMatch(dockerfile, /(?:apps|packages|services)\/(?:nova|pulso)(?:-|\/)/i);

  for (const [target, packageName] of Object.entries(deployables)) {
    const buildBlock = stage(dockerfile, `${target}-build`);
    assert.match(buildBlock, new RegExp(`pnpm --filter "${packageName.replace("/", "\\/")}\\.\\.\\." build`));
    for (const siblingPackage of Object.values(deployables).filter((name) => name !== packageName)) {
      assert.doesNotMatch(buildBlock, new RegExp(`--filter "${siblingPackage.replace("/", "\\/")}\\.\\.\\."`));
    }
  }

  for (const target of ["lumen-migrations", "lumen-service", "lumen-bff"]) {
    const runtimeBlock = stage(dockerfile, target);
    assert.match(runtimeBlock, new RegExp(`COPY --from=${target}-build`));
    for (const sibling of ["lumen-migrations", "lumen-service", "lumen-bff"].filter((name) => name !== target)) {
      assert.doesNotMatch(runtimeBlock, new RegExp(`COPY --from=${sibling}-build`));
    }
  }
});

test("el runtime LUMEN recibe sólo el manifest estructural y nunca el migrador", async (context) => {
  const outputRoot = await temporaryContextRoot();
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  await generateCellContext(repositoryRoot, outputRoot, "lumen");

  const generatedRoot = path.join(outputRoot, "lumen");
  const dockerfile = await readFile(path.join(generatedRoot, "Dockerfile"), "utf8");
  const runtimeBlock = stage(dockerfile, "lumen-service");
  const migrationCopies = runtimeBlock.match(/^COPY .*packages\/lumen-migrations.*$/gm) ?? [];

  assert.deepEqual(migrationCopies, [
    "COPY packages/lumen-migrations/package.json packages/lumen-migrations/package.json",
    "COPY --from=lumen-service-build /app/packages/lumen-migrations/dist/schema-manifest.js packages/lumen-migrations/dist/schema-manifest.js"
  ]);
  assert.doesNotMatch(runtimeBlock, /^COPY(?:\s+--from=\S+)?\s+(?:\/app\/)?packages\/?\s+(?:\.\/)?packages\/?\s*$/m);
  assert.doesNotMatch(runtimeBlock, /packages\/lumen-migrations\/(?:sql|src)(?:\/|\s|$)/i);
  assert.doesNotMatch(
    runtimeBlock,
    /packages\/lumen-migrations\/dist\/(?:index|runner|config|roles|bootstrap-[a-z-]+|database-bootstrap)\.js/i
  );
  assert.doesNotMatch(runtimeBlock, /\bLUMEN_[A-Z0-9_]*PASSWORD\b/);
  assert.doesNotMatch(runtimeBlock, /\bLUMEN_(?:POSTGRES_ADMIN_URL|MIGRATOR_DATABASE_URL)\b/);

  const migrationsManifest = JSON.parse(
    await readFile(path.join(generatedRoot, "packages/lumen-migrations/package.json"), "utf8")
  );
  assert.deepEqual(migrationsManifest.exports?.["./schema-manifest"], {
    types: "./dist/schema-manifest.d.ts",
    import: "./dist/schema-manifest.js"
  });
  const lumenApp = await readFile(path.join(generatedRoot, "services/lumen-service/src/app.ts"), "utf8");
  assert.match(lumenApp, /from "@hyperion\/lumen-migrations\/schema-manifest"/);
  assert.doesNotMatch(lumenApp, /from "@hyperion\/lumen-migrations"/);
});

test("Compose LUMEN consume exclusivamente el contexto generado de la celda", async (context) => {
  let compose;
  try {
    compose = await readFile(path.join(repositoryRoot, "infra/docker-compose.lumen.yml"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip("infra/docker-compose.lumen.yml todavía no fue materializado");
      return;
    }
    throw error;
  }

  assert.match(compose, /context:\s*\.\.\/\.docker-contexts\/lumen(?:\s|$)/);
  for (const service of CELL_COMPOSE_SERVICES.lumen) {
    assert.match(compose, new RegExp(`^  ${service}:\\r?$`, "m"), `standalone Compose is missing ${service}`);
  }
  for (const alias of ["lumen-database-bootstrap", "lumen-migrations", "lumen-role-bootstrap"]) {
    assert.match(composeService(compose, alias), /target:\s*lumen-migrations(?:\s|$)/);
  }
  for (const target of ["lumen-service", "lumen-bff", "lumen-console"]) {
    assert.match(composeService(compose, target), new RegExp(`target:\\s*${target}(?:\\s|$)`));
  }
  assert.doesNotMatch(compose, /infra\/docker-compose\.yml/);
});

test("el contexto PULSO contiene su clausura autónoma y ninguna fuente NOVA/LUMEN", async (context) => {
  const outputRoot = await temporaryContextRoot();
  context.after(() => rm(outputRoot, { recursive: true, force: true }));

  const result = await generateCellContext(repositoryRoot, outputRoot, "pulso");
  const manifest = await readGeneratedManifest(outputRoot, "pulso");

  for (const requiredFile of [
    "apps/pulso-bff/package.json",
    "apps/pulso-console/package.json",
    "services/agent-service/package.json",
    "services/prompt-flow-service/package.json",
    "services/knowledge-service/package.json",
    "services/integration-service/package.json",
    "services/pulso-iris-service/package.json",
    "services/whatsapp-channel-service/package.json",
    "packages/audit-contracts/package.json",
    "packages/config/package.json",
    "packages/database/package.json",
    "packages/durable-events/package.json",
    "packages/frontend-build-provenance/index.d.mts",
    "packages/frontend-build-provenance/index.mjs",
    "packages/frontend-build-provenance/package.json",
    "packages/logger/package.json",
    "packages/platform-contracts/package.json",
    "packages/pulso-contracts/package.json",
    "packages/pulso-migrations/package.json",
    "packages/service-runtime/package.json",
    "Dockerfile",
    "infra/docker/console.nginx.conf.template"
  ]) {
    assert(result.files.includes(requiredFile), `PULSO context is missing ${requiredFile}`);
  }

  assert(manifest.sources.includes("infra/docker/cells/pulso.Dockerfile"));
  assert(!manifest.sources.includes("infra/docker/cells/frontend.Dockerfile"));
  assert(
    !result.files.some(
      (file) =>
        /^apps\/(?:nova|lumen|platform-admin)-/.test(file) ||
        /^services\/(?:nova|voice|liwa|documents|lumen)-/.test(file) ||
        /^packages\/(?:contracts|migrations|nova(?:-|\/)|lumen(?:-|\/))/.test(file)
    )
  );
});

test("el Dockerfile PULSO compila una sola clausura por imagen y no incorpora siblings", async () => {
  const dockerfile = await readFile(path.join(repositoryRoot, "infra/docker/cells/pulso.Dockerfile"), "utf8");

  assert.match(dockerfile, /pnpm install --frozen-lockfile --filter "\$\{BUILD_FILTER\}\.\.\."/);
  assert.match(dockerfile, /pnpm --filter "\$\{BUILD_FILTER\}\.\.\." build/);
  assert.doesNotMatch(dockerfile, /pnpm\s+(?:--recursive|-r)\s+build/);
  assert.doesNotMatch(dockerfile, /(?:apps|packages|services)\/(?:nova|lumen)(?:-|\/)/i);
  assert.doesNotMatch(dockerfile, /packages\/(?:contracts|migrations)(?:\/|\s|$)/);

  const migrationsBuild = stage(dockerfile, "pulso-migrations-build");
  assert.match(migrationsBuild, /packages\/pulso-migrations\/sql/);
  const migrationsRuntime = stage(dockerfile, "pulso-migrations");
  assert.match(migrationsRuntime, /COPY --from=pulso-migrations-build \/runtime\//);
  const serviceRuntime = stage(dockerfile, "pulso-runtime");
  assert.doesNotMatch(serviceRuntime, /packages\/pulso-migrations\/sql/);
});

test("Compose PULSO consume sólo el contexto generado y fija cada build filter", async () => {
  const compose = await readFile(path.join(repositoryRoot, "infra/docker-compose.pulso.yml"), "utf8");

  assert.match(compose, /context:\s*\.\.\/\.docker-contexts\/pulso(?:\s|$)/);
  for (const service of CELL_COMPOSE_SERVICES.pulso) {
    assert.match(compose, new RegExp(`^  ${service}:\\r?$`, "m"), `standalone Compose is missing ${service}`);
  }
  for (const alias of ["pulso-database-bootstrap", "pulso-migrations", "pulso-role-bootstrap"]) {
    assert.match(composeService(compose, alias), /target:\s*pulso-migrations(?:\s|$)/);
  }
  const deployables = {
    "agent-service": "@hyperion/agent-service",
    "prompt-flow-service": "@hyperion/prompt-flow-service",
    "knowledge-service": "@hyperion/knowledge-service",
    "integration-service": "@hyperion/integration-service",
    "pulso-iris-service": "@hyperion/pulso-iris-service",
    "whatsapp-channel-service": "@hyperion/whatsapp-channel-service",
    "pulso-bff": "@hyperion/pulso-bff"
  };
  for (const [service, packageName] of Object.entries(deployables)) {
    const block = composeService(compose, service);
    assert.match(block, /target:\s*pulso-runtime(?:\s|$)/);
    assert.match(block, new RegExp(`BUILD_FILTER:\\s*["']?${packageName.replace("/", "\\/")}["']?`));
  }
  assert.match(composeService(compose, "pulso-console"), /target:\s*pulso-console(?:\s|$)/);
  assert.doesNotMatch(compose, /infra\/docker-compose\.yml/);
});

test("Compose PULSO expone la versión exacta de cada runtime del catálogo vigente", async () => {
  const [compose, environment, catalogSource] = await Promise.all([
    readFile(path.join(repositoryRoot, "infra/docker-compose.pulso.yml"), "utf8"),
    readFile(path.join(repositoryRoot, "infra/pulso.env.example"), "utf8"),
    readFile(path.join(repositoryRoot, "releases/catalogs/pulso/1.3.0.json"), "utf8")
  ]);
  const catalog = JSON.parse(catalogSource);
  const versionVariableByService = {
    "agent-service": "PULSO_AGENT_SERVICE_VERSION",
    "prompt-flow-service": "PULSO_PROMPT_FLOW_SERVICE_VERSION",
    "knowledge-service": "PULSO_KNOWLEDGE_SERVICE_VERSION",
    "integration-service": "PULSO_INTEGRATION_SERVICE_VERSION",
    "pulso-iris-service": "PULSO_IRIS_SERVICE_VERSION",
    "whatsapp-channel-service": "PULSO_WHATSAPP_CHANNEL_SERVICE_VERSION",
    "pulso-bff": "PULSO_BFF_VERSION"
  };

  for (const [service, variable] of Object.entries(versionVariableByService)) {
    const component = catalog.components.find((entry) => entry.id === service);
    assert(component, `PULSO catalog is missing ${service}`);
    const escapedVersion = component.version.replaceAll(".", "\\.");
    assert.match(
      composeService(compose, service),
      new RegExp(`SERVICE_VERSION:\\s*\\$\\{${variable}:-${escapedVersion}\\}`),
      `${service} does not expose its catalog version`
    );
    assert.match(environment, new RegExp(`^${variable}=${escapedVersion}$`, "m"));
  }

  assert.doesNotMatch(compose, /PULSO_SERVICE_VERSION/);
  assert.doesNotMatch(environment, /^PULSO_SERVICE_VERSION=/m);
});

test("cada target NOVA compila y publica sólo su deployable y dependencias", async () => {
  const dockerfile = await readFile(path.join(repositoryRoot, "infra/docker/cells/nova.Dockerfile"), "utf8");
  const deployables = {
    "nova-bff": "@hyperion/nova-bff",
    "nova-console": "@hyperion/nova-console",
    "nova-migrations": "@hyperion/nova-migrations",
    "nova-core-service": "@hyperion/nova-core-service",
    "voice-channel-service": "@hyperion/voice-channel-service",
    "liwa-channel-service": "@hyperion/liwa-channel-service",
    "documents-service": "@hyperion/documents-service"
  };

  const sourceBlock = stage(dockerfile, "nova-source");
  assert.doesNotMatch(sourceBlock, /^COPY (?:apps|packages|services)(?:\s|\/)/m);
  const serviceSourceBlock = stage(dockerfile, "nova-service-build-source");
  assert.doesNotMatch(serviceSourceBlock, /^COPY services(?:\s|\/)/m);

  for (const [target, packageName] of Object.entries(deployables)) {
    const buildBlock = stage(dockerfile, `${target}-build`);
    assert.match(buildBlock, new RegExp(`pnpm --filter "${packageName.replace("/", "\\/")}\\.\\.\\." build`));
    const deployablePath =
      target === "nova-migrations"
        ? "packages/nova-migrations"
        : target === "nova-bff" || target === "nova-console"
          ? `apps/${target}`
          : `services/${target}`;
    assert.match(buildBlock, new RegExp(`^COPY ${deployablePath.replaceAll("/", "\\/")} `, "m"));
    for (const siblingPackage of Object.values(deployables).filter((name) => name !== packageName)) {
      assert.doesNotMatch(buildBlock, new RegExp(`--filter "${siblingPackage.replace("/", "\\/")}\\.\\.\\."`));
    }
    for (const sibling of Object.keys(deployables).filter((name) => name !== target)) {
      assert.doesNotMatch(
        buildBlock,
        new RegExp(`^COPY (?:apps|services|packages)\\/${sibling.replaceAll("-", "\\-")} `, "m")
      );
    }
  }

  for (const target of ["nova-core-service", "voice-channel-service", "liwa-channel-service", "documents-service"]) {
    const runtimeBlock = stage(dockerfile, target);
    assert.match(runtimeBlock, new RegExp(`COPY --from=${target}-build`));
    for (const sibling of [
      "nova-core-service",
      "voice-channel-service",
      "liwa-channel-service",
      "documents-service"
    ].filter((name) => name !== target)) {
      assert.doesNotMatch(runtimeBlock, new RegExp(`(?:COPY --from=${sibling}-build|/services/${sibling}/dist)`));
    }
  }
});

test("todo workflow que construye Compose materializa primero los contextos allowlisted", async () => {
  for (const workflow of ["_cell-ci.yml", "check.yml", "container-scan.yml"]) {
    const contents = await readFile(path.join(repositoryRoot, ".github/workflows", workflow), "utf8");
    const generatorIndex = contents.indexOf("scripts/docker/generate-cell-contexts.mjs");
    const composeIndex = contents.indexOf("docker compose");
    const buildIndex = contents.indexOf(" build", composeIndex);
    assert(generatorIndex >= 0, `${workflow} does not materialize generated contexts`);
    assert(buildIndex >= 0, `${workflow} does not build Compose images`);
    assert(generatorIndex < buildIndex, `${workflow} builds before generated contexts exist`);
  }

  const containerScan = await readFile(path.join(repositoryRoot, ".github/workflows/container-scan.yml"), "utf8");
  const triggerBlock = containerScan.slice(0, containerScan.indexOf("permissions:"));
  assert.doesNotMatch(triggerBlock, /^\s+paths:/m);
  assert.match(containerScan, /resolve-container-scan-plan\.mjs/);
  assert.match(containerScan, /name: container images \/ required/);
});

test("los cuatro runtimes NOVA ya no requieren paquetes globales multiproducto", async () => {
  const forbidden = [
    "@hyperion/contracts",
    "@hyperion/config",
    "@hyperion/service-runtime",
    "@hyperion/durable-events"
  ];
  for (const service of ["nova-core-service", "voice-channel-service", "liwa-channel-service", "documents-service"]) {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "services", service, "package.json"), "utf8"));
    for (const dependency of forbidden) {
      assert.equal(manifest.dependencies?.[dependency], undefined, `${service} still imports ${dependency}`);
    }
  }
});

test("lumen-service consume contratos provider-owned mediante SemVer explícito", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "services/lumen-service/package.json"), "utf8"));
  assert.equal(manifest.dependencies?.["@hyperion/contracts"], undefined);
  assert.equal(manifest.dependencies?.["@hyperion/lumen-contracts"], "1.1.0");
  assert.equal(manifest.dependencies?.["@hyperion/audit-contracts"], "1.1.0");
  assert.equal(manifest.dependencies?.["@hyperion/platform-contracts"], "1.1.0");
});

function stage(dockerfile, name) {
  const match = dockerfile.match(new RegExp(`^FROM [^\\r\\n]+ AS ${name}\\r?\\n([\\s\\S]*?)(?=^FROM |\\Z)`, "m"));
  assert(match, `missing Docker stage ${name}`);
  return match[1];
}

function composeService(compose, name) {
  const match = compose.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^volumes:)`, "m"));
  assert(match, `missing Compose service ${name}`);
  return match[1];
}
