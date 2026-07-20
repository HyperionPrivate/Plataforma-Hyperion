import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DRILL_CONFIRMATION,
  DOCKER_ROUTING_OVERRIDE_VARIABLES,
  EXPECTED_ACL_STATE,
  EXPECTED_MIGRATIONS,
  EXPECTED_OWNER_STATE,
  EXPECTED_SCHEMA_VERSION,
  EXPECTED_SOFIA_SCHEMA_VERSION,
  EXPECTED_USER_SCHEMA_STATE,
  RUNTIME_ACCESS_PROBES,
  RUNTIME_ROLES,
  assertDefaultDockerRouting,
  assertDockerInventoryPreserved,
  assertProjectAbsent,
  assertPulsoCatalogEvidence,
  assertSafeProjectName,
  expectedMigrationFiles,
  expectedProjectResourceNames,
  expectedRuntimeState,
  isExpectedRuntimeDdlDenial,
  listProjectResources,
  normalizeSchemaDump,
  parseArguments,
  parseDockerInventory,
  parseKeyValueOutput,
  parsePulsoMigrationReceipt,
  parsePulsoRoleReceipt,
  preflightDefaultDockerClient,
  renderIsolatedStandaloneCompose,
  resolveDockerIdentity
} from "./run-pulso-postgres-recovery-drill.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = "a".repeat(64);
const ledger = EXPECTED_MIGRATIONS.map((name) => `${name}\t${digest}`).join("\n");
const runtimeStates = Object.fromEntries(RUNTIME_ROLES.map((role) => [role, expectedRuntimeState(role)]));
const validCatalogEvidence = {
  aclState: EXPECTED_ACL_STATE,
  ledger,
  ownerState: EXPECTED_OWNER_STATE,
  runtimeStates,
  schemaVersion: EXPECTED_SCHEMA_VERSION,
  sofiaSchemaVersion: EXPECTED_SOFIA_SCHEMA_VERSION,
  userSchemas: EXPECTED_USER_SCHEMA_STATE
};

test("requires an exact opt-in confirmation and generates a scoped PULSO project", () => {
  const options = parseArguments(["--confirm", DRILL_CONFIRMATION], new Date("2026-07-18T12:34:56.000Z"), "deadbeef");
  assert.equal(options.operationId, "20260718T123456Z");
  assert.equal(options.project, "hyperion-pulso-recovery-acceptance-20260718t123456z-deadbeef");
  assert.throws(() => parseArguments(["--confirm", "yes"]), /--confirm must equal/);
});

test("accepts only a narrow unused Compose project", () => {
  assert.doesNotThrow(() => assertSafeProjectName("hyperion-pulso-recovery-acceptance-manual1"));
  assert.throws(() => assertSafeProjectName("plataforma-hyperion"), /--project must match/);
  assert.throws(
    () =>
      assertProjectAbsent(
        { containers: [], images: [], networks: ["occupied"], volumes: [] },
        "hyperion-pulso-recovery-acceptance-manual1"
      ),
    /already has resources/
  );
});

test("rejects every Docker routing override before invoking Docker", () => {
  for (const variable of DOCKER_ROUTING_OVERRIDE_VARIABLES) {
    let dockerCalls = 0;
    const environment = { [variable]: "" };
    assert.throws(
      () =>
        preflightDefaultDockerClient(environment, () => {
          dockerCalls += 1;
          return "";
        }),
      new RegExp(variable)
    );
    assert.equal(dockerCalls, 0, `${variable} reached Docker`);
    assert.throws(() => assertDefaultDockerRouting(environment), new RegExp(variable));
  }
});

test("seals an exact local Docker context and endpoint and rejects remote daemons", () => {
  const calls = [];
  const windowsIdentity = resolveDockerIdentity((args) => {
    calls.push(args);
    if (args[1] === "show") return "desktop-linux\n";
    return "npipe:////./pipe/dockerDesktopLinuxEngine\n";
  }, "win32");
  assert.deepEqual(windowsIdentity, {
    context: "desktop-linux",
    endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine"
  });
  assert.deepEqual(calls, [
    ["context", "show"],
    ["context", "inspect", "desktop-linux", "--format", "{{.Endpoints.docker.Host}}"]
  ]);

  assert.deepEqual(
    resolveDockerIdentity((args) => (args[1] === "show" ? "default" : "unix:///var/run/docker.sock"), "linux"),
    { context: "default", endpoint: "unix:///var/run/docker.sock" }
  );
  for (const [platform, endpoint] of [
    ["win32", "ssh://remote.example/run/docker.sock"],
    ["linux", "tcp://127.0.0.1:2375"],
    ["linux", "npipe:////./pipe/docker_engine"]
  ]) {
    assert.throws(
      () => resolveDockerIdentity((args) => (args[1] === "show" ? "default" : endpoint), platform),
      /requires a local/
    );
  }
});

