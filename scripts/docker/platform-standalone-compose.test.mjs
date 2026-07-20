import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const composePath = path.join(repositoryRoot, "infra/docker-compose.platform.yml");
const environmentPath = path.join(repositoryRoot, "infra/platform.env.example");
const dockerfilePath = path.join(repositoryRoot, "infra/docker/cells/platform.Dockerfile");
const legacyDockerfilePath = path.join(repositoryRoot, "infra/docker/node-service.Dockerfile");
const dockerEnvironment = Object.fromEntries(
  [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "ComSpec",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "DOCKER_CONFIG",
    "DOCKER_CLI_PLUGIN_EXTRA_DIRS",
    "TEMP",
    "TMP"
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
);

test("Platform standalone contains only the neutral control plane and provider-owned one-shots", () => {
  const result = compose("config", "--format", "json");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const model = JSON.parse(result.stdout);
  assert.equal(model.name, "hyperion-platform");
  assert.deepEqual(Object.keys(model.services).sort(), [
    "access-database-bootstrap",
    "access-migrations",
    "access-role-bootstrap",
    "audit-database-bootstrap",
    "audit-migrations",
    "audit-role-bootstrap",
    "audit-service",
    "identity-service",
    "platform-admin-bff",
    "platform-admin-console",
    "postgres",
    "tenant-service"
  ]);

  const targets = {
    "access-database-bootstrap": "access-migrations",
    "access-migrations": "access-migrations",
    "access-role-bootstrap": "access-migrations",
    "audit-database-bootstrap": "audit-migrations",
    "audit-migrations": "audit-migrations",
    "audit-role-bootstrap": "audit-migrations",
    "identity-service": "identity-service",
    "tenant-service": "tenant-service",
    "audit-service": "audit-service",
    "platform-admin-bff": "platform-admin-bff",
    "platform-admin-console": "platform-admin-console"
  };
  for (const [service, target] of Object.entries(targets)) {
    assert.equal(model.services[service].build.target, target);
    assert.match(model.services[service].build.context.replaceAll("\\", "/"), /\/\.docker-contexts\/platform$/);
  }

  assert.deepEqual(model.services["access-database-bootstrap"].depends_on.postgres.condition, "service_healthy");
  assert.equal(
    model.services["access-migrations"].depends_on["access-database-bootstrap"].condition,
    "service_completed_successfully"
  );
  assert.equal(
    model.services["access-role-bootstrap"].depends_on["access-migrations"].condition,
    "service_completed_successfully"
  );
  assert.equal(
    model.services["identity-service"].depends_on["access-role-bootstrap"].condition,
    "service_completed_successfully"
  );
  assert.equal(
    model.services["tenant-service"].depends_on["access-role-bootstrap"].condition,
    "service_completed_successfully"
  );
  assert.equal(
    model.services["audit-service"].depends_on["audit-role-bootstrap"].condition,
    "service_completed_successfully"
  );
  assert.deepEqual(Object.keys(model.services["platform-admin-bff"].depends_on).sort(), [
    "identity-service",
    "tenant-service"
  ]);
  assert.equal(model.services["platform-admin-bff"].environment.AUDIT_SERVICE_URL, undefined);
});

test("Platform one-shots and runtimes receive only their phase-owned database credentials", () => {
  const result = compose("config", "--format", "json");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const services = JSON.parse(result.stdout).services;
  const databaseKeys = (service) =>
    Object.keys(services[service].environment ?? {})
      .filter((key) => /(?:DATABASE|POSTGRES)/.test(key) && key !== "NODE_ENV")
      .sort();

  assert.deepEqual(databaseKeys("access-database-bootstrap"), [
    "ACCESS_MIGRATOR_DATABASE_PASSWORD",
    "ACCESS_POSTGRES_ADMIN_URL",
    "ACCESS_POSTGRES_DB"
  ]);
  assert.deepEqual(databaseKeys("access-migrations"), ["ACCESS_MIGRATOR_DATABASE_URL", "ACCESS_POSTGRES_DB"]);
  assert.deepEqual(databaseKeys("access-role-bootstrap"), [
    "ACCESS_MIGRATOR_DATABASE_PASSWORD",
    "ACCESS_POSTGRES_ADMIN_URL",
    "ACCESS_POSTGRES_DB",
    "IDENTITY_DATABASE_PASSWORD",
    "TENANT_DATABASE_PASSWORD"
  ]);
  assert.deepEqual(databaseKeys("audit-database-bootstrap"), [
    "AUDIT_MIGRATOR_DATABASE_PASSWORD",
    "AUDIT_POSTGRES_ADMIN_URL",
    "AUDIT_POSTGRES_DB"
  ]);
  assert.deepEqual(databaseKeys("audit-migrations"), ["AUDIT_MIGRATOR_DATABASE_URL"]);
  assert.deepEqual(databaseKeys("audit-role-bootstrap"), [
    "AUDIT_DATABASE_PASSWORD",
    "AUDIT_POSTGRES_ADMIN_URL",
    "AUDIT_POSTGRES_DB"
  ]);
  assert.match(services["identity-service"].environment.DATABASE_URL, /^postgres:\/\/hyperion_identity:/);
  assert.match(services["tenant-service"].environment.DATABASE_URL, /^postgres:\/\/hyperion_tenant:/);
  assert.match(services["audit-service"].environment.DATABASE_URL, /^postgres:\/\/hyperion_audit:/);
  assert.equal(services["identity-service"].environment.EXPECTED_DATABASE_ROLE, "hyperion_identity");
  assert.equal(services["tenant-service"].environment.EXPECTED_DATABASE_ROLE, "hyperion_tenant");
  assert.equal(services["audit-service"].environment.EXPECTED_DATABASE_ROLE, "hyperion_audit");
});

test("Platform descriptor excludes the compatibility gateway and every product workload", async () => {
  const [composeSource, environmentSource] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(environmentPath, "utf8")
  ]);
  assert.doesNotMatch(
    composeSource,
    /^ {2}(?:api-gateway|web-console|migrations|db-role-bootstrap|platform-migrations|nova-core-service|lumen-service|pulso-iris-service|agent-service|whatsapp-channel-service):/m
  );
  assert.doesNotMatch(composeSource, /packages\/(?:migrations|platform-migrations)|apps\/(?:api-gateway|web-console)/);
  assert.doesNotMatch(environmentSource, /GATEWAY_/);
  assert.equal((composeSource.match(/^ {2}postgres:/gm) ?? []).length, 1);
  assert.match(composeSource, /ACCESS_LUMEN_PROJECTION_TRANSPORT: disabled/);
  assert.match(composeSource, /ACCESS_TOKEN_PRIVATE_KEY_FILE: \/run\/secrets\/access_token_private_key/);
});

