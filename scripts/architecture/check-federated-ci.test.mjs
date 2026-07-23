import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CELL_COMPOSE_DESCRIPTORS, CELL_COMPOSE_SERVICES, CELL_NAMES, CELL_SMOKE_TARGETS } from "./cell-policy.mjs";

const root = process.cwd();
const workflowRoot = path.join(root, ".github", "workflows");

test("each cell has an affected-aware, cancellable and required workflow", async () => {
  for (const cell of CELL_NAMES) {
    const workflow = await readFile(path.join(workflowRoot, `${cell}.yml`), "utf8");
    const triggerBlock = workflow.slice(0, workflow.indexOf("permissions:"));
    assert.match(triggerBlock, /^\s+pull_request:/m);
    assert.match(triggerBlock, /^\s+push:/m);
    assert.match(triggerBlock, /^\s+workflow_dispatch:/m);
    assert.match(workflow, /cancel-in-progress:\s*true/);
    assert.match(workflow, new RegExp(`resolve-cell-impact\\.mjs --cell ${cell}`));
    assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/_cell-ci\.yml/);
    assert.match(workflow, new RegExp(`name: ${cell} / required`));
    assert.match(workflow, /if:\s*always\(\)/);
    assert.match(workflow, /IMPACT_RESULT:\s*\$\{\{ needs\.impact\.result \}\}/);
    assert.match(workflow, /AFFECTED:\s*\$\{\{ needs\.impact\.outputs\.affected \}\}/);
    assert.match(workflow, /CELL_RESULT:\s*\$\{\{ needs\.cell\.result \}\}/);
    assert.match(workflow, /run:\s*node scripts\/ci\/verify-required-cell-result\.mjs/);
    assert.doesNotMatch(workflow, /test "\$AFFECTED" != "true"/);
  }
});

test("the reusable cell workflow executes every required phase and an image smoke", async () => {
  const workflow = await readFile(path.join(workflowRoot, "_cell-ci.yml"), "utf8");
  for (const phase of ["lint", "typecheck", "unit", "integration", "build"]) {
    assert.match(workflow, new RegExp(`--phase ${phase}`));
  }
  assert.match(workflow, /cell-compose-plan\.mjs/);
  assert.match(workflow, /cell-compose-plan\.mjs[^\n]*compose-file/);
  assert.match(workflow, /cell-compose-plan\.mjs[^\n]*env-file/);
  assert.match(workflow, /COMPOSE_FILE/);
  assert.match(workflow, /COMPOSE_ENV_FILE/);
  assert.match(workflow, /Start only the cell BFF image and verify its isolated health contract/);
  assert.match(workflow, /node scripts\/ci\/smoke-cell-bff-image\.mjs --cell/);
  assert.match(workflow, /resolve-compose-image-reference\.mjs/);
  assert.match(workflow, /docker image inspect --format '\{\{\.Id\}\}' "\$image_reference"/);
  assert.doesNotMatch(workflow, /images -q "\$service"/);
  assert.match(workflow, /label_key="io\.hyperion\.ci\.cell-bff-smoke"/);
  assert.match(workflow, /docker network ls --quiet --filter "label=\$\{label_key\}=\$\{expected_label\}"/);
  assert.match(workflow, /docker network inspect --format/);
  assert.match(workflow, /Refusing to remove smoke network .* label readback mismatch/);
  assert.match(workflow, /docker network rm "\$network_id"/);
  assert.doesNotMatch(workflow, /Platform.*\/ready|\/ready.*Platform/i);
  assert.doesNotMatch(workflow, /smoke-artifact/);
  assert.doesNotMatch(workflow, /--entrypoint node/);
  assert.doesNotMatch(workflow, /fs\.existsSync/);
  assert.match(workflow, /npm ci --prefix apps\/coopfuturo-console/);
  assert.match(workflow, /pnpm coopfuturo:check/);
  assert.match(workflow, /if: inputs\.cell != 'platform'/);
  assert.match(workflow, /pnpm backup:test --cell "\$\{\{ inputs\.cell \}\}"/);
  assert.doesNotMatch(workflow, /run:\s*pnpm backup:test\s*$/m);
  assert.match(workflow, /cell-install-plan\.mjs --cell "\$\{\{ inputs\.cell \}\}" --execute/);
  assert.doesNotMatch(workflow, /run:\s*pnpm install --frozen-lockfile\s*$/m);
  for (const command of ["architecture:test", "architecture:check", "federation:check", "compose:check"]) {
    assert.match(workflow, new RegExp(`run: pnpm ${command}`));
  }
  assert.match(workflow, /run: pnpm federation:test:cell -- --cell "\$\{\{ inputs\.cell \}\}"/);
  assert.doesNotMatch(workflow, /run: pnpm federation:test\s*$/m);
  assert.doesNotMatch(workflow, /pnpm\s+(?:-r|--recursive)\s+build/);
});

