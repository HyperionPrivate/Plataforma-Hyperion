#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DATABASE_URL_ENVIRONMENTS = Object.freeze([
  "TEST_PULSO_DATABASE_URL",
  "TEST_SOFIA_DATABASE_URL",
  "TEST_CHANNEL_DATABASE_URL",
  "TEST_PULSO_FIXTURE_DATABASE_URL"
]);
const OUTPUT_DIRECTORY_PREFIX = "hyperion-pulso-runtime-integrations-";

export const PULSO_RUNTIME_INTEGRATION_SUITES = Object.freeze([
  Object.freeze({
    name: "pulso-iris",
    packageName: "@hyperion/pulso-iris-service",
    packageDirectory: "services/pulso-iris-service",
    databaseUrlEnvironment: "TEST_PULSO_DATABASE_URL",
    expectedDatabaseRole: "hyperion_pulso",
    fixtureDatabaseUrlEnvironment: "TEST_PULSO_FIXTURE_DATABASE_URL",
    expectedFixtureDatabaseRole: "hyperion",
    files: Object.freeze([
      Object.freeze({ path: "src/appointment-routes.integration.test.ts", tests: 13 }),
      Object.freeze({ path: "src/audit-client.integration.test.ts", tests: 5 }),
      Object.freeze({ path: "src/channel-delivery-events.integration.test.ts", tests: 8 }),
      Object.freeze({ path: "src/channel-inbound-events.integration.test.ts", tests: 2 }),
      Object.freeze({ path: "src/config-routes.integration.test.ts", tests: 8 }),
      Object.freeze({ path: "src/pulso-outbox-ordering.integration.test.ts", tests: 1 }),
      Object.freeze({ path: "src/sofia-tools-routes.integration.test.ts", tests: 5 }),
      Object.freeze({ path: "src/tenant-isolation.integration.test.ts", tests: 21 })
    ])
  }),
  Object.freeze({
    name: "agent",
    packageName: "@hyperion/agent-service",
    packageDirectory: "services/agent-service",
    databaseUrlEnvironment: "TEST_SOFIA_DATABASE_URL",
    expectedDatabaseRole: "hyperion_sofia",
    fixtureDatabaseUrlEnvironment: "TEST_PULSO_FIXTURE_DATABASE_URL",
    expectedFixtureDatabaseRole: "hyperion",
    files: Object.freeze([
      Object.freeze({ path: "src/pulso-events.integration.test.ts", tests: 3 }),
      Object.freeze({ path: "src/sofia-ordering.integration.test.ts", tests: 2 }),
      Object.freeze({ path: "src/sofia-tools.integration.test.ts", tests: 8 })
    ])
  }),
  Object.freeze({
    name: "whatsapp-channel",
    packageName: "@hyperion/whatsapp-channel-service",
    packageDirectory: "services/whatsapp-channel-service",
    databaseUrlEnvironment: "TEST_CHANNEL_DATABASE_URL",
    expectedDatabaseRole: "hyperion_channel",
    fixtureDatabaseUrlEnvironment: "TEST_PULSO_FIXTURE_DATABASE_URL",
    expectedFixtureDatabaseRole: "hyperion",
    files: Object.freeze([
      Object.freeze({ path: "src/access-tenant-projections.integration.test.ts", tests: 2 }),
      Object.freeze({ path: "src/channel-outbox-ordering.integration.test.ts", tests: 1 }),
      Object.freeze({ path: "src/channel-repository.integration.test.ts", tests: 15 })
    ])
  })
]);

function pnpmExecutable() {
  return process.platform === "win32" ? "pnpm.exe" : "pnpm";
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function discoverIntegrationTestFiles(directory, packageDirectory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discoverIntegrationTestFiles(absolute, packageDirectory));
    else if (/\.(?:integration|e2e)\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      files.push(normalizePath(path.relative(packageDirectory, absolute)));
    }
  }
  return files.sort();
}

function expectedTestCount(suite) {
  return suite.files.reduce((total, file) => total + file.tests, 0);
}

