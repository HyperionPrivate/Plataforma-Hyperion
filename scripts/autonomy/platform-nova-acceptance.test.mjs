import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptanceNames,
  NOVA_ACCEPTANCE_BUILD_SERVICES,
  PLATFORM_ACCEPTANCE_BUILD_SERVICES
} from "./platform-nova-acceptance.e2e.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const platformDescriptor = path.join(repositoryRoot, "infra/docker-compose.platform.yml");
const platformOverlay = path.join(repositoryRoot, "infra/docker-compose.platform-nova.acceptance.yml");
const platformEnvironment = path.join(repositoryRoot, "infra/platform.env.example");
const novaDescriptor = path.join(repositoryRoot, "infra/docker-compose.nova.yml");
const novaOverlay = path.join(repositoryRoot, "infra/docker-compose.nova-platform.acceptance.yml");
const novaEnvironment = path.join(repositoryRoot, "infra/nova.env.example");
const scriptPath = path.join(repositoryRoot, "scripts/autonomy/platform-nova-acceptance.e2e.mjs");
const shared = {
  PLATFORM_NOVA_ACCEPTANCE_NETWORK: "hyperion-platform-nova-acceptance-a1b2c3d4e5f6",
  NOVA_BFF_TO_ACCESS_TOKEN: "acceptance-nova-access-token-a1b2c3d4e5f6",
  NOVA_TO_AUDIT_TOKEN: "acceptance-nova-audit-token-a1b2c3d4e5f6",
  PLATFORM_ACCESS_TOKEN_ISSUER: "https://access.acceptance.invalid",
  NOVA_ACCESS_TOKEN_ISSUER: "https://access.acceptance.invalid"
};
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

test("the provider-owned overlays join only the four intended workloads", () => {
  const platform = composeModel(platformEnvironment, [platformDescriptor, platformOverlay]);
  const nova = composeModel(novaEnvironment, [novaDescriptor, novaOverlay]);
  const network = "platform-nova-acceptance";

  assert.deepEqual(attachedServices(platform, network), ["audit-service", "identity-service"]);
  assert.deepEqual(attachedServices(nova, network), ["nova-bff", "nova-core-service"]);
  for (const service of [platform.services["identity-service"], platform.services["audit-service"]]) {
    assert.ok(service.networks.default);
    assert.ok(service.networks[network]);
  }
  for (const service of [nova.services["nova-bff"], nova.services["nova-core-service"]]) {
    assert.ok(service.networks.default);
    assert.ok(service.networks[network]);
  }

  assert.equal(platform.networks[network].external, true);
  assert.equal(platform.networks[network].name, shared.PLATFORM_NOVA_ACCEPTANCE_NETWORK);
  assert.equal(nova.networks[network].external, true);
  assert.equal(nova.networks[network].name, shared.PLATFORM_NOVA_ACCEPTANCE_NETWORK);
  assert.deepEqual(platform.services["identity-service"].networks[network].aliases, ["identity-service"]);
  assert.deepEqual(platform.services["audit-service"].networks[network].aliases, ["audit-service"]);
  assert.equal(platform.services["identity-service"].environment.ACCESS_TOKEN_AUDIENCES, "platform-admin-bff,nova-bff");
  assert.equal(
    platform.services["identity-service"].environment.NOVA_BFF_TO_ACCESS_TOKEN,
    nova.services["nova-bff"].environment.NOVA_BFF_TO_ACCESS_TOKEN
  );
  assert.equal(
    platform.services["audit-service"].environment.NOVA_TO_AUDIT_TOKEN,
    nova.services["nova-core-service"].environment.NOVA_TO_AUDIT_TOKEN
  );
  assert.equal(nova.services["nova-bff"].environment.ACCESS_SERVICE_URL, "http://identity-service:8081");
  assert.equal(
    nova.services["nova-bff"].environment.ACCESS_JWKS_URL,
    "http://identity-service:8081/.well-known/jwks.json"
  );
  assert.equal(nova.services["nova-core-service"].environment.AUDIT_SERVICE_URL, "http://audit-service:8086");
  assert.equal(
    platform.services["identity-service"].environment.ACCESS_TOKEN_ISSUER,
    nova.services["nova-bff"].environment.ACCESS_TOKEN_ISSUER
  );
  assert.equal(platform.services["nova-access-jwks-fixture"], undefined);
  assert.equal(nova.services["nova-access-jwks-fixture"], undefined);
});

