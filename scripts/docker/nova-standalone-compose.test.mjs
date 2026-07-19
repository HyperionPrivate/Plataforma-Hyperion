import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const composePath = path.join(repositoryRoot, "infra/docker-compose.nova.yml");
const acceptanceComposePath = path.join(repositoryRoot, "infra/docker-compose.nova.acceptance.yml");
const operationsComposePath = path.join(repositoryRoot, "infra/docker-compose.nova-ops.yml");
const environmentPath = path.join(repositoryRoot, "infra/nova.env.example");
const bffEntrypointPath = path.join(repositoryRoot, "apps/nova-bff/src/index.ts");
const bffRuntimeConfigPath = path.join(repositoryRoot, "apps/nova-bff/src/runtime-config.ts");
const voiceRoutesPath = path.join(repositoryRoot, "services/voice-channel-service/src/routes.ts");
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

test("el descriptor NOVA se interpola sin entorno ni servicios de otras celdas", async () => {
  const [composeSource, environmentSource] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(environmentPath, "utf8")
  ]);
  const forbidden = /LUMEN|PULSO|SOFIA|WHATSAPP|GATEWAY_|db-role-bootstrap|packages\/migrations/i;
  assert.doesNotMatch(composeSource, forbidden);
  assert.doesNotMatch(environmentSource, forbidden);
  assert.doesNotMatch(composeSource, /^ {2}(?:identity|tenant|audit)-service:/m);
  assert.doesNotMatch(composeSource, /^ {2}migrations:/m);

  const environmentResult = compose("config", "--environment");
  assert.equal(environmentResult.status, 0, environmentResult.stderr || environmentResult.stdout);
  assert.match(environmentResult.stdout, /^NOVA_POSTGRES_ADMIN_USER=/m);
  assert.doesNotMatch(environmentResult.stdout, forbidden);

  const modelResult = compose("--profile", "customer-coopfuturo", "config", "--format", "json");
  assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
  const model = JSON.parse(modelResult.stdout);
  assert.deepEqual(Object.keys(model.services).sort(), [
    "coopfuturo-console",
    "documents-service",
    "liwa-channel-service",
    "minio",
    "minio-init",
    "nova-bff",
    "nova-console",
    "nova-core-service",
    "nova-database-bootstrap",
    "nova-migrations",
    "nova-role-bootstrap",
    "postgres",
    "voice-channel-service"
  ]);

  const targets = {
    "nova-database-bootstrap": "nova-migrations",
    "nova-migrations": "nova-migrations",
    "nova-role-bootstrap": "nova-migrations",
    "nova-core-service": "nova-core-service",
    "voice-channel-service": "voice-channel-service",
    "liwa-channel-service": "liwa-channel-service",
    "documents-service": "documents-service",
    "nova-bff": "nova-bff",
    "nova-console": "nova-console"
  };
  for (const [service, target] of Object.entries(targets)) {
    assert.equal(model.services[service].build.target, target);
    assert.match(model.services[service].build.context.replaceAll("\\", "/"), /\/\.docker-contexts\/nova$/);
  }

  assert.deepEqual(Object.keys(model.services["nova-bff"].depends_on).sort(), [
    "documents-service",
    "liwa-channel-service",
    "nova-core-service",
    "voice-channel-service"
  ]);
  assert.deepEqual(model.services["nova-bff"].ports, [
    {
      mode: "ingress",
      target: 8095,
      published: "8095",
      protocol: "tcp",
      host_ip: "127.0.0.1"
    }
  ]);
  assert.equal(model.services["nova-console"].ports[0]?.host_ip, "127.0.0.1");
  assert.equal(model.services["coopfuturo-console"].ports[0]?.host_ip, "127.0.0.1");
  assert.deepEqual(Object.keys(model.services["nova-core-service"].depends_on), ["nova-role-bootstrap"]);
  assert.deepEqual(model.services["coopfuturo-console"].profiles, ["customer-coopfuturo"]);
  assert.deepEqual(Object.keys(model.services["coopfuturo-console"].depends_on), ["nova-bff"]);
  assert.match(
    model.services["coopfuturo-console"].build.context.replaceAll("\\", "/"),
    /\/\.docker-contexts\/coopfuturo$/
  );
  assert.equal(model.services["nova-bff"].environment.ACCESS_JWKS_ALLOW_PRIVATE_HTTP, "false");
});