test("the Platform Compose plan is autonomous and keeps its administrative BFF smoke target", () => {
  const invoke = (output) =>
    spawnSync(process.execPath, ["scripts/ci/cell-compose-plan.mjs", "platform", output], {
      cwd: root,
      encoding: "utf8"
    });

  const services = invoke("services");
  const composeFile = invoke("compose-file");
  const envFile = invoke("env-file");
  const smokeService = invoke("smoke-service");
  const smokeArtifact = invoke("smoke-artifact");
  for (const result of [services, composeFile, envFile, smokeService, smokeArtifact]) {
    assert.equal(result.status, 0, result.stderr);
  }

  assert.deepEqual(CELL_COMPOSE_DESCRIPTORS.platform, {
    composeFile: "infra/docker-compose.platform.yml",
    envFile: "infra/platform.env.example"
  });
  assert.equal(composeFile.stdout.trim(), CELL_COMPOSE_DESCRIPTORS.platform.composeFile);
  assert.equal(envFile.stdout.trim(), CELL_COMPOSE_DESCRIPTORS.platform.envFile);
  assert.deepEqual(services.stdout.trim().split(/\s+/), CELL_COMPOSE_SERVICES.platform);
  assert.deepEqual(CELL_COMPOSE_SERVICES.platform, [
    "access-database-bootstrap",
    "access-migrations",
    "access-role-bootstrap",
    "audit-database-bootstrap",
    "audit-migrations",
    "audit-role-bootstrap",
    "identity-service",
    "tenant-service",
    "audit-service",
    "platform-admin-bff",
    "platform-admin-console"
  ]);
  assert.equal(smokeService.stdout.trim(), CELL_SMOKE_TARGETS.platform.service);
  assert.equal(smokeArtifact.stdout.trim(), CELL_SMOKE_TARGETS.platform.artifact);
  assert.deepEqual(CELL_SMOKE_TARGETS.platform, {
    service: "platform-admin-bff",
    artifact: "apps/platform-admin-bff/dist/index.js",
    containerPort: 8098,
    expectedService: "platform-admin-bff",
    audience: "platform-admin-bff"
  });
});

test("the NOVA Compose plan uses only the provider-owned standalone descriptor", () => {
  const invoke = (output) =>
    spawnSync(process.execPath, ["scripts/ci/cell-compose-plan.mjs", "nova", output], {
      cwd: root,
      encoding: "utf8"
    });

  const composeFile = invoke("compose-file");
  const envFile = invoke("env-file");
  assert.equal(composeFile.status, 0, composeFile.stderr);
  assert.equal(envFile.status, 0, envFile.stderr);
  assert.deepEqual(CELL_COMPOSE_DESCRIPTORS.nova, {
    composeFile: "infra/docker-compose.nova.yml",
    envFile: "infra/nova.env.example"
  });
  assert.equal(composeFile.stdout.trim(), CELL_COMPOSE_DESCRIPTORS.nova.composeFile);
  assert.equal(envFile.stdout.trim(), CELL_COMPOSE_DESCRIPTORS.nova.envFile);
});