test("rejects unlabeled Compose resource names before reuse and verifies them after cleanup", () => {
  const project = "hyperion-pulso-recovery-acceptance-resources1";
  const expected = expectedProjectResourceNames(project);
  const cases = [
    ...expected.containerPrefixes.map((prefix) => ["containers", `${prefix}postgres-1`]),
    ["networks", expected.networkNames[0]],
    ...expected.volumeNames.map((name) => ["volumes", name]),
    ...expected.imageRepositoryPrefixes.map((prefix) => ["images", `${prefix}pulso-migrations:latest`])
  ];

  for (const [kind, resourceName] of cases) {
    const docker = (args) => {
      const filtered = args.includes("--filter");
      if (kind === "containers" && args[0] === "ps" && !filtered) return `${resourceName}\n`;
      if (kind === "networks" && args[0] === "network" && !filtered) return `${resourceName}\n`;
      if (kind === "volumes" && args[0] === "volume" && !filtered) return `${resourceName}\n`;
      if (kind === "images" && args[0] === "image") return `${resourceName}\n`;
      return "";
    };
    const resources = listProjectResources(project, docker);
    assert.deepEqual(resources[kind], [resourceName]);
    assert.throws(() => assertProjectAbsent(resources, project), /already has resources/);
  }
});

test("records exact Docker inventory and rejects any mutation of a preexisting container", () => {
  const before = parseDockerInventory(
    "aaaaaaaaaaaa\tplatform-postgres-1\tpostgres@sha256:one\n" + "bbbbbbbbbbbb\tother-app\tother@sha256:two\n"
  );
  const after = parseDockerInventory(
    "bbbbbbbbbbbb\tother-app\tother@sha256:two\n" + "aaaaaaaaaaaa\tplatform-postgres-1\tpostgres@sha256:one\n"
  );
  assert.deepEqual(after, before);
  assert.doesNotThrow(() => assertDockerInventoryPreserved(before, after));
  assert.throws(
    () =>
      assertDockerInventoryPreserved(before, [
        { id: "cccccccccccc", name: "platform-postgres-1", image: "postgres@sha256:one" }
      ]),
    /preexisting Docker resource changed/
  );
});

test("pins the provider ledger to PULSO migrations 001 through 006 without pinning mutable hashes", () => {
  assert.deepEqual(expectedMigrationFiles(), EXPECTED_MIGRATIONS);
  assert.doesNotThrow(() => assertPulsoCatalogEvidence(validCatalogEvidence));
  assert.throws(
    () => assertPulsoCatalogEvidence({ ...validCatalogEvidence, ledger: ledger.split("\n")[0] }),
    /migration ledger differs/
  );
  assert.throws(
    () => assertPulsoCatalogEvidence({ ...validCatalogEvidence, ledger: ledger.replace(digest, "bad") }),
    /invalid name or checksum/
  );
});

test("requires global version 6, owner-local SOFIA version 2, all provider schemas and exact database ACL", () => {
  assert.throws(
    () =>
      assertPulsoCatalogEvidence({
        ...validCatalogEvidence,
        schemaVersion: "1\t001-pulso-autonomous-baseline.sql"
      }),
    /schema version mismatch/
  );
  assert.throws(
    () =>
      assertPulsoCatalogEvidence({
        ...validCatalogEvidence,
        sofiaSchemaVersion: "0\t003-sofia-readiness-marker.sql"
      }),
    /SOFIA schema version mismatch/
  );
  assert.throws(
    () => assertPulsoCatalogEvidence({ ...validCatalogEvidence, ownerState: "3\t1\t0" }),
    /ownership mismatch/
  );
  assert.throws(
    () => assertPulsoCatalogEvidence({ ...validCatalogEvidence, aclState: EXPECTED_ACL_STATE.replace(/^f/, "t") }),
    /ACL mismatch/
  );
  assert.throws(
    () =>
      assertPulsoCatalogEvidence({
        ...validCatalogEvidence,
        userSchemas: `${EXPECTED_USER_SCHEMA_STATE}\nnova_runtime`
      }),
    /user schema whitelist mismatch/
  );
});