test("the orchestrator is opt-in and encodes guarded exact cleanup", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /RUN_PLATFORM_NOVA_ACCEPTANCE/);
  assert.match(source, /network", "create", "--driver", "bridge", "--internal"/);
  assert.match(source, /PLATFORM_POSTGRES_HOST_PORT: "0"/);
  assert.match(source, /NOVA_BFF_HOST_PORT: "0"/);
  assert.match(source, /--volumes", "--remove-orphans", "--rmi", "local"/);
  assert.match(source, /assertProjectAbsent\(names\.novaProject\)/);
  assert.match(source, /assertProjectAbsent\(names\.platformProject\)/);
  assert.match(source, /assertNetworkAbsent\(names\.network\)/);
  assert.match(source, /safeRemoveTemporary\(temporaryDirectory, names\.network\)/);
  assert.match(source, /COMPOSE_DISABLE_ENV_FILE: "1"/);
  assert.match(source, /for \(const image of migrationImages\) await assertImageAbsent\(image\)/);
  assert.match(source, /await assertNetworkAbsent\(names\.network\)/);
  assert.match(source, /if \(ownsNovaProject\).*nova\.down\(\)/s);
  assert.match(source, /if \(ownsPlatformProject\).*platform\.down\(\)/s);
  assert.match(source, /if \(ownsMigrationImages\)[\s\S]*removeImageIfPresent/);
  assert.match(source, /if \(ownsNetwork\)[\s\S]*removeNetworkIfPresent/);
  assert.match(source, /Never set[\s\S]*before every preflight has passed/);
  assert.match(source, /acceptanceAbortController\?\.abort/);
  assert.match(source, /AbortSignal\.any\(\[acceptanceSignal, timeout\]\)/);
  assert.match(source, /delay\(1_000, undefined, \{ signal: acceptanceAbortController\?\.signal \}\)/);
  assert.match(source, /if \(cleanupMode\) return/);
  assert.match(source, /platform\.run\(\["stop", "identity-service"\]\)/);
  assert.match(source, /browserCall\(novaBffUrl, novaSession, "GET", "\/v1\/auth\/me", undefined, 200\)/);
  assert.match(source, /expectCsrfDenied\(platformBffUrl, platformSession, "PUT", grantPath, grantBody\)/);
  assert.match(source, /rows\.length <= 1/);
  assert.match(source, /metadata->>'businessIdempotencyKey' = :'business_key'/);
  assert.match(source, /logicalAuditCount: 1/);
  assert.match(
    source,
    /if \(cleanupErrors\.length > 0\)[\s\S]*if \(acceptanceError\)[\s\S]*if \(receivedSignal\)[\s\S]*JSON\.stringify\(acceptanceResult\)/
  );
  assert.match(source, /hyperion\/access-migrations:acceptance-/);
  assert.match(source, /hyperion\/audit-migrations:acceptance-/);
  assert.doesNotMatch(source, /\.run\(\["build"\]\)/);
  assert.match(source, /for \(const service of PLATFORM_ACCEPTANCE_BUILD_SERVICES\)/);
  assert.match(source, /for \(const service of NOVA_ACCEPTANCE_BUILD_SERVICES\)/);
  assert.doesNotMatch(source, /compose[\s\S]{0,80}"config"/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:Password|Token|environment)/i);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: dockerEnvironment,
    shell: false,
    timeout: 5_000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set RUN_PLATFORM_NOVA_ACCEPTANCE=1/);
  assert.doesNotMatch(result.stdout, /materializing provider-owned build contexts/);
});

test("Docker Desktop builds each provider closure sequentially in a fixed order", () => {
  assert.deepEqual(PLATFORM_ACCEPTANCE_BUILD_SERVICES, [
    "access-database-bootstrap",
    "audit-database-bootstrap",
    "identity-service",
    "tenant-service",
    "audit-service",
    "platform-admin-bff",
    "platform-admin-console"
  ]);
  assert.deepEqual(NOVA_ACCEPTANCE_BUILD_SERVICES, [
    "nova-database-bootstrap",
    "nova-migrations",
    "nova-role-bootstrap",
    "nova-core-service",
    "voice-channel-service",
    "liwa-channel-service",
    "documents-service",
    "nova-bff",
    "nova-console"
  ]);
});

test("acceptance resource names reject anything outside the unique run namespace", () => {
  assert.deepEqual(acceptanceNames("a1b2c3d4e5f6"), {
    platformProject: "hyperion-platform-acceptance-a1b2c3d4e5f6",
    novaProject: "hyperion-nova-acceptance-a1b2c3d4e5f6",
    network: "hyperion-platform-nova-acceptance-a1b2c3d4e5f6"
  });
  for (const unsafe of ["", "ABCDEF123456", "a1b2", "../../escape", "a1b2c3d4e5f6-extra"]) {
    assert.throws(() => acceptanceNames(unsafe));
  }
});

function composeModel(environmentPath, descriptors) {
  const result = spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    [
      "compose",
      "--env-file",
      environmentPath,
      ...descriptors.flatMap((descriptor) => ["-f", descriptor]),
      "config",
      "--format",
      "json"
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...dockerEnvironment, ...shared, COMPOSE_DISABLE_ENV_FILE: "1" },
      shell: false
    }
  );
  assert.equal(result.status, 0, result.stderr || "Compose model failed without diagnostics");
  return JSON.parse(result.stdout);
}

function attachedServices(model, network) {
  return Object.entries(model.services)
    .filter(([, service]) => Object.hasOwn(service.networks ?? {}, network))
    .map(([name]) => name)
    .sort();
}
