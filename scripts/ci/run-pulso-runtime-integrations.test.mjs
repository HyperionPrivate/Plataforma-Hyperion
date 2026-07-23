import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  PULSO_RUNTIME_INTEGRATION_SUITES,
  createPulsoRuntimeSuiteExecution,
  verifyPulsoRuntimeIntegrationReports,
  verifyPulsoRuntimeSuiteInventory,
  verifyPulsoRuntimeSuiteReport
} from "./run-pulso-runtime-integrations.mjs";

const root = process.cwd();
const databaseUrls = Object.freeze({
  TEST_PULSO_DATABASE_URL: "postgres://hyperion_pulso:pulso-secret@localhost:5432/hyperion_pulso_ci",
  TEST_SOFIA_DATABASE_URL: "postgres://hyperion_sofia:sofia-secret@localhost:5432/hyperion_pulso_ci",
  TEST_CHANNEL_DATABASE_URL: "postgres://hyperion_channel:channel-secret@localhost:5432/hyperion_pulso_ci",
  TEST_PULSO_FIXTURE_DATABASE_URL: "postgres://hyperion:fixture-secret@localhost:5432/hyperion_pulso_ci"
});

function passingReport(suite) {
  const total = suite.files.reduce((sum, file) => sum + file.tests, 0);
  return {
    numTotalTests: total,
    numPassedTests: total,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: suite.files.map((file) => ({
      name: path.join(root, suite.packageDirectory, file.path),
      status: "passed",
      assertionResults: Array.from({ length: file.tests }, (_, index) => ({
        fullName: `${file.path} assertion ${index + 1}`,
        status: "passed"
      }))
    }))
  };
}

test("PULSO runtime suites use only their fenced database role and execute every pinned file", () => {
  assert.deepEqual(
    PULSO_RUNTIME_INTEGRATION_SUITES.map((suite) => ({
      name: suite.name,
      role: suite.expectedDatabaseRole,
      databaseUrlEnvironment: suite.databaseUrlEnvironment,
      files: suite.files.length,
      tests: suite.files.reduce((sum, file) => sum + file.tests, 0)
    })),
    [
      {
        name: "pulso-iris",
        role: "hyperion_pulso",
        databaseUrlEnvironment: "TEST_PULSO_DATABASE_URL",
        files: 8,
        tests: 63
      },
      {
        name: "agent",
        role: "hyperion_sofia",
        databaseUrlEnvironment: "TEST_SOFIA_DATABASE_URL",
        files: 3,
        tests: 13
      },
      {
        name: "whatsapp-channel",
        role: "hyperion_channel",
        databaseUrlEnvironment: "TEST_CHANNEL_DATABASE_URL",
        files: 3,
        tests: 18
      }
    ]
  );

  for (const suite of PULSO_RUNTIME_INTEGRATION_SUITES) {
    assert.deepEqual(verifyPulsoRuntimeSuiteInventory(suite, root), suite.files.map((file) => file.path).sort());
    const outputFile = path.join(root, "tmp", `${suite.name}.json`);
    const execution = createPulsoRuntimeSuiteExecution(
      suite,
      { ...databaseUrls, UNRELATED_SENTINEL: "preserved" },
      outputFile,
      root
    );
    assert.equal(execution.env.TEST_DATABASE_URL, undefined);
    assert.equal(new URL(execution.env[suite.databaseUrlEnvironment]).username, suite.expectedDatabaseRole);
    assert.equal(new URL(execution.env.TEST_PULSO_FIXTURE_DATABASE_URL).username, "hyperion");
    assert.equal(execution.env.EXPECTED_DATABASE_ROLE, suite.expectedDatabaseRole);
    assert.equal(execution.env.UNRELATED_SENTINEL, "preserved");
    for (const databaseUrlEnvironment of Object.keys(databaseUrls)) {
      const expectedFixtureUrl =
        databaseUrlEnvironment === "TEST_PULSO_FIXTURE_DATABASE_URL"
          ? databaseUrls.TEST_PULSO_FIXTURE_DATABASE_URL
          : databaseUrlEnvironment === suite.databaseUrlEnvironment
            ? databaseUrls[databaseUrlEnvironment]
            : undefined;
      assert.equal(execution.env[databaseUrlEnvironment], expectedFixtureUrl);
    }
    for (const file of suite.files) {
      assert(execution.args.includes(file.path));
      const source = readFileSync(path.join(root, suite.packageDirectory, file.path), "utf8");
      assert.match(source, new RegExp(`process\\.env\\.${suite.databaseUrlEnvironment}`));
      assert.doesNotMatch(source, /process\.env\.TEST_DATABASE_URL/);
    }
    assert(execution.args.includes("--no-file-parallelism"));
    assert(execution.args.includes("--reporter=json"));
    assert(!execution.args.includes("--passWithNoTests"));
  }

  const incompleteInventory = {
    ...PULSO_RUNTIME_INTEGRATION_SUITES[0],
    files: PULSO_RUNTIME_INTEGRATION_SUITES[0].files.slice(1)
  };
  assert.throws(
    () => verifyPulsoRuntimeSuiteInventory(incompleteInventory, root),
    /integration file inventory changed/
  );
});

