import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Standalone Platform Compose gives Audit its provider-owned database lifecycle", async () => {
  const compose = await readFile(path.join(repositoryRoot, "infra/docker-compose.platform.yml"), "utf8");
  const databaseBootstrap = composeService(compose, "audit-database-bootstrap");
  const migrations = composeService(compose, "audit-migrations");
  const roleBootstrap = composeService(compose, "audit-role-bootstrap");
  const service = composeService(compose, "audit-service");

  assert.doesNotMatch(
    compose,
    /^ {2}(?:migrations|db-role-bootstrap|platform-migrations|api-gateway|web-console):\r?$/m
  );
  assert.match(databaseBootstrap, /target: audit-migrations/);
  assert.match(databaseBootstrap, /AUDIT_POSTGRES_DB:/);
  assert.match(databaseBootstrap, /AUDIT_POSTGRES_ADMIN_URL:/);
  assert.match(migrations, /target: audit-migrations/);
  assert.match(migrations, /AUDIT_MIGRATOR_DATABASE_URL:/);
  assert.doesNotMatch(migrations, /DATABASE_URL: \*admin-database-url/);
  assert.match(roleBootstrap, /target: audit-migrations/);
  assert.match(roleBootstrap, /audit-migrations:\s*\r?\n\s+condition: service_completed_successfully/);
  assert.match(service, /target: audit-service/);
  assert.match(service, /audit-role-bootstrap:\s*\r?\n\s+condition: service_completed_successfully/);
  assert.doesNotMatch(service, /^\s{6}(?:migrations|db-role-bootstrap|platform-migrations):/m);
  assert.match(compose, /postgres:\/\/hyperion_audit:.*\/\$\{AUDIT_POSTGRES_DB:-hyperion_audit\}/);
});

test("Audit runtime image receives only the provider readiness manifest", async () => {
  const dockerfile = await readFile(path.join(repositoryRoot, "infra/docker/cells/platform.Dockerfile"), "utf8");
  const migrationImage = dockerStage(dockerfile, "audit-migrations");
  const runtimeImage = dockerStage(dockerfile, "audit-service");

  assert.match(migrationImage, /packages\/audit-migrations\/sql/);
  assert.match(runtimeImage, /dist\/schema-manifest\.js/);
  assert.doesNotMatch(runtimeImage, /packages\/audit-migrations\/sql/);
  assert.doesNotMatch(runtimeImage, /audit-migrations\/dist\/(?:bootstrap[^/]*|runner|index)\.js/);
  assert.doesNotMatch(dockerfile, /pnpm -r build/);
});

function composeService(compose, name) {
  const match = compose.match(new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^volumes:)`, "m"));
  assert(match, `missing Compose service ${name}`);
  return match[1];
}

function dockerStage(dockerfile, name) {
  const match = dockerfile.match(new RegExp(`^FROM [^\\r\\n]+ AS ${name}\\r?\\n([\\s\\S]*?)(?=^FROM |\\Z)`, "m"));
  assert(match, `missing Docker stage ${name}`);
  return match[1];
}
