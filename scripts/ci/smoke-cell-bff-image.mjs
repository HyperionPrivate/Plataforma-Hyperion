import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { CELL_SMOKE_TARGETS, assertCell } from "../architecture/cell-policy.mjs";

const execFileAsync = promisify(execFile);
const SAFE_JWKS_ORIGIN = "https://access.invalid";
const FIXTURE_PORT = 18_080;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const READINESS_CLIENT_TIMEOUT_MS = 8_000;
const SMOKE_LABEL = "io.hyperion.ci.cell-bff-smoke";
const READINESS_JWK = Object.freeze({
  kty: "RSA",
  n: "6-WSs_gwDVF2lRPMactVU0Z80n7mSA0XJxZVoY2TFovhae92dZNbGx_g5bnbMhthKTdUUe8iKw5UDZnUcxt4NIZDoBU8QVNzVIZlFWB5JzopMWDt5QA_wQ4t283uRV11GSPiKvRLvMvvRXSuRgig_To71yCpaR06-7TpLgl1k8lMh_xWpeUGfThJ80XIG4ypwcBGh39xwwh8k3kmMup5bkH-NrQ01_Q9LZ-hD1w2BNNB_1RWrCRB_hLuuTVyI__7K53Fh6xB91cGzFBQ44qpK-_oPdObUDKyzPVbQYV_KdX8xu6zkpD8ck6DUYvzgmJOWYrgEikvAvXi4xXgEfI89Q",
  e: "AQAB",
  kid: "hyperion-ci-readiness",
  alg: "RS256",
  use: "sig"
});
const CELL_RUNTIME_ORIGINS = Object.freeze({
  platform: Object.freeze({}),
  nova: Object.freeze({
    // NOVA BFF private-HTTP allowlist is identity-service (Access alias), not access-service.
    ACCESS_SERVICE_URL: `http://identity-service:${FIXTURE_PORT}`,
    NOVA_CORE_SERVICE_URL: `http://nova-core-service:${FIXTURE_PORT}`,
    VOICE_CHANNEL_SERVICE_URL: `http://voice-channel-service:${FIXTURE_PORT}`,
    LIWA_CHANNEL_SERVICE_URL: `http://liwa-channel-service:${FIXTURE_PORT}`,
    DOCUMENTS_SERVICE_URL: `http://documents-service:${FIXTURE_PORT}`
  }),
  lumen: Object.freeze({
    ACCESS_SERVICE_URL: `http://identity-service:${FIXTURE_PORT}`,
    LUMEN_SERVICE_URL: `http://lumen-service:${FIXTURE_PORT}`
  }),
  pulso: Object.freeze({
    ACCESS_SERVICE_URL: `http://identity-service:${FIXTURE_PORT}`,
    PULSO_IRIS_SERVICE_URL: `http://pulso-iris-service:${FIXTURE_PORT}`,
    AGENT_SERVICE_URL: `http://agent-service:${FIXTURE_PORT}`,
    PROMPT_FLOW_SERVICE_URL: `http://prompt-flow-service:${FIXTURE_PORT}`,
    KNOWLEDGE_SERVICE_URL: `http://knowledge-service:${FIXTURE_PORT}`,
    INTEGRATION_SERVICE_URL: `http://integration-service:${FIXTURE_PORT}`,
    WHATSAPP_CHANNEL_SERVICE_URL: `http://whatsapp-channel-service:${FIXTURE_PORT}`
  })
});
const PRODUCT_FIXTURE_POLICIES = Object.freeze({
  nova: Object.freeze({
    aliases: Object.freeze([
      "identity-service",
      "access-service",
      "nova-core-service",
      "voice-channel-service",
      "liwa-channel-service",
      "documents-service"
    ]),
    readyHosts: Object.freeze([
      "nova-core-service",
      "voice-channel-service",
      "liwa-channel-service",
      "documents-service"
    ]),
    requiredDependencies: Object.freeze(["nova-core", "nova-voice", "nova-liwa", "nova-documents"]),
    credentialNames: Object.freeze([
      "NOVA_BFF_TO_ACCESS_TOKEN",
      "NOVA_BFF_TO_NOVA_TOKEN",
      "NOVA_BFF_TO_VOICE_TOKEN",
      "NOVA_BFF_TO_LIWA_TOKEN",
      "NOVA_BFF_TO_DOCUMENTS_TOKEN",
      "NOVA_OPERATOR_ASSERTION_KEY"
    ])
  }),
  lumen: Object.freeze({
    aliases: Object.freeze(["identity-service", "access-service", "lumen-service"]),
    readyHosts: Object.freeze(["lumen-service"]),
    requiredDependencies: Object.freeze(["lumen"]),
    credentialNames: Object.freeze([
      "LUMEN_BFF_TO_ACCESS_TOKEN",
      "LUMEN_BFF_TO_LUMEN_TOKEN",
      "LUMEN_OPERATOR_ASSERTION_KEY"
    ])
  }),
  pulso: Object.freeze({
    aliases: Object.freeze([
      "identity-service",
      "access-service",
      "pulso-iris-service",
      "agent-service",
      "prompt-flow-service",
      "knowledge-service",
      "integration-service",
      "whatsapp-channel-service"
    ]),
    readyHosts: Object.freeze(["pulso-iris-service", "integration-service"]),
    requiredDependencies: Object.freeze(["pulso-core", "pulso-integration"]),
    credentialNames: Object.freeze([
      "PULSO_BFF_TO_ACCESS_TOKEN",
      "PULSO_BFF_TO_CORE_TOKEN",
      "PULSO_BFF_TO_INTEGRATION_TOKEN",
      "PULSO_OPERATOR_ASSERTION_KEY"
    ])
  })
});