test("the LUMEN Compose plan keeps one-shots in scope while smoke targets the BFF", () => {
  const invoke = (output) =>
    spawnSync(process.execPath, ["scripts/ci/cell-compose-plan.mjs", "lumen", output], {
      cwd: root,
      encoding: "utf8"
    });

  const services = invoke("services");
  assert.equal(services.status, 0, services.stderr);
  assert.deepEqual(services.stdout.trim().split(/\s+/), CELL_COMPOSE_SERVICES.lumen);
  assert.deepEqual(CELL_COMPOSE_SERVICES.lumen.slice(0, 3), [
    "lumen-database-bootstrap",
    "lumen-migrations",
    "lumen-role-bootstrap"
  ]);

  const smokeService = invoke("smoke-service");
  const smokeArtifact = invoke("smoke-artifact");
  assert.equal(smokeService.status, 0, smokeService.stderr);
  assert.equal(smokeArtifact.status, 0, smokeArtifact.stderr);
  assert.equal(smokeService.stdout.trim(), CELL_SMOKE_TARGETS.lumen.service);
  assert.equal(smokeArtifact.stdout.trim(), CELL_SMOKE_TARGETS.lumen.artifact);
  assert.deepEqual(CELL_SMOKE_TARGETS.lumen, {
    service: "lumen-bff",
    artifact: "apps/lumen-bff/dist/index.js",
    containerPort: 8096,
    expectedService: "lumen-bff",
    audience: "lumen-bff"
  });

  const composeFile = invoke("compose-file");
  const envFile = invoke("env-file");
  assert.equal(composeFile.status, 0, composeFile.stderr);
  assert.equal(envFile.status, 0, envFile.stderr);
  assert.equal(composeFile.stdout.trim(), CELL_COMPOSE_DESCRIPTORS.lumen.composeFile);
  assert.equal(envFile.stdout.trim(), CELL_COMPOSE_DESCRIPTORS.lumen.envFile);
  assert.deepEqual(CELL_COMPOSE_DESCRIPTORS.lumen, {
    composeFile: "infra/docker-compose.lumen.yml",
    envFile: "infra/lumen.env.example"
  });
});

test("the PULSO Compose plan is provider-owned and keeps database one-shots in scope", () => {
  const invoke = (output) =>
    spawnSync(process.execPath, ["scripts/ci/cell-compose-plan.mjs", "pulso", output], {
      cwd: root,
      encoding: "utf8"
    });

  const services = invoke("services");
  assert.equal(services.status, 0, services.stderr);
  assert.deepEqual(services.stdout.trim().split(/\s+/), CELL_COMPOSE_SERVICES.pulso);
  assert.deepEqual(CELL_COMPOSE_SERVICES.pulso.slice(0, 3), [
    "pulso-database-bootstrap",
    "pulso-migrations",
    "pulso-role-bootstrap"
  ]);

  const composeFile = invoke("compose-file");
  const envFile = invoke("env-file");
  assert.equal(composeFile.status, 0, composeFile.stderr);
  assert.equal(envFile.status, 0, envFile.stderr);
  assert.deepEqual(CELL_COMPOSE_DESCRIPTORS.pulso, {
    composeFile: "infra/docker-compose.pulso.yml",
    envFile: "infra/pulso.env.example"
  });
  assert.equal(composeFile.stdout.trim(), CELL_COMPOSE_DESCRIPTORS.pulso.composeFile);
  assert.equal(envFile.stdout.trim(), CELL_COMPOSE_DESCRIPTORS.pulso.envFile);
});

test("the NOVA PR workflow exercises a real isolated PostgreSQL bootstrap, migration and role smoke", async () => {
  const workflow = await readFile(path.join(workflowRoot, "_cell-ci.yml"), "utf8");
  const start = workflow.indexOf("  nova-database-smoke:");
  const end = workflow.indexOf("\n  image:", start);
  assert.ok(start >= 0 && end > start);
  const job = workflow.slice(start, end);
  assert.match(job, /if: inputs\.cell == 'nova'/);
  assert.match(job, /image: postgres:16-alpine/);
  assert.match(job, /bootstrap:database/);
  assert.match(job, /@hyperion\/nova-migrations migrate/);
  assert.match(job, /bootstrap:roles/);
  assert.match(job, /autonomy\.integration\.test\.ts/);
  assert.match(job, /outbox\.integration\.test\.ts/);
  assert.match(job, /NOVA_POSTGRES_DB=hyperion_nova_ci[\s\S]*bootstrap:roles/);
  assert.match(job, /TEST_NOVA_DATABASE_URL/);
  assert.match(job, /TEST_VOICE_DATABASE_URL/);
  assert.match(job, /TEST_LIWA_DATABASE_URL/);
  assert.match(job, /TEST_DOCUMENTS_DATABASE_URL/);
  assert.match(job, /postgres:\/\/hyperion_nova:\$\{NOVA_DATABASE_PASSWORD\}/);
  assert.match(job, /env -i /);
  assert.doesNotMatch(job, /LUMEN_|PULSO_|SOFIA_|INTEGRATION_|CHANNEL_/);
});