test("Identity and Tenant images receive Access runtime evidence but never migration authority", async () => {
  const [dockerfile, runtimeBoundary] = await Promise.all([
    readFile(dockerfilePath, "utf8"),
    readFile(path.join(repositoryRoot, "packages/access-migrations/src/runtime-boundary.ts"), "utf8")
  ]);
  const migrationImage = dockerStage(dockerfile, "access-migrations");
  const identityImage = dockerStage(dockerfile, "identity-service");
  const tenantImage = dockerStage(dockerfile, "tenant-service");
  assert.match(migrationImage, /packages\/access-migrations\/sql/);
  for (const runtime of [identityImage, tenantImage]) {
    assert.match(runtime, /dist\/schema-manifest\.js/);
    assert.match(runtime, /dist\/role-manifest\.js/);
    assert.match(runtime, /dist\/runtime-boundary\.js/);
    assert.doesNotMatch(runtime, /packages\/access-migrations\/sql/);
    assert.doesNotMatch(runtime, /access-migrations\/dist\/(?:bootstrap[^/]*|runner|index)\.js/);
    assert.doesNotMatch(runtime, /access-migrations\/dist\/config\.js/);
  }
  assert.match(runtimeBoundary, /from "\.\/role-manifest\.js"/);
  assert.doesNotMatch(runtimeBoundary, /from "\.\/config\.js"/);
  assert.doesNotMatch(dockerfile, /pnpm -r build/);
});

test("Full-stack Identity and Tenant images include the complete Access runtime module closure", async () => {
  const dockerfile = await readFile(legacyDockerfilePath, "utf8");
  const identityImage = dockerStage(dockerfile, "identity-service");
  const tenantImage = dockerStage(dockerfile, "tenant-service");
  for (const runtime of [identityImage, tenantImage]) {
    assert.match(runtime, /dist\/schema-manifest\.js/);
    assert.match(runtime, /dist\/role-manifest\.js/);
    assert.match(runtime, /dist\/runtime-boundary\.js/);
    assert.doesNotMatch(runtime, /packages\/access-migrations\/sql/);
    assert.doesNotMatch(runtime, /access-migrations\/dist\/(?:bootstrap[^/]*|runner|index)\.js/);
  }
  assert.match(dockerfile, /FROM durable-service-runtime-base AS identity-service/);
  assert.match(dockerStage(dockerfile, "durable-service-runtime-base"), /packages\/durable-events\/dist/);
});

test("Access one-shots fence runtime logins before reading target secrets", async () => {
  for (const filename of ["bootstrap-database.ts", "bootstrap-roles.ts"]) {
    const source = await readFile(path.join(repositoryRoot, "packages/access-migrations/src", filename), "utf8");
    const fence = source.indexOf("await fenceAccessRuntimeDatabaseRoles(adminUrl)");
    assert(fence >= 0, `${filename} does not invoke the pre-target runtime-role fence`);
    for (const operation of [
      "readAccessPostgresDatabase()",
      "readAccessMigratorPassword()",
      "readAccessRolePasswords()"
    ]) {
      const index = source.indexOf(operation);
      if (index >= 0) assert(fence < index, `${filename} reads ${operation} before fencing runtime roles`);
    }
  }
});

test("Platform CI imports both Access runtime image closures without secrets or a network", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/_cell-ci.yml"), "utf8");
  assert.match(workflow, /Import Platform runtime image closures without migration authority/);
  assert.match(workflow, /for service in identity-service tenant-service/);
  assert.match(workflow, /docker run --rm --network none --read-only --cap-drop ALL/);
  assert.match(workflow, /await import\('\.\/services\/\$\{service\}\/dist\/app\.js'\)/);
});

function compose(...arguments_) {
  return spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    ["compose", "--env-file", environmentPath, "-f", composePath, ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: dockerEnvironment,
      shell: false
    }
  );
}

function dockerStage(dockerfile, name) {
  const match = dockerfile.match(new RegExp(`^FROM [^\\r\\n]+ AS ${name}\\r?\\n([\\s\\S]*?)(?=^FROM |\\Z)`, "m"));
  assert(match, `missing Docker stage ${name}`);
  return match[1];
}