test("el overlay de aceptación carga JWKS en frío sin incorporar Access ni fuentes hermanas", async () => {
  const [overlaySource, bffEntrypointSource, bffRuntimeConfigSource] = await Promise.all([
    readFile(acceptanceComposePath, "utf8"),
    readFile(bffEntrypointPath, "utf8"),
    readFile(bffRuntimeConfigPath, "utf8")
  ]);
  assert.doesNotMatch(overlaySource, /LUMEN|PULSO|SOFIA|WHATSAPP|api-gateway|packages\/migrations/i);
  assert.doesNotMatch(overlaySource, /^ {2}(?:identity|tenant|audit)-service:/m);

  const modelResult = composeAcceptance("config", "--format", "json");
  assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
  const model = JSON.parse(modelResult.stdout);
  const fixture = model.services["nova-access-jwks-fixture"];
  assert.ok(fixture, "acceptance fixture is missing");
  assert.equal(fixture.build.target, "nova-bff");
  assert.match(fixture.build.context.replaceAll("\\", "/"), /\/\.docker-contexts\/nova$/);
  assert.deepEqual(Object.keys(fixture.networks), ["nova-acceptance-jwks"]);
  assert.deepEqual(fixture.networks["nova-acceptance-jwks"].aliases, ["identity-service"]);
  assert.equal(model.networks["nova-acceptance-jwks"].internal, true);
  assert.deepEqual(
    Object.entries(model.services)
      .filter(([, service]) => Object.hasOwn(service.networks ?? {}, "nova-acceptance-jwks"))
      .map(([name]) => name)
      .sort(),
    ["nova-access-jwks-fixture", "nova-bff"]
  );
  assert.deepEqual(fixture.expose, ["18080"]);
  assert.equal(fixture.ports, undefined);
  assert.equal(fixture.configs, undefined);
  assert.equal(fixture.env_file, undefined);
  assert.equal(fixture.secrets, undefined);
  assert.equal(fixture.volumes, undefined);
  assert.deepEqual(fixture.environment, { HYPERION_ENVIRONMENT: "local" });
  assert.equal(fixture.read_only, true);
  assert.deepEqual(fixture.cap_drop, ["ALL"]);
  assert.deepEqual(fixture.security_opt, ["no-new-privileges:true"]);
  assert.equal(fixture.pids_limit, 64);
  assert.equal(fixture.restart, "no");

  assert.deepEqual(fixture.command.slice(-2), ["18080", "0.0.0.0"]);
  const fixtureProgram = fixture.command[fixture.command.indexOf("--eval") + 1];
  assert.match(fixtureProgram, /request\.url === "\/jwks"/);
  assert.match(fixtureProgram, /request\.url === "\/ready"/);
  assert.match(fixtureProgram, /request\.method === "GET" \|\| request\.method === "HEAD"/);
  assert.match(fixtureProgram, /status: "degraded"/);
  assert.match(fixtureProgram, /kid: "hyperion-nova-acceptance-readiness"/);
  assert.doesNotMatch(fixtureProgram, /BEGIN (?:RSA )?PRIVATE KEY|privateKey|\bd:\s*"/i);
  assert.match(fixture.healthcheck.test.at(-1), /body\.keys\?\.\[0\]\?\.kid/);

  const bff = model.services["nova-bff"];
  assert.equal(bff.environment.ACCESS_JWKS_URL, "http://identity-service:18080/jwks");
  assert.equal(bff.environment.ACCESS_SERVICE_URL, "http://identity-service:18080");
  assert.equal(bff.environment.ACCESS_JWKS_ALLOW_PRIVATE_HTTP, "true");
  assert.equal(bff.depends_on["nova-access-jwks-fixture"].condition, "service_healthy");
  assert.deepEqual(Object.keys(bff.networks).sort(), ["default", "nova-acceptance-jwks"]);

  assert.match(bffEntrypointSource, /allowPrivateAccessHttp\(process\.env\)/);
  assert.match(bffRuntimeConfigSource, /new Set\(\["local", "development", "test", "ci"\]\)/);
  assert.match(bffRuntimeConfigSource, /ACCESS_JWKS_ALLOW_PRIVATE_HTTP is forbidden outside local\/CI/);
});

test("el programa real del fixture limita su superficie HTTP y no contiene material RSA privado", async () => {
  const modelResult = composeAcceptance("config", "--format", "json");
  assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
  const fixture = JSON.parse(modelResult.stdout).services["nova-access-jwks-fixture"];
  const runtime = await startAcceptanceFixture(fixture);

  try {
    for (const method of ["GET", "HEAD"]) {
      const response = await requestFixture(runtime.port, { method, path: "/jwks" });
      assert.equal(response.statusCode, 200);
      if (method === "HEAD") {
        assert.equal(response.body, "");
        continue;
      }

      const document = JSON.parse(response.body);
      assert.equal(document.keys.length, 1);
      const [jwk] = document.keys;
      assert.deepEqual(Object.keys(jwk).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
      assert.equal(jwk.kty, "RSA");
      assert.equal(jwk.e, "AQAB");
      assert.match(jwk.n, /^[A-Za-z0-9_-]+$/);
      for (const privateParameter of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
        assert.equal(Object.hasOwn(jwk, privateParameter), false, `${privateParameter} must not be exposed`);
      }
    }

    for (const method of ["GET", "HEAD"]) {
      const response = await requestFixture(runtime.port, { method, path: "/ready" });
      assert.equal(response.statusCode, 503);
      if (method === "HEAD") {
        assert.equal(response.body, "");
      } else {
        assert.deepEqual(JSON.parse(response.body), {
          service: "access-acceptance-fixture",
          status: "degraded"
        });
      }
    }

    for (const request of [
      { method: "POST", path: "/jwks" },
      { method: "GET", path: "/jwks?format=json" },
      { method: "GET", path: "/login" },
      { method: "POST", path: "/login" },
      { method: "POST", path: "/oauth/token" },
      { method: "POST", path: "/tokens/mint" },
      { method: "GET", path: "/ready/details" },
      { method: "GET", path: "/health" },
      { method: "GET", path: "/jwks", host: "localhost" }
    ]) {
      const response = await requestFixture(runtime.port, request);
      assert.equal(response.statusCode, 404, `${request.method} ${request.path} must be hidden`);
      assert.deepEqual(JSON.parse(response.body), { status: "not-found" });
    }
  } finally {
    await stopExactChild(runtime.child);
  }
});

test("el fixture de aceptación falla antes de escuchar fuera de local/CI", () => {
  const modelResult = composeAcceptanceWithEnvironment(
    { NOVA_DEPLOYMENT_ENVIRONMENT: "production" },
    "config",
    "--format",
    "json"
  );
  assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
  const fixture = JSON.parse(modelResult.stdout).services["nova-access-jwks-fixture"];
  assert.equal(fixture.environment.HYPERION_ENVIRONMENT, "production");

  const result = spawnSync(process.execPath, fixture.command.slice(1), {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...dockerEnvironment, ...fixture.environment },
    shell: false,
    timeout: 5_000
  });
  assert.equal(result.status, 78, result.stderr || result.stdout);
  assert.match(result.stderr, /forbidden outside local\/CI/);
});

test("el overlay operativo apunta al mismo proyecto standalone NOVA", async () => {
  const [standaloneSource, operationsSource] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(operationsComposePath, "utf8")
  ]);
  const projectName = (source) => source.match(/^name:\s*([^\s#]+)\s*$/m)?.[1];

  assert.equal(projectName(standaloneSource), "hyperion-nova");
  assert.equal(projectName(operationsSource), projectName(standaloneSource));
  assert.doesNotMatch(operationsSource, /plataforma-hyperion/i);

  const modelResult = composeWith(operationsComposePath, "--profile", "nova-ops", "config", "--format", "json");
  assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
  const model = JSON.parse(modelResult.stdout);
  assert.equal(model.name, "hyperion-nova");
  assert.deepEqual(Object.keys(model.services), ["postgres"]);
  assert.deepEqual(model.services.postgres.environment ?? {}, {});
});

test("los one-shots NOVA reciben sólo la credencial que usa cada fase", () => {
  const modelResult = compose("config", "--format", "json");
  assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
  const services = JSON.parse(modelResult.stdout).services;
  const secretKeys = (service) =>
    Object.keys(services[service].environment)
      .filter((key) => /(?:DATABASE|POSTGRES)/.test(key) && key !== "NODE_ENV")
      .sort();

  assert.deepEqual(secretKeys("nova-database-bootstrap"), [
    "NOVA_MIGRATOR_DATABASE_PASSWORD",
    "NOVA_POSTGRES_ADMIN_URL",
    "NOVA_POSTGRES_DB"
  ]);
  assert.deepEqual(secretKeys("nova-migrations"), ["NOVA_MIGRATOR_DATABASE_URL"]);
  assert.deepEqual(secretKeys("nova-role-bootstrap"), [
    "DOCUMENTS_DATABASE_PASSWORD",
    "LIWA_DATABASE_PASSWORD",
    "NOVA_DATABASE_PASSWORD",
    "NOVA_POSTGRES_ADMIN_URL",
    "NOVA_POSTGRES_DB",
    "VOICE_DATABASE_PASSWORD"
  ]);
});

test("el entorno NOVA inventaría proveedores externos sin reutilizar secretos del gateway", async () => {
  const [composeSource, environmentSource] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(environmentPath, "utf8")
  ]);
  for (const variable of [
    "NOVA_DIALER_BASE_URL",
    "NOVA_DIALER_ADMIN_USER",
    "NOVA_DIALER_ADMIN_PASSWORD",
    "NOVA_VOICE_TO_DIALER_TOKEN",
    "NOVA_DIALER_WEBHOOK_HMAC_SECRET",
    "NOVA_ELEVENLABS_AGENT_ID",
    "NOVA_ELEVENLABS_API_KEY",
    "NOVA_ELEVENLABS_WEBHOOK_HMAC_SECRET",
    "NOVA_LIWA_API_BASE_URL",
    "NOVA_LIWA_API_TOKEN",
    "NOVA_LIWA_WEBHOOK_SECRET",
    "NOVA_LIWA_ACCOUNT_ID"
  ]) {
    assert.match(composeSource, new RegExp(`\\$\\{${variable}(?=[:}])`), `${variable} missing from Compose`);
    assert.match(environmentSource, new RegExp(`^${variable}=`, "m"), `${variable} missing from NOVA env inventory`);
  }
  assert.match(environmentSource, /^NOVA_VOICE_MODE=contract$/m);
  assert.match(environmentSource, /^NOVA_LIWA_MODE=contract$/m);
  assert.match(environmentSource, /^NOVA_BFF_HOST_PORT=8095$/m);
  assert.doesNotMatch(composeSource, /GATEWAY_TO_(?:VOICE|LIWA)_TOKEN/);

  const environment = new Map(
    environmentSource
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  );
  const dedicatedSecrets = [
    "NOVA_POSTGRES_ADMIN_PASSWORD",
    "NOVA_MIGRATOR_DATABASE_PASSWORD",
    "NOVA_DATABASE_PASSWORD",
    "VOICE_DATABASE_PASSWORD",
    "LIWA_DATABASE_PASSWORD",
    "DOCUMENTS_DATABASE_PASSWORD",
    "NOVA_BFF_TO_ACCESS_TOKEN",
    "NOVA_BFF_TO_NOVA_TOKEN",
    "NOVA_BFF_TO_VOICE_TOKEN",
    "NOVA_BFF_TO_LIWA_TOKEN",
    "NOVA_BFF_TO_DOCUMENTS_TOKEN",
    "NOVA_OPERATOR_ASSERTION_KEY",
    "NOVA_PROVIDER_EDGE_TOKEN",
    "NOVA_TO_VOICE_TOKEN",
    "NOVA_TO_LIWA_TOKEN",
    "NOVA_TO_DOCUMENTS_TOKEN",
    "VOICE_TO_NOVA_TOKEN",
    "LIWA_TO_NOVA_TOKEN",
    "DOCUMENTS_TO_NOVA_TOKEN",
    "NOVA_TO_AUDIT_TOKEN",
    "VOICE_TO_AUDIT_TOKEN",
    "LIWA_TO_AUDIT_TOKEN",
    "DOCUMENTS_TO_AUDIT_TOKEN",
    "NOVA_MINIO_ROOT_PASSWORD"
  ].map((name) => {
    const value = environment.get(name);
    assert.match(value ?? "", /^[A-Za-z][A-Za-z0-9._~-]{23,}$/, `${name} is not a safe secret placeholder`);
    return value;
  });
  assert.equal(new Set(dedicatedSecrets).size, dedicatedSecrets.length, "NOVA edge secrets must be unique");
  assert.match(
    composeSource,
    /^ {6}NOVA_PROVIDER_EDGE_TOKEN: \$\{NOVA_PROVIDER_EDGE_TOKEN:\?NOVA_PROVIDER_EDGE_TOKEN is required\}$/m
  );
  const modelResult = compose("config", "--format", "json");
  assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
  const services = JSON.parse(modelResult.stdout).services;
  assert.equal(
    services["nova-core-service"].environment.LIWA_ACCOUNT_ID,
    services["liwa-channel-service"].environment.LIWA_ACCOUNT_ID
  );
  assert.equal(services["nova-bff"].environment.NOVA_PROVIDER_EDGE_TOKEN, environment.get("NOVA_PROVIDER_EDGE_TOKEN"));
  for (const [service, descriptor] of Object.entries(services)) {
    if (service === "nova-bff") continue;
    assert.equal(
      descriptor.environment?.NOVA_PROVIDER_EDGE_TOKEN,
      undefined,
      `${service} must not receive the edge token`
    );
  }
});