test("the LUMEN PR workflow runs its provider-owned PostgreSQL closure when affected", async () => {
  const workflow = await readFile(path.join(workflowRoot, "lumen.yml"), "utf8");
  const start = workflow.indexOf("  database:");
  const end = workflow.indexOf("\n  required:", start);
  assert.ok(start >= 0 && end > start);
  const job = workflow.slice(start, end);
  assert.match(job, /if: needs\.impact\.outputs\.affected == 'true'/);
  assert.match(job, /image: postgres:16-alpine/);
  assert.match(job, /@hyperion\/lumen-migrations/);
  assert.match(job, /bootstrap:database/);
  assert.match(job, /LUMEN_MIGRATOR_DATABASE_URL/);
  assert.match(job, /bootstrap:roles/);
  assert.match(job, /LUMEN_POSTGRES_DB=hyperion_lumen_ci/);
  assert.match(job, /autonomy\.integration\.test\.ts/);
  for (const integrationTest of [
    "lumen.integration.test.ts",
    "projection-events.integration.test.ts",
    "audio-cleanup-readiness.integration.test.ts"
  ]) {
    assert.match(job, new RegExp(integrationTest.replaceAll(".", "\\.")));
  }
  assert.match(job, /TEST_DATABASE_URL="\$lumen_runtime_url"/);
  assert.match(job, /TEST_LUMEN_FIXTURE_DATABASE_URL="\$lumen_fixture_url"/);
  assert.match(job, /EXPECTED_DATABASE_ROLE=hyperion_lumen/);
  assert.match(job, /numTotalTests/);
  assert.match(job, /total:22,passed:22,failed:0,pending:0/);
  assert.match(job, /pnpm ops:lumen:postgres:recovery:test/);
  assert.doesNotMatch(job, /NOVA_|PULSO_|SOFIA_|INTEGRATION_|CHANNEL_/);

  const required = workflow.slice(end);
  assert.match(required, /needs: \[impact, cell, database\]/);
  assert.match(required, /if: needs\.impact\.outputs\.affected == 'true'/);
  assert.match(required, /DATABASE_RESULT: \$\{\{ needs\.database\.result \}\}/);
  assert.match(required, /test "\$DATABASE_RESULT" = "success"/);
});