export function verifyPulsoRuntimeSuiteInventory(suite, root = process.cwd()) {
  const packageDirectory = path.join(root, suite.packageDirectory);
  const actual = discoverIntegrationTestFiles(path.join(packageDirectory, "src"), packageDirectory);
  const expected = suite.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${suite.name}: integration file inventory changed; expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`
    );
  }
  return actual;
}

function removeOutputDirectory(outputDirectory) {
  const resolvedTemporaryRoot = path.resolve(os.tmpdir());
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  if (
    path.dirname(resolvedOutputDirectory) !== resolvedTemporaryRoot ||
    !path.basename(resolvedOutputDirectory).startsWith(OUTPUT_DIRECTORY_PREFIX)
  ) {
    throw new Error(`Refusing to remove an unexpected integration output directory: ${resolvedOutputDirectory}`);
  }
  rmSync(resolvedOutputDirectory, { recursive: true, force: true });
}

function validatedDatabaseUrl(suite, environment) {
  const raw = environment[suite.databaseUrlEnvironment]?.trim();
  if (!raw) throw new Error(`${suite.databaseUrlEnvironment} is required for the ${suite.name} integration suite`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${suite.databaseUrlEnvironment} must be a valid PostgreSQL URL`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error(`${suite.databaseUrlEnvironment} must use the postgres or postgresql protocol`);
  }
  if (decodeURIComponent(parsed.username) !== suite.expectedDatabaseRole) {
    throw new Error(
      `${suite.databaseUrlEnvironment} must authenticate as ${suite.expectedDatabaseRole}, not another database role`
    );
  }
  return raw;
}

function validatedFixtureDatabaseUrl(suite, environment, runtimeDatabaseUrl) {
  if (!suite.fixtureDatabaseUrlEnvironment) return undefined;
  const raw = environment[suite.fixtureDatabaseUrlEnvironment]?.trim();
  if (!raw) {
    throw new Error(`${suite.fixtureDatabaseUrlEnvironment} is required for the ${suite.name} fixture setup`);
  }

  let fixture;
  try {
    fixture = new URL(raw);
  } catch {
    throw new Error(`${suite.fixtureDatabaseUrlEnvironment} must be a valid PostgreSQL URL`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(fixture.protocol)) {
    throw new Error(`${suite.fixtureDatabaseUrlEnvironment} must use the postgres or postgresql protocol`);
  }
  if (decodeURIComponent(fixture.username) !== suite.expectedFixtureDatabaseRole) {
    throw new Error(
      `${suite.fixtureDatabaseUrlEnvironment} must authenticate as ${suite.expectedFixtureDatabaseRole}, not another database role`
    );
  }

  const runtime = new URL(runtimeDatabaseUrl);
  const databaseEndpoint = (url) => `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  if (databaseEndpoint(fixture) !== databaseEndpoint(runtime)) {
    throw new Error(
      `${suite.fixtureDatabaseUrlEnvironment} must target the same PostgreSQL host, port and database as ${suite.databaseUrlEnvironment}`
    );
  }
  return raw;
}

export function createPulsoRuntimeSuiteExecution(suite, environment, outputFile, root = process.cwd()) {
  verifyPulsoRuntimeSuiteInventory(suite, root);
  const databaseUrl = validatedDatabaseUrl(suite, environment);
  const fixtureDatabaseUrl = validatedFixtureDatabaseUrl(suite, environment, databaseUrl);
  const childEnvironment = { ...environment };
  for (const name of DATABASE_URL_ENVIRONMENTS) delete childEnvironment[name];
  delete childEnvironment.TEST_DATABASE_URL;
  childEnvironment[suite.databaseUrlEnvironment] = databaseUrl;
  if (fixtureDatabaseUrl) childEnvironment.TEST_PULSO_FIXTURE_DATABASE_URL = fixtureDatabaseUrl;
  childEnvironment.EXPECTED_DATABASE_ROLE = suite.expectedDatabaseRole;
  childEnvironment.CI = "true";
  childEnvironment.NODE_ENV = "test";
  childEnvironment.HYPERION_ENVIRONMENT = "ci";

  return {
    executable: pnpmExecutable(),
    args: [
      "--filter",
      suite.packageName,
      "exec",
      "vitest",
      "run",
      ...suite.files.map((file) => file.path),
      "--no-file-parallelism",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${outputFile}`
    ],
    cwd: root,
    env: childEnvironment
  };
}

function reportFilePath(root, suite, resultName) {
  if (typeof resultName !== "string" || resultName.length === 0) return "<missing>";
  const absolute = path.isAbsolute(resultName) ? resultName : path.resolve(root, resultName);
  return normalizePath(path.relative(path.join(root, suite.packageDirectory), absolute));
}