test("el callback ElevenLabs recibe un secreto NOVA dedicado y falla cerrado si falta en entorno restringido", async () => {
  const [composeSource, environmentSource, voiceRoutesSource] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(environmentPath, "utf8"),
    readFile(voiceRoutesPath, "utf8")
  ]);

  assert.match(composeSource, /^ {6}ELEVENLABS_WEBHOOK_HMAC_SECRET: \$\{NOVA_ELEVENLABS_WEBHOOK_HMAC_SECRET:-\}$/m);
  assert.match(environmentSource, /^NOVA_ELEVENLABS_WEBHOOK_HMAC_SECRET=$/m);
  assert.doesNotMatch(composeSource, /ELEVENLABS_WEBHOOK_(?:HMAC_)?SECRET:\s*\$\{NOVA_ELEVENLABS_API_KEY/);

  const verifier = voiceRoutesSource.match(
    /function verifyElevenLabsWebhook\([\s\S]*?\n}\n\n\/\*\* Unwrap ElevenLabs/
  )?.[0];
  assert.ok(verifier, "ElevenLabs webhook verifier is missing");
  assert.match(
    verifier,
    /env\.ELEVENLABS_WEBHOOK_SECRET\?\.trim\(\) \|\| env\.ELEVENLABS_WEBHOOK_HMAC_SECRET\?\.trim\(\)/
  );
  assert.match(verifier, /if \(!secret\) \{\s*if \(isRestrictedDeploymentEnvironment\(env\)\)/);
  assert.match(verifier, /statusCode: 401, message: "ElevenLabs webhook secret required"/);

  for (const deployment of ["staging", "production"]) {
    const modelResult = composeWithEnvironment(
      {
        NOVA_DEPLOYMENT_ENVIRONMENT: deployment,
        NOVA_ELEVENLABS_WEBHOOK_HMAC_SECRET: ""
      },
      "config",
      "--format",
      "json"
    );
    assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
    const voiceEnvironment = JSON.parse(modelResult.stdout).services["voice-channel-service"].environment;
    assert.equal(voiceEnvironment.HYPERION_ENVIRONMENT, deployment);
    assert.equal(voiceEnvironment.ELEVENLABS_WEBHOOK_HMAC_SECRET, "");
  }
});