export function smokeConfiguration(cell) {
  assertCell(cell);
  const target = CELL_SMOKE_TARGETS[cell];
  const productFixture = PRODUCT_FIXTURE_POLICIES[cell];
  return Object.freeze({
    ...target,
    probePaths: Object.freeze(cell === "platform" ? ["/health"] : ["/health", "/ready"]),
    ...(productFixture ? { productFixture } : {}),
    environment: Object.freeze({
      NODE_ENV: "production",
      HYPERION_ENVIRONMENT: "ci",
      PORT: String(target.containerPort),
      ACCESS_JWKS_URL: productFixture
        ? `http://identity-service:${FIXTURE_PORT}/jwks`
        : `${SAFE_JWKS_ORIGIN}/.well-known/jwks.json`,
      ACCESS_TOKEN_ISSUER: SAFE_JWKS_ORIGIN,
      ACCESS_TOKEN_AUDIENCE: target.audience,
      ACCESS_JWKS_ALLOW_PRIVATE_HTTP: productFixture ? "true" : "false",
      ...CELL_RUNTIME_ORIGINS[cell]
    })
  });
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--image") options.image = argv[++index];
    else if (argument === "--timeout-ms") options.timeoutMs = parsePositiveInteger(argv[++index], argument);
    else if (argument === "--poll-ms") options.pollIntervalMs = parsePositiveInteger(argv[++index], argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.cell) throw new Error("--cell is required");
  assertCell(options.cell);
  if (!options.image || options.image.startsWith("-")) throw new Error("--image must be a Docker image reference");
  return options;
}

export async function runCellBffImageSmoke(options, dependencies = {}) {
  const configuration = smokeConfiguration(options.cell);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const docker = dependencies.docker ?? defaultDocker;
  const request = dependencies.fetch ?? globalThis.fetch;
  const wait = dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;

  if (options.cell !== "platform") {
    return runProductCellBffImageSmoke({
      cell: options.cell,
      image: options.image,
      configuration,
      timeoutMs,
      pollIntervalMs,
      docker,
      wait,
      now
    });
  }

  return runPlatformBffImageSmoke({
    cell: options.cell,
    image: options.image,
    configuration,
    timeoutMs,
    pollIntervalMs,
    docker,
    request,
    wait,
    now
  });
}