test("the PULSO PR workflow runs its provider-owned PostgreSQL closure when affected", async () => {
  const workflow = await readFile(path.join(workflowRoot, "pulso.yml"), "utf8");
  const start = workflow.indexOf("  database:");
  const end = workflow.indexOf("\n  required:", start);
  assert.ok(start >= 0 && end > start);
  const job = workflow.slice(start, end);
  assert.match(job, /if: needs\.impact\.outputs\.affected == 'true'/);
  assert.match(job, /image: postgres:16-alpine/);
  assert.match(job, /cell-install-plan\.mjs --cell pulso/);
  for (const packageName of [
    "@hyperion/pulso-migrations",
    "@hyperion/pulso-iris-service",
    "@hyperion/agent-service",
    "@hyperion/prompt-flow-service",
    "@hyperion/whatsapp-channel-service"
  ]) {
    assert.match(job, new RegExp(`--package ${packageName.replaceAll("/", "\\/")}`));
  }
  assert.match(job, /--package @hyperion\/whatsapp-channel-service --execute/);
  assert.match(job, /Build PULSO runtime integration closures/);
  assert.match(job, /--filter @hyperion\/pulso-iris-service\.\.\./);
  assert.match(job, /--filter @hyperion\/agent-service\.\.\./);
  assert.match(job, /--filter @hyperion\/prompt-flow-service\.\.\./);
  assert.match(job, /--filter @hyperion\/whatsapp-channel-service\.\.\. build/);
  assert.match(job, /@hyperion\/pulso-migrations/);
  assert.match(job, /bootstrap:database/);
  assert.match(job, /PULSO_MIGRATOR_DATABASE_URL/);
  assert.match(job, /bootstrap:roles/);
  assert.equal(job.match(/PULSO_MIGRATION_PHASE=contract/g)?.length, 2);
  assert.match(job, /PULSO_POSTGRES_DB=hyperion_pulso_n1_fixture_ci/);
  assert.match(job, /const names=\['PULSO_MIGRATOR','PULSO','SOFIA','KNOWLEDGE','INTEGRATION','CHANNEL'\]/);
  for (const secret of [
    "PULSO_MIGRATOR_DATABASE_PASSWORD",
    "PULSO_DATABASE_PASSWORD",
    "SOFIA_DATABASE_PASSWORD",
    "KNOWLEDGE_DATABASE_PASSWORD",
    "INTEGRATION_DATABASE_PASSWORD",
    "CHANNEL_DATABASE_PASSWORD"
  ]) {
    assert.match(job, new RegExp(secret));
  }
  for (const role of [
    "hyperion_pulso",
    "hyperion_sofia",
    "hyperion_knowledge",
    "hyperion_integration",
    "hyperion_channel"
  ]) {
    assert.match(job, new RegExp(`postgres:\\/\\/${role}:\\$\\{`));
  }
  for (const databaseUrl of [
    "TEST_PULSO_MIGRATOR_DATABASE_URL",
    "TEST_PULSO_DATABASE_URL",
    "TEST_SOFIA_DATABASE_URL",
    "TEST_KNOWLEDGE_DATABASE_URL",
    "TEST_INTEGRATION_DATABASE_URL",
    "TEST_CHANNEL_DATABASE_URL",
    "TEST_PULSO_FIXTURE_DATABASE_URL"
  ]) {
    assert.match(job, new RegExp(databaseUrl));
  }
  assert.match(job, /autonomy\.integration\.test\.ts/);
  const autonomyStart = job.indexOf("Verify autonomous PULSO catalog and five runtime privilege fences");
  const fixtureStart = job.indexOf("Assert frozen SOFIA 002 readiness is revoked by the current contract");
  const runtimeStart = job.indexOf("Run all 94 PULSO runtime PostgreSQL integrations with fenced roles");
  assert.ok(autonomyStart >= 0 && fixtureStart > autonomyStart && runtimeStart > fixtureStart);
  const autonomyStep = job.slice(autonomyStart, fixtureStart);
  assert.match(autonomyStep, /REQUIRE_PULSO_READINESS_ACCEPTANCE=1/);
  assert.match(autonomyStep, /PULSO_READINESS_ACCEPTANCE_DATABASE_NAME=hyperion_pulso_n1_fixture_ci/);
  const fixtureStep = job.slice(fixtureStart, runtimeStart);
  assert.match(fixtureStep, /env -i /);
  assert.match(fixtureStep, /REQUIRE_SOFIA_N_MINUS_ONE_FIXTURE=1/);
  assert.match(fixtureStep, /SOFIA_N_MINUS_ONE_FIXTURE_DATABASE_NAME=hyperion_pulso_n1_fixture_ci/);
  assert.match(fixtureStep, /TEST_PULSO_MIGRATOR_DATABASE_URL="\$pulso_migrator_url"/);
  assert.match(fixtureStep, /TEST_SOFIA_DATABASE_URL="\$sofia_runtime_url"/);
  assert.match(fixtureStep, /@hyperion\/service-runtime exec vitest run/);
  assert.match(fixtureStep, /src\/sofia-n-minus-one-readiness\.integration\.test\.ts --no-file-parallelism/);
  assert.doesNotMatch(fixtureStep, /TEST_(?:PULSO|KNOWLEDGE|INTEGRATION|CHANNEL)_DATABASE_URL/);
  const runtimeEnd = job.indexOf("\n      - name:", runtimeStart);
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart);
  const runtimeStep = job.slice(runtimeStart, runtimeEnd);
  assert.match(runtimeStep, /TEST_PULSO_DATABASE_URL="\$pulso_runtime_url"/);
  assert.match(runtimeStep, /TEST_SOFIA_DATABASE_URL="\$sofia_runtime_url"/);
  assert.match(runtimeStep, /TEST_CHANNEL_DATABASE_URL="\$channel_runtime_url"/);
  assert.match(runtimeStep, /TEST_PULSO_FIXTURE_DATABASE_URL="\$pulso_fixture_url"/);
  assert.match(runtimeStep, /node scripts\/ci\/run-pulso-runtime-integrations\.mjs/);
  assert.match(runtimeStep, /env -i /);
  assert.doesNotMatch(runtimeStep, /TEST_(?:KNOWLEDGE|INTEGRATION)_DATABASE_URL/);
  assert.match(job, /pnpm ops:pulso:postgres:recovery:test/);
  assert.match(job, /env -i /);
  assert.doesNotMatch(job, /NOVA_|LUMEN_/);

  const required = workflow.slice(end);
  assert.match(required, /needs: \[impact, cell, database\]/);
  assert.match(required, /if: needs\.impact\.outputs\.affected == 'true'/);
  assert.match(required, /DATABASE_RESULT: \$\{\{ needs\.database\.result \}\}/);
  assert.match(required, /test "\$DATABASE_RESULT" = "success"/);
});