function compose(...arguments_) {
  return composeWith(composePath, ...arguments_);
}

function composeWith(descriptorPath, ...arguments_) {
  return spawnCompose({}, descriptorPath, ...arguments_);
}

function composeWithEnvironment(environmentOverrides, ...arguments_) {
  return spawnCompose(environmentOverrides, composePath, ...arguments_);
}

function composeAcceptance(...arguments_) {
  return spawnComposeDescriptors({}, [composePath, acceptanceComposePath], ...arguments_);
}

function composeAcceptanceWithEnvironment(environmentOverrides, ...arguments_) {
  return spawnComposeDescriptors(environmentOverrides, [composePath, acceptanceComposePath], ...arguments_);
}

function spawnCompose(environmentOverrides, descriptorPath, ...arguments_) {
  return spawnComposeDescriptors(environmentOverrides, [descriptorPath], ...arguments_);
}

function spawnComposeDescriptors(environmentOverrides, descriptorPaths, ...arguments_) {
  const descriptors = descriptorPaths.flatMap((descriptorPath) => ["-f", descriptorPath]);
  return spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    ["compose", "--env-file", environmentPath, ...descriptors, ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...dockerEnvironment, ...environmentOverrides },
      shell: false
    }
  );
}

async function startAcceptanceFixture(fixture) {
  const arguments_ = fixture.command.slice(1);
  assert.deepEqual(arguments_.slice(-2), ["18080", "0.0.0.0"]);
  arguments_.splice(-2, 2, "0", "127.0.0.1");

  const child = spawn(process.execPath, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...dockerEnvironment, ...fixture.environment },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  try {
    const port = await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`fixture did not listen in time: ${stderr}`));
      }, 5_000);
      const onStdout = (chunk) => {
        stdout += chunk;
        const match = stdout.match(/NOVA_JWKS_FIXTURE_PORT=(\d+)/);
        if (!match) return;
        cleanup();
        resolve(Number(match[1]));
      };
      const onStderr = (chunk) => {
        stderr += chunk;
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`fixture exited before listening (code=${code}, signal=${signal}): ${stderr}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("exit", onExit);
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    return { child, port };
  } catch (error) {
    await stopExactChild(child);
    throw error;
  }
}

function requestFixture(port, { method, path: requestPath, host = "identity-service" }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: { host }
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ body, statusCode: response.statusCode }));
      }
    );
    request.setTimeout(2_000, () => request.destroy(new Error("fixture request timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function stopExactChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exit = new Promise((resolve) => child.once("exit", resolve));
  if (!child.kill("SIGTERM")) throw new Error("could not stop the exact fixture child process");
  if (await settlesWithin(exit, 3_000)) return;

  if (!child.kill("SIGKILL")) throw new Error("could not kill the exact fixture child process");
  if (!(await settlesWithin(exit, 3_000))) throw new Error("fixture child remained alive after SIGKILL");
}

function settlesWithin(promise, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