async function runPlatformBffImageSmoke({
  cell,
  image,
  configuration,
  timeoutMs,
  pollIntervalMs,
  docker,
  request,
  wait,
  now
}) {
  const containerName = `hyperion-${cell}-bff-smoke-${randomUUID()}`;
  const runArguments = bffRunArguments({ cell, image, configuration, containerName });

  let started = false;
  try {
    await docker(runArguments);
    started = true;
    const deadline = now() + timeoutMs;
    let lastError = new Error("container has not exposed its HTTP port yet");

    while (now() <= deadline) {
      const state = await inspectContainerState(docker, containerName);
      if (!state.running) {
        const logs = await readContainerLogs(docker, containerName);
        throw new Error(
          `${configuration.expectedService} exited before readiness (exit ${state.exitCode})${formatLogs(logs)}`
        );
      }

      try {
        const hostPort = await publishedHostPort(docker, containerName, configuration.containerPort);
        const baseUrl = `http://127.0.0.1:${hostPort}`;
        for (const probePath of configuration.probePaths) {
          await probeEndpoint(request, `${baseUrl}${probePath}`, configuration.expectedService);
        }
        return { containerName, baseUrl, service: configuration.expectedService };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (now() >= deadline) break;
      await wait(pollIntervalMs);
    }

    const logs = await readContainerLogs(docker, containerName);
    throw new Error(
      `${configuration.expectedService} did not pass its isolated image health contract within ${timeoutMs}ms: ${lastError.message}${formatLogs(logs)}`
    );
  } finally {
    if (started) await removeContainer(docker, containerName);
  }
}

async function runProductCellBffImageSmoke({
  cell,
  image,
  configuration,
  timeoutMs,
  pollIntervalMs,
  docker,
  wait,
  now
}) {
  const policy = configuration.productFixture;
  if (!policy) throw new Error(`Missing readiness fixture policy for ${cell}`);

  const runId = randomUUID();
  const containerName = `hyperion-${cell}-bff-smoke-${runId}`;
  const fixtureName = `hyperion-${cell}-bff-fixture-${runId}`;
  const networkName = `hyperion-${cell}-bff-smoke-${runId}`;
  const runtimeEnvironment = {
    ...configuration.environment,
    ...ephemeralCredentialEnvironment(policy.credentialNames)
  };
  const resources = { bffStarted: false, fixtureStarted: false, networkCreated: false };
  let result;
  let failure;

  try {
    await docker([
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--label",
      `${SMOKE_LABEL}=${cell}`,
      networkName
    ]);
    resources.networkCreated = true;

    await docker(
      bffRunArguments({
        cell,
        image,
        configuration,
        containerName,
        networkName,
        environment: runtimeEnvironment,
        publish: false
      })
    );
    resources.bffStarted = true;

    const deadline = now() + timeoutMs;
    const baseUrl = await waitForLiveness({
      docker,
      wait,
      now,
      deadline,
      timeoutMs,
      pollIntervalMs,
      containerName,
      configuration
    });

    await probeReadinessContract(docker, containerName, configuration, "cold");

    await docker(fixtureRunArguments({ cell, image, fixtureName, networkName, policy }));
    resources.fixtureStarted = true;

    await waitForWarmReadiness({
      docker,
      wait,
      now,
      deadline,
      pollIntervalMs,
      containerName,
      fixtureName,
      configuration
    });
    result = { containerName, baseUrl, service: configuration.expectedService };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupErrors = await cleanupProductSmokeResources(docker, resources, {
    containerName,
    fixtureName,
    networkName
  });
  if (failure) {
    if (cleanupErrors.length === 0) throw failure;
    throw new Error(`${failure.message}${formatCleanupErrors(cleanupErrors)}`, { cause: failure });
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Product BFF smoke cleanup failed${formatCleanupErrors(cleanupErrors)}`);
  }
  return result;
}

function bffRunArguments({ cell, image, configuration, containerName, networkName, environment, publish = true }) {
  const dockerEnvironment = Object.entries(environment ?? configuration.environment).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`
  ]);
  return [
    "run",
    "--detach",
    "--name",
    containerName,
    "--label",
    `${SMOKE_LABEL}=${cell}`,
    ...(networkName ? ["--network", networkName] : []),
    ...(publish ? ["--publish", `127.0.0.1::${configuration.containerPort}`] : []),
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    ...dockerEnvironment,
    image,
    "node",
    configuration.artifact
  ];
}

function fixtureRunArguments({ cell, image, fixtureName, networkName, policy }) {
  const aliases = policy.aliases.flatMap((alias) => ["--network-alias", alias]);
  return [
    "run",
    "--detach",
    "--name",
    fixtureName,
    "--label",
    `${SMOKE_LABEL}=${cell}`,
    "--network",
    networkName,
    ...aliases,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=8m",
    image,
    "node",
    "--input-type=module",
    "--eval",
    readinessFixtureSource(policy.readyHosts)
  ];
}

function readinessFixtureSource(readyHosts) {
  return [
    `import { createServer } from "node:http"`,
    `const jwk=${JSON.stringify(READINESS_JWK)}`,
    `const readyHosts=new Set(${JSON.stringify(readyHosts)})`,
    `const send=(response,status,payload)=>{const body=JSON.stringify(payload);response.writeHead(status,{"content-type":"application/json","content-length":Buffer.byteLength(body),"cache-control":"no-store"});response.end(body)}`,
    `createServer((request,response)=>{const host=String(request.headers.host??"").split(":",1)[0].toLowerCase();if(request.method==="GET"&&request.url==="/jwks"&&host==="identity-service")return send(response,200,{keys:[jwk]});if(request.method==="GET"&&request.url==="/ready"&&host==="access-service")return send(response,503,{status:"down"});if(request.method==="GET"&&request.url==="/ready"&&readyHosts.has(host))return send(response,200,{service:host,status:"ok"});return send(response,404,{status:"not-found"})}).listen(${FIXTURE_PORT},"0.0.0.0")`
  ].join(";");
}

function ephemeralCredentialEnvironment(names) {
  return Object.fromEntries(names.map((name) => [name, `ci-${randomBytes(32).toString("base64url")}`]));
}

async function waitForLiveness({
  docker,
  wait,
  now,
  deadline,
  timeoutMs,
  pollIntervalMs,
  containerName,
  configuration
}) {
  let lastError = new Error("container has not exposed its HTTP port yet");
  while (now() <= deadline) {
    const state = await inspectContainerState(docker, containerName);
    if (!state.running) {
      const logs = await readContainerLogs(docker, containerName);
      throw new Error(
        `${configuration.expectedService} exited before readiness (exit ${state.exitCode})${formatLogs(logs)}`
      );
    }
    try {
      const probe = await probeContainerEndpoint(docker, containerName, configuration.containerPort, "/health", 2_000);
      if (
        probe.httpStatus !== 200 ||
        probe.body?.status !== "ok" ||
        probe.body?.service !== configuration.expectedService
      ) {
        throw new Error(`container returned an invalid liveness contract: ${JSON.stringify(probe)}`);
      }
      return `docker-exec://${containerName}:${configuration.containerPort}`;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (now() >= deadline) break;
    await wait(pollIntervalMs);
  }
  const logs = await readContainerLogs(docker, containerName);
  throw new Error(
    `${configuration.expectedService} did not pass its isolated image health contract within ${timeoutMs}ms: ${lastError.message}${formatLogs(logs)}`
  );
}

async function waitForWarmReadiness({
  docker,
  wait,
  now,
  deadline,
  pollIntervalMs,
  containerName,
  fixtureName,
  configuration
}) {
  let lastError = new Error("readiness fixture has not warmed the BFF yet");
  while (now() <= deadline) {
    for (const [name, label] of [
      [containerName, configuration.expectedService],
      [fixtureName, "readiness fixture"]
    ]) {
      const state = await inspectContainerState(docker, name);
      if (!state.running) {
        const logs = await readContainerLogs(docker, name);
        throw new Error(`${label} exited before warm readiness (exit ${state.exitCode})${formatLogs(logs)}`);
      }
    }
    try {
      await probeReadinessContract(docker, containerName, configuration, "warm");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (now() >= deadline) break;
    await wait(pollIntervalMs);
  }
  const [bffLogs, fixtureLogs] = await Promise.all([
    readContainerLogs(docker, containerName),
    readContainerLogs(docker, fixtureName)
  ]);
  const combinedLogs = [bffLogs, fixtureLogs].filter(Boolean).join("\n");
  throw new Error(
    `${configuration.expectedService} did not reach warm dependency readiness: ${lastError.message}${formatLogs(combinedLogs)}`
  );
}

async function probeReadinessContract(docker, containerName, configuration, phase) {
  // Every BFF fans its dependency probes out in parallel with a 3s per-probe
  // timeout. Keep the in-container client deadline comfortably above that
  // budget so CI observes the fail-closed response instead of racing the BFF.
  const url = `docker-exec://${containerName}:${configuration.containerPort}/ready`;
  const response = await probeContainerEndpoint(
    docker,
    containerName,
    configuration.containerPort,
    "/ready",
    READINESS_CLIENT_TIMEOUT_MS
  );
  const expectedHttpStatus = phase === "cold" ? 503 : 200;
  if (response.httpStatus !== expectedHttpStatus) {
    throw new Error(
      `${url} returned HTTP ${response.httpStatus}; expected ${expectedHttpStatus} during ${phase} readiness`
    );
  }
  const body = response.body;
  const expectedStatus = phase === "cold" ? "down" : "ok";
  if (body?.service !== configuration.expectedService || body?.status !== expectedStatus) {
    throw new Error(`${url} returned an invalid ${phase} readiness contract: ${JSON.stringify(body)}`);
  }

  const requiredStatus = phase === "cold" ? "down" : "ok";
  const expectedDependencies = [
    { name: "access-signing-keys", status: requiredStatus, required: true },
    { name: "access-token-minting", status: "degraded", required: false },
    ...configuration.productFixture.requiredDependencies.map((name) => ({
      name,
      status: requiredStatus,
      required: true
    }))
  ].sort(compareReadinessDependencies);
  const actualDependencies = Array.isArray(body.dependencies)
    ? body.dependencies
        .map((dependency) => ({
          name: dependency?.name,
          status: dependency?.status,
          required: dependency?.required
        }))
        .sort(compareReadinessDependencies)
    : [];
  if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
    throw new Error(
      `${url} returned unexpected ${phase} readiness dependencies: ${JSON.stringify(actualDependencies)}`
    );
  }
}

async function probeContainerEndpoint(docker, containerName, port, endpointPath, timeoutMs) {
  const source = [
    `const response=await fetch(${JSON.stringify(`http://127.0.0.1:${port}${endpointPath}`)},{signal:AbortSignal.timeout(${timeoutMs})})`,
    `const body=await response.json()`,
    `process.stdout.write(JSON.stringify({httpStatus:response.status,body}))`
  ].join(";");
  let result;
  try {
    result = await docker(["exec", containerName, "node", "--input-type=module", "--eval", source]);
  } catch (error) {
    throw new Error(`cannot probe ${endpointPath} inside ${containerName}: ${errorMessage(error)}`, { cause: error });
  }
  try {
    const probe = JSON.parse(result.stdout.trim());
    if (!Number.isInteger(probe?.httpStatus) || typeof probe?.body !== "object" || probe.body === null) {
      throw new Error("invalid probe shape");
    }
    return probe;
  } catch (error) {
    throw new Error(`unexpected in-container probe output from ${containerName}: ${JSON.stringify(result.stdout)}`, {
      cause: error
    });
  }
}

function compareReadinessDependencies(left, right) {
  return String(left.name).localeCompare(String(right.name));
}

async function cleanupProductSmokeResources(docker, resources, names) {
  const errors = [];
  for (const [created, name] of [
    [resources.bffStarted, names.containerName],
    [resources.fixtureStarted, names.fixtureName]
  ]) {
    if (!created) continue;
    try {
      await docker(["rm", "--force", name]);
    } catch (error) {
      errors.push(new Error(`cannot remove smoke container ${name}: ${errorMessage(error)}`, { cause: error }));
    }
  }
  if (resources.networkCreated) {
    try {
      await docker(["network", "rm", names.networkName]);
    } catch (error) {
      errors.push(
        new Error(`cannot remove smoke network ${names.networkName}: ${errorMessage(error)}`, { cause: error })
      );
    }
  }
  return errors;
}

function formatCleanupErrors(errors) {
  return errors.length === 0 ? "" : `\ncleanup failures:\n${errors.map((error) => error.message).join("\n")}`;
}

async function inspectContainerState(docker, containerName) {
  let result;
  try {
    result = await docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", containerName]);
  } catch (error) {
    throw new Error(`cannot inspect smoke container ${containerName}: ${errorMessage(error)}`, { cause: error });
  }
  const match = result.stdout.trim().match(/^(true|false)\s+(-?\d+)$/);
  if (!match) throw new Error(`unexpected Docker state for ${containerName}: ${JSON.stringify(result.stdout.trim())}`);
  return { running: match[1] === "true", exitCode: Number(match[2]) };
}

async function publishedHostPort(docker, containerName, containerPort) {
  const result = await docker(["port", containerName, `${containerPort}/tcp`]);
  const binding = result.stdout
    .trim()
    .split(/\r?\n/)
    .find((value) => value.startsWith("127.0.0.1:"));
  const match = binding?.match(/^127\.0\.0\.1:(\d+)$/);
  if (!match) throw new Error(`Docker did not publish ${containerPort}/tcp on loopback`);
  return Number(match[1]);
}

async function probeEndpoint(request, url, expectedService) {
  const response = await request(url, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`${url} did not return JSON`, { cause: error });
  }
  if (body?.status !== "ok" || body?.service !== expectedService) {
    throw new Error(`${url} returned an invalid image health contract: ${JSON.stringify(body)}`);
  }
}

async function readContainerLogs(docker, containerName) {
  try {
    const result = await docker(["logs", "--tail", "80", containerName]);
    return [result.stdout, result.stderr]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

async function removeContainer(docker, containerName) {
  try {
    await docker(["rm", "--force", containerName]);
  } catch {
    // A container created with an external Docker policy may already be gone.
  }
}

function formatLogs(logs) {
  return logs ? `\ncontainer logs:\n${logs}` : "";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

async function defaultDocker(arguments_) {
  return execFileAsync("docker", arguments_, { encoding: "utf8", maxBuffer: 1024 * 1024 });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runCellBffImageSmoke(options);
  process.stdout.write(`${result.service} passed its isolated image health contract at ${result.baseUrl}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