test("requires exact skip-only migration and five-role validation receipts", () => {
  const migrationOutput = `${JSON.stringify({
    event: "pulso_migrations_complete",
    applied: [],
    adopted: [],
    skipped: EXPECTED_MIGRATIONS
  })}\n`;
  assert.deepEqual(parsePulsoMigrationReceipt(migrationOutput).skipped, EXPECTED_MIGRATIONS);
  assert.equal(
    parsePulsoRoleReceipt(`${JSON.stringify({ event: "pulso_database_roles_ready", roleCount: 5 })}\n`).roleCount,
    5
  );
  assert.throws(
    () =>
      parsePulsoMigrationReceipt(
        JSON.stringify({
          event: "pulso_migrations_complete",
          applied: [EXPECTED_MIGRATIONS[1]],
          adopted: [],
          skipped: [EXPECTED_MIGRATIONS[0]]
        })
      ),
    /unexpectedly applied or adopted/
  );
  assert.throws(
    () => parsePulsoRoleReceipt(JSON.stringify({ event: "pulso_database_roles_ready", roleCount: 4 })),
    /roleCount=4/
  );
});

test("requires successful least-privilege connections for all five runtime roles", () => {
  for (const role of RUNTIME_ROLES) {
    const fields = runtimeStates[role].split("\t");
    assert.equal(
      fields[4],
      "true",
      `${role} must read the current global marker; only SOFIA classifies that grant as N-1 compatibility`
    );
    assert.equal(fields[5], role === "hyperion_sofia" ? "true" : "false", `${role} owner-local marker SELECT`);
  }

  const missingRoleStates = { ...runtimeStates };
  delete missingRoleStates.hyperion_channel;
  assert.throws(
    () => assertPulsoCatalogEvidence({ ...validCatalogEvidence, runtimeStates: missingRoleStates }),
    /role set mismatch/
  );

  const elevatedRoleStates = {
    ...runtimeStates,
    hyperion_integration: runtimeStates.hyperion_integration.replace(/\tfalse$/, "\ttrue")
  };
  assert.throws(
    () => assertPulsoCatalogEvidence({ ...validCatalogEvidence, runtimeStates: elevatedRoleStates }),
    /runtime access mismatch for hyperion_integration/
  );
});