test("PULSO runtime suite execution rejects a URL for a different database role", () => {
  const suite = PULSO_RUNTIME_INTEGRATION_SUITES[0];
  assert.throws(
    () =>
      createPulsoRuntimeSuiteExecution(
        suite,
        { [suite.databaseUrlEnvironment]: databaseUrls.TEST_SOFIA_DATABASE_URL },
        path.join(root, "tmp", "wrong-role.json"),
        root
      ),
    /must authenticate as hyperion_pulso/
  );
});

test("PULSO fixture setup requires an admin URL for the exact runtime database", () => {
  const suite = PULSO_RUNTIME_INTEGRATION_SUITES[0];
  assert.throws(
    () =>
      createPulsoRuntimeSuiteExecution(
        suite,
        { [suite.databaseUrlEnvironment]: databaseUrls.TEST_PULSO_DATABASE_URL },
        path.join(root, "tmp", "missing-fixture.json"),
        root
      ),
    /TEST_PULSO_FIXTURE_DATABASE_URL is required/
  );
  assert.throws(
    () =>
      createPulsoRuntimeSuiteExecution(
        suite,
        {
          ...databaseUrls,
          TEST_PULSO_FIXTURE_DATABASE_URL: "postgres://hyperion_pulso:pulso-secret@localhost:5432/hyperion_pulso_ci"
        },
        path.join(root, "tmp", "runtime-as-fixture.json"),
        root
      ),
    /must authenticate as hyperion/
  );
  assert.throws(
    () =>
      createPulsoRuntimeSuiteExecution(
        suite,
        {
          ...databaseUrls,
          TEST_PULSO_FIXTURE_DATABASE_URL: "postgres://hyperion:fixture-secret@localhost:5432/another_database"
        },
        path.join(root, "tmp", "wrong-database.json"),
        root
      ),
    /must target the same PostgreSQL host, port and database/
  );
});

test("PULSO runtime reports require all 94 tests in all 14 files to pass", () => {
  const reports = new Map(PULSO_RUNTIME_INTEGRATION_SUITES.map((suite) => [suite.name, passingReport(suite)]));
  assert.deepEqual(verifyPulsoRuntimeIntegrationReports(reports, root), {
    suites: 3,
    files: 14,
    total: 94,
    passed: 94,
    failed: 0,
    pending: 0,
    todo: 0
  });
});

test("PULSO runtime report verification rejects skips, count drift and missing files", () => {
  const suite = PULSO_RUNTIME_INTEGRATION_SUITES[0];

  const skipped = passingReport(suite);
  skipped.testResults[0].assertionResults[0].status = "skipped";
  assert.throws(() => verifyPulsoRuntimeSuiteReport(suite, skipped, root), /skipped, todo or failed assertions/);

  const countDrift = passingReport(suite);
  countDrift.testResults[0].assertionResults.push({ fullName: "unreviewed new test", status: "passed" });
  assert.throws(
    () => verifyPulsoRuntimeSuiteReport(suite, countDrift, root),
    /expected 13 tests but Vitest reported 14/
  );

  const missingFile = passingReport(suite);
  missingFile.testResults.pop();
  assert.throws(() => verifyPulsoRuntimeSuiteReport(suite, missingFile, root), /was not executed/);
});