export function verifyPulsoRuntimeSuiteReport(suite, report, root = process.cwd()) {
  if (!report || typeof report !== "object") throw new Error(`${suite.name}: Vitest did not produce a JSON object`);
  if (!Array.isArray(report.testResults)) throw new Error(`${suite.name}: Vitest report is missing testResults`);

  const expectedByFile = new Map(suite.files.map((file) => [file.path, file.tests]));
  const observedByFile = new Map();
  const nonPassingAssertions = [];

  for (const result of report.testResults) {
    const relativePath = reportFilePath(root, suite, result.name);
    if (observedByFile.has(relativePath)) throw new Error(`${suite.name}: duplicate Vitest result for ${relativePath}`);
    if (!expectedByFile.has(relativePath))
      throw new Error(`${suite.name}: unexpected integration test file ${relativePath}`);
    if (!Array.isArray(result.assertionResults)) {
      throw new Error(`${suite.name}: ${relativePath} is missing assertionResults`);
    }

    observedByFile.set(relativePath, result.assertionResults.length);
    for (const assertion of result.assertionResults) {
      if (assertion.status !== "passed") {
        nonPassingAssertions.push(
          `${relativePath}: ${assertion.fullName ?? assertion.title ?? "unnamed"} (${assertion.status})`
        );
      }
    }
  }

  for (const [file, expected] of expectedByFile) {
    if (!observedByFile.has(file))
      throw new Error(`${suite.name}: expected integration test file was not executed: ${file}`);
    const observed = observedByFile.get(file);
    if (observed !== expected) {
      throw new Error(`${suite.name}: ${file} expected ${expected} tests but Vitest reported ${observed}`);
    }
  }
  if (nonPassingAssertions.length > 0) {
    throw new Error(
      `${suite.name}: skipped, todo or failed assertions are forbidden:\n${nonPassingAssertions.join("\n")}`
    );
  }

  const expectedTotal = expectedTestCount(suite);
  const summary = {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests
  };
  const expectedSummary = { total: expectedTotal, passed: expectedTotal, failed: 0, pending: 0, todo: 0 };
  if (JSON.stringify(summary) !== JSON.stringify(expectedSummary) || report.success !== true) {
    throw new Error(
      `${suite.name}: unexpected Vitest summary ${JSON.stringify(summary)}; expected ${JSON.stringify(expectedSummary)}`
    );
  }

  return { suite: suite.name, files: suite.files.length, ...summary };
}

export function verifyPulsoRuntimeIntegrationReports(reports, root = process.cwd()) {
  const summaries = PULSO_RUNTIME_INTEGRATION_SUITES.map((suite) => {
    const report = reports.get(suite.name);
    if (!report) throw new Error(`Missing Vitest report for the ${suite.name} integration suite`);
    return verifyPulsoRuntimeSuiteReport(suite, report, root);
  });
  return summaries.reduce(
    (total, summary) => ({
      suites: total.suites + 1,
      files: total.files + summary.files,
      total: total.total + summary.total,
      passed: total.passed + summary.passed,
      failed: total.failed + summary.failed,
      pending: total.pending + summary.pending,
      todo: total.todo + summary.todo
    }),
    { suites: 0, files: 0, total: 0, passed: 0, failed: 0, pending: 0, todo: 0 }
  );
}

export function runPulsoRuntimeIntegrations(environment = process.env, root = process.cwd()) {
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), OUTPUT_DIRECTORY_PREFIX));
  const reports = new Map();
  try {
    const executions = PULSO_RUNTIME_INTEGRATION_SUITES.map((suite) => {
      const outputFile = path.join(outputDirectory, `${suite.name}.json`);
      return {
        suite,
        outputFile,
        execution: createPulsoRuntimeSuiteExecution(suite, environment, outputFile, root)
      };
    });
    for (const { suite, outputFile, execution } of executions) {
      process.stdout.write(
        `Running ${expectedTestCount(suite)} ${suite.name} PostgreSQL integrations as ${suite.expectedDatabaseRole}\n`
      );
      const result = spawnSync(execution.executable, execution.args, {
        cwd: execution.cwd,
        env: execution.env,
        stdio: "inherit",
        shell: false
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`${suite.name}: Vitest exited with status ${result.status ?? "unknown"}`);
      }
      reports.set(suite.name, JSON.parse(readFileSync(outputFile, "utf8")));
    }

    const summary = verifyPulsoRuntimeIntegrationReports(reports, root);
    process.stdout.write(`PULSO runtime integration result accepted: ${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    removeOutputDirectory(outputDirectory);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runPulsoRuntimeIntegrations();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