test("resolves every forbidden table probe by pg_catalog OID without named regclass lookup", () => {
  let forbiddenProbeCount = 0;
  for (const role of RUNTIME_ROLES) {
    const probe = RUNTIME_ACCESS_PROBES[role];
    assert.ok(probe, `missing access probe for ${role}`);
    for (const field of ["forbiddenPrimary", "forbiddenSecondary"]) {
      const sql = probe[field];
      forbiddenProbeCount += 1;
      assert.match(sql, /pg_catalog\.has_table_privilege\(/);
      assert.match(sql, /select relation_state\.oid/);
      assert.match(sql, /pg_catalog\.pg_class/);
      assert.match(sql, /pg_catalog\.pg_namespace/);
      assert.doesNotMatch(sql, /has_table_privilege\(\s*current_user\s*,\s*'/s);
      assert.doesNotMatch(sql, /::\s*regclass|to_regclass/i);
    }
  }
  assert.equal(forbiddenProbeCount, RUNTIME_ROLES.length * 2);
});

test("the ops descriptor is exec-only and restore reapplies all PULSO database grants", () => {
  const descriptor = readFileSync(path.join(repositoryRoot, "infra", "docker-compose.pulso-ops.yml"), "utf8");
  assert.match(descriptor, /^name: hyperion-pulso$/m);
  assert.match(descriptor, /profiles: \["pulso-ops"\]/);
  assert.doesNotMatch(descriptor, /volumes:|ports:|POSTGRES_PASSWORD|services:\s*\n\s{2}(?!postgres:)/);

  const restoreEngine = readFileSync(path.join(repositoryRoot, "scripts", "ops", "postgres-restore.sh"), "utf8");
  assert.equal([...restoreEngine.matchAll(/\$\{profile_database_acl_sql\}/g)].length, 2);
  assert.match(restoreEngine, /REVOKE ALL ON DATABASE.*FROM PUBLIC/);
  for (const role of ["hyperion_pulso_migrator", ...RUNTIME_ROLES]) assert.match(restoreEngine, new RegExp(role));

  const values = parseKeyValueOutput("BACKUP_PROFILE=pulso\nBACKUP_SHA256=abc=def\n");
  assert.equal(values.get("BACKUP_PROFILE"), "pulso");
  assert.equal(values.get("BACKUP_SHA256"), "abc=def");
  assert.equal(
    normalizeSchemaDump("\\restrict random-one\r\nschema\r\n\\unrestrict random-one\r\n"),
    "\\restrict <normalized>\nschema\n\\unrestrict <normalized>\n"
  );
});

test("the drill uses an isolated context, no PostgreSQL host port and a data-only marker", () => {
  const standalone = readFileSync(path.join(repositoryRoot, "infra", "docker-compose.pulso.yml"), "utf8");
  const isolatedContext = path.join(repositoryRoot, "temporary-recovery-context", "pulso");
  const rendered = renderIsolatedStandaloneCompose(standalone, isolatedContext);
  assert.match(rendered, new RegExp(`context: "${isolatedContext.replaceAll("\\", "/")}"`));
  assert.doesNotMatch(rendered, /\.docker-contexts\/pulso|PULSO_POSTGRES_HOST_PORT/);

  const runner = readFileSync(
    path.join(repositoryRoot, "scripts", "ops", "run-pulso-postgres-recovery-drill.mjs"),
    "utf8"
  );
  assert.match(runner, /"--output",\s*contextOutputRoot/);
  assert.match(runner, /insert into platform\.products/);
  assert.match(runner, /recoveryCanarySha256/);
  assert.doesNotMatch(runner, /'markerSha256'/);
  assert.doesNotMatch(runner, /create table pulso_iris\.recovery_drill_probe/i);
  assert.match(runner, /dropIsolatedSourceDatabase\(compose\)/);
  assert.match(runner, /validateRestoredProviderState\(compose, credentials\)/);
  assert.match(runner, /PULSO_MIGRATOR_DATABASE_URL/);
  assert.match(runner, /pulso-role-bootstrap/);
  assert.match(runner, /from agent_runtime\.schema_version where service_name = 'sofia'/);
  for (const field of [
    "workingTreeStatusSha256",
    "workingTreePatchSha256",
    "commandSourcesSha256",
    "globalReadinessMarkerSha256",
    "sofiaReadinessMarkerSha256",
    "rawReceipts",
    "logSha256",
    "dockerInventory"
  ]) {
    assert.match(runner, new RegExp(field));
  }
  assert.match(runner, /catalogTablePrivilege\("agent_runtime", "schema_version", "SELECT"\)/);
  assert.match(runner, /\["--host", sealedDockerEndpoint, \.\.\.args\]/);
  assert.doesNotMatch(runner, /\["--context", sealedDockerContext, \.\.\.args\]/);
  assert.equal([...runner.matchAll(/assertProjectAbsent\(listProjectResources\(project\)/g)].length, 2);
  const runDrillBody = runner.slice(runner.indexOf("export function runDrill"));
  assert.ok(
    runDrillBody.indexOf("assertDefaultDockerRouting(process.env)") <
      runDrillBody.indexOf("preflightDefaultDockerClient(process.env, runDocker)")
  );
});

test("keeps the Windows Docker home and pins both engines to the sealed endpoint", () => {
  for (const wrapperName of ["pulso-postgres-backup.sh", "pulso-postgres-restore.sh"]) {
    const wrapper = readFileSync(path.join(repositoryRoot, "scripts", "ops", wrapperName), "utf8");
    assert.match(wrapper, /sanitized_environment=\(env -i/);
    assert.match(wrapper, /"HOME=\$\{sanitized_home\}"/);
    for (const variable of ["USERPROFILE", "HOMEDRIVE", "HOMEPATH"]) {
      assert.match(wrapper, new RegExp(`"${variable}=\\$\\{${variable}`));
    }
    assert.match(wrapper, /docker context show/);
    assert.match(wrapper, /docker context inspect/);
    assert.match(wrapper, /HYPERION_DOCKER_ENDPOINT="\$\{expected_docker_endpoint\}"/);
  }

  for (const engineName of ["postgres-backup.sh", "postgres-restore.sh"]) {
    const engine = readFileSync(path.join(repositoryRoot, "scripts", "ops", engineName), "utf8");
    assert.match(engine, /compose\+=\(--host "\$\{docker_endpoint\}"\)/);
    assert.doesNotMatch(engine, /compose\+=\(--context "\$\{docker_context\}"\)/);
  }
});

test("accepts only a PostgreSQL permission denial as the expected runtime DDL failure", () => {
  assert.equal(isExpectedRuntimeDdlDenial("ERROR: permission denied to create schema"), true);
  assert.equal(isExpectedRuntimeDdlDenial("ERROR: permission denied for database hyperion_pulso_restore_drill"), true);
  assert.equal(isExpectedRuntimeDdlDenial("connection refused"), false);
  assert.equal(isExpectedRuntimeDdlDenial("container disappeared"), false);
});