// Public-repository policy: compose the full-stack gate from provider-owned
// cell workflows instead of running current binaries against the legacy DB.
test("the federated full stack runs on main, schedule and manual dispatch", async () => {
  const workflow = await readFile(path.join(workflowRoot, "check.yml"), "utf8");
  const packageManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const triggerBlock = workflow.slice(0, workflow.indexOf("permissions:"));
  assert.match(triggerBlock, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(triggerBlock, /^\s+pull_request:/m);
  assert.match(triggerBlock, /^\s+push:/m);
  assert.match(triggerBlock, /^\s+schedule:/m);
  assert.match(triggerBlock, /cron:\s*["']17 3 \* \* \*["']/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /run:\s*pnpm federation:test\s*$/m);
  for (const cell of ["platform", "nova", "lumen", "pulso"]) {
    assert.match(workflow, new RegExp(`uses: \\.\\/.github/workflows/_cell-ci\\.yml[\\s\\S]*?cell: ${cell}`));
  }
  assert.match(workflow, /name: full-stack \/ required/);
  assert.match(
    workflow,
    /needs: \[workspace, platform, nova, lumen, pulso, lumen-database, pulso-database\]/
  );
  assert.match(workflow, /uses: \.\/\.github\/workflows\/_lumen-database\.yml/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/_pulso-database\.yml/);
  assert.match(workflow, /LUMEN_DATABASE_RESULT: \$\{\{ needs\.lumen-database\.result \}\}/);
  assert.match(workflow, /PULSO_DATABASE_RESULT: \$\{\{ needs\.pulso-database\.result \}\}/);
  assert.doesNotMatch(workflow, /infra\/docker-compose\.yml/);
  assert.doesNotMatch(workflow, /n-minus-one-upgrade-rollback/);
  assert.equal(
    packageManifest.scripts["federation:nova:extraction:rehearse"],
    "node scripts/federation/rehearse-nova-repository-extraction.mjs"
  );
  assert.match(
    packageManifest.scripts["federation:test"],
    /scripts\/federation\/rehearse-nova-repository-extraction\.test\.mjs/
  );
  const prerequisite = workflow.indexOf("git-filter-repo==2.47.0");
  const federationTests = workflow.indexOf("run: pnpm federation:test");
  assert.ok(prerequisite >= 0, "full-stack CI must install an exact git-filter-repo version");
  assert.ok(prerequisite < federationTests, "git-filter-repo must be available before federation tests");
});

test("Audit integration tests are pinned to the provider-owned logical database", async () => {
  const fullStackWorkflow = await readFile(path.join(workflowRoot, "legacy-monolith-diagnostic.yml"), "utf8");
  const reusableWorkflow = await readFile(path.join(workflowRoot, "_cell-ci.yml"), "utf8");
  const auditIntegrationSources = await Promise.all(
    ["internal-events.integration.test.ts", "readiness.integration.test.ts"].map((file) =>
      readFile(path.join(root, "services", "audit-service", "src", file), "utf8")
    )
  );

  for (const source of auditIntegrationSources) {
    assert.match(source, /process\.env\.TEST_AUDIT_DATABASE_URL/);
    assert.doesNotMatch(source, /process\.env\.TEST_DATABASE_URL/);
  }

  const checkJobStart = fullStackWorkflow.indexOf("  check:");
  const checkJobEnd = fullStackWorkflow.indexOf("  docker-build-and-smoke:", checkJobStart);
  const fullStackCheckJob = fullStackWorkflow.slice(checkJobStart, checkJobEnd);
  const recursiveTestStart = fullStackCheckJob.indexOf("      - name: Test\n");
  assert.ok(recursiveTestStart >= 0, "full-stack CI must retain the recursive test suite");
  const fullStackTest = fullStackCheckJob.slice(recursiveTestStart);
  assert.match(
    fullStackCheckJob,
    /Verify provider-owned Audit readiness and idempotency[\s\S]*TEST_AUDIT_DATABASE_URL="\$audit_runtime_url"[\s\S]*pnpm --filter @hyperion\/audit-service exec vitest run[\s\S]*src\/readiness\.integration\.test\.ts src\/internal-events\.integration\.test\.ts/
  );
  assert.doesNotMatch(fullStackTest, /TEST_AUDIT_DATABASE_URL/);
  assert.match(fullStackTest, /run: pnpm -r test/);
  assert.match(fullStackTest, /TEST_DATABASE_URL: postgres:\/\/hyperion:hyperion_test@localhost:5432\/hyperion_test/);

  const auditJobStart = reusableWorkflow.indexOf("  audit-database-smoke:");
  const auditJobEnd = reusableWorkflow.indexOf("\n  image:", auditJobStart);
  assert.ok(auditJobStart >= 0 && auditJobEnd > auditJobStart);
  const auditJob = reusableWorkflow.slice(auditJobStart, auditJobEnd);
  assert.match(auditJob, /TEST_AUDIT_DATABASE_URL="\$audit_runtime_url"/);
  assert.doesNotMatch(auditJob, /TEST_DATABASE_URL="\$audit_runtime_url"/);
});

test("workflow actions are immutable SHA references", async () => {
  const workflowFiles = (await readdir(workflowRoot)).filter((entry) => entry.endsWith(".yml"));
  const mutable = [];
  for (const workflowFile of workflowFiles) {
    const contents = await readFile(path.join(workflowRoot, workflowFile), "utf8");
    for (const match of contents.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
      const reference = match[1];
      if (reference.startsWith("./")) continue;
      if (!/@[0-9a-f]{40}$/i.test(reference)) mutable.push(`${workflowFile}: ${reference}`);
    }
  }
  assert.deepEqual(mutable, []);
});

test("mutating release workflows serialize without cancellation while CI workflows cancel obsolete runs", async () => {
  const workflowFiles = (await readdir(workflowRoot)).filter(
    (entry) => entry.endsWith(".yml") && !entry.startsWith("_")
  );
  const nonCancellableMutationWorkflows = new Set([
    "build-attested-cell-images.yml",
    "publish-provider-contracts.yml",
    "publish-shared-libraries.yml",
    "publish-release.yml"
  ]);
  const invalidConcurrency = [];
  for (const workflowFile of workflowFiles) {
    const contents = await readFile(path.join(workflowRoot, workflowFile), "utf8");
    const expected = nonCancellableMutationWorkflows.has(workflowFile) ? "false" : "true";
    if (!new RegExp(`concurrency:[\\s\\S]*?cancel-in-progress:\\s*${expected}`).test(contents)) {
      invalidConcurrency.push(`${workflowFile}: expected ${expected}`);
    }
  }
  assert.deepEqual(invalidConcurrency, []);
});

// Public-repository policy: security workflows cover PRs, main, schedules and
// manual recovery. Manual Gitleaks dispatch still scans the full history.
test("security workflows cover pull requests, main, schedules and manual dispatch", async () => {
  const containerScan = await readFile(path.join(workflowRoot, "container-scan.yml"), "utf8");
  const triggerBlock = containerScan.slice(0, containerScan.indexOf("permissions:"));
  assert.match(triggerBlock, /^\s+pull_request:/m);
  assert.match(triggerBlock, /^\s+workflow_dispatch:/m);
  assert.match(triggerBlock, /^\s+push:/m);
  assert.match(triggerBlock, /^\s+schedule:/m);
  assert.match(triggerBlock, /cron:\s*["']11 9 \* \* 3["']/);
  assert.doesNotMatch(triggerBlock, /^\s+paths:/m);
  assert.match(containerScan, /name: container images \/ required/);
  assert.match(containerScan, /needs: \[impact, scan\]/);
  assert.match(containerScan, /if: always\(\)/);
  assert.match(containerScan, /test "\$SCAN_RESULT" = "skipped"/);

  const gitleaks = await readFile(path.join(workflowRoot, "gitleaks.yml"), "utf8");
  const gitleaksTriggers = gitleaks.slice(0, gitleaks.indexOf("permissions:"));
  assert.match(gitleaksTriggers, /^\s+pull_request:/m);
  assert.match(gitleaksTriggers, /^\s+workflow_dispatch:/m);
  assert.match(gitleaksTriggers, /^\s+push:/m);
  assert.match(gitleaksTriggers, /^\s+schedule:/m);
  assert.match(gitleaksTriggers, /cron:\s*["']43 8 \* \* 2["']/);
  assert.match(gitleaks, /EVENT_NAME" == "schedule" \|\| "\$EVENT_NAME" == "workflow_dispatch"/);
  assert.match(gitleaks, /range="--all"/);

  const codeql = await readFile(path.join(workflowRoot, "codeql.yml"), "utf8");
  const codeqlTriggers = codeql.slice(0, codeql.indexOf("permissions:"));
  assert.match(codeqlTriggers, /^\s+pull_request:/m);
  assert.match(codeqlTriggers, /^\s+workflow_dispatch:/m);
  assert.match(codeqlTriggers, /^\s+push:/m);
  assert.match(codeqlTriggers, /^\s+schedule:/m);
  assert.match(codeqlTriggers, /cron:\s*["']17 8 \* \* 2["']/);

  const dependencyAudit = await readFile(path.join(workflowRoot, "dependency-audit.yml"), "utf8");
  const dependencyAuditTriggers = dependencyAudit.slice(0, dependencyAudit.indexOf("permissions:"));
  assert.match(dependencyAuditTriggers, /^\s+pull_request:/m);
  assert.match(dependencyAuditTriggers, /^\s+workflow_dispatch:/m);
  assert.match(dependencyAuditTriggers, /^\s+push:/m);
  assert.match(dependencyAuditTriggers, /^\s+schedule:/m);
  assert.match(dependencyAuditTriggers, /cron:\s*["']29 8 \* \* 2["']/);
  assert.match(dependencyAudit, /^\s+contents:\s*read\s*$/m);
  assert.match(dependencyAudit, /run:\s*pnpm security:audit:prod/);
});

test("Dependabot covers every directory that owns a Docker manifest", async () => {
  const dependabot = await readFile(path.join(root, ".github", "dependabot.yml"), "utf8");
  const pullRequestLimits = [...dependabot.matchAll(/^\s+open-pull-requests-limit:\s*(\d+)\s*$/gm)].map((match) =>
    Number(match[1])
  );
  assert.ok(pullRequestLimits.length > 0);
  assert.ok(pullRequestLimits.every((limit) => limit > 0 && limit <= 5));
  const configuredDirectories = new Set(
    [...dependabot.matchAll(/^\s+directory:\s+"([^"]+)"\s*$/gm)].map((match) => match[1])
  );
  const requiredDirectories = [
    "/infra",
    "/infra/docker",
    "/infra/docker/cells",
    "/infra/docker/hostname-edge",
    "/infra/docker/legacy",
    "/apps/coopfuturo-console"
  ];
  assert.deepEqual(
    requiredDirectories.filter((directory) => !configuredDirectories.has(directory)),
    []
  );
});
