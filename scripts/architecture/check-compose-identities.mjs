import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const DATABASE_IDENTITIES = {
  "identity-service": "hyperion_access",
  "tenant-service": "hyperion_access",
  "agent-service": "hyperion_sofia",
  "prompt-flow-service": "hyperion_sofia",
  "knowledge-service": "hyperion_knowledge",
  "audit-service": "hyperion_audit",
  "integration-service": "hyperion_integration",
  "pulso-iris-service": "hyperion_pulso",
  "whatsapp-channel-service": "hyperion_channel",
  "lumen-service": "hyperion_lumen"
};

const NATS_IDENTITIES = {
  "agent-service": "sofia",
  "audit-service": "audit",
  "pulso-iris-service": "pulso",
  "whatsapp-channel-service": "channel",
  "lumen-service": "lumen",
  "jetstream-topology-bootstrap": "topology"
};

const NATS_SECRET_NAMES = [
  "NATS_TOPOLOGY_PASSWORD",
  "NATS_CHANNEL_PASSWORD",
  "NATS_PULSO_PASSWORD",
  "NATS_SOFIA_PASSWORD",
  "NATS_AUDIT_PASSWORD",
  "NATS_LUMEN_PASSWORD"
];

const DURABLE_EVENT_SERVICES = [
  "agent-service",
  "audit-service",
  "pulso-iris-service",
  "whatsapp-channel-service",
  "lumen-service"
];

export function validateComposeIdentities(base, overlay) {
  const problems = [];

  for (const [serviceName, expectedRole] of Object.entries(DATABASE_IDENTITIES)) {
    const environment = requireService(base, serviceName, problems)?.environment ?? {};
    if (environment.EXPECTED_DATABASE_ROLE !== expectedRole) {
      problems.push(`${serviceName} must declare EXPECTED_DATABASE_ROLE=${expectedRole}`);
    }
    const databaseUser = connectionUsername(environment.DATABASE_URL, `${serviceName}.DATABASE_URL`, problems);
    if (databaseUser !== expectedRole) {
      problems.push(`${serviceName} DATABASE_URL must authenticate as ${expectedRole}`);
    }
  }

  for (const serviceName of ["db-role-bootstrap", "migrations"]) {
    const environment = requireService(base, serviceName, problems)?.environment ?? {};
    const databaseUser = connectionUsername(environment.DATABASE_URL, `${serviceName}.DATABASE_URL`, problems);
    if (!databaseUser || Object.values(DATABASE_IDENTITIES).includes(databaseUser)) {
      problems.push(`${serviceName} must use the separate migration administrator identity`);
    }
  }

  for (const serviceName of ["api-gateway", "web-console"]) {
    const environment = requireService(base, serviceName, problems)?.environment ?? {};
    if (environment.DATABASE_URL) problems.push(`${serviceName} must not receive DATABASE_URL`);
  }

  problems.push(...gatewayDependencyProblems(base));
  problems.push(...eventTransportProblems(base, overlay));

  for (const [serviceName, expectedUser] of Object.entries(NATS_IDENTITIES)) {
    const service = requireService(overlay, serviceName, problems);
    const environment = service?.environment ?? {};
    if (environment.NATS_USERNAME !== expectedUser) {
      problems.push(`${serviceName} must declare NATS_USERNAME=${expectedUser}`);
    }
    if (environment.NATS_AUTH_TOKEN) problems.push(`${serviceName} must not receive the shared NATS token`);
    connectionUsername(environment.NATS_URL, `${serviceName}.NATS_URL`, problems, true);
  }

  const topologyTarget = overlay.services?.["jetstream-topology-bootstrap"]?.build?.target;
  if (topologyTarget !== "jetstream-topology-bootstrap") {
    problems.push("JetStream topology bootstrap must use its isolated Docker target");
  }

  const natsEnvironment = requireService(overlay, "nats", problems)?.environment ?? {};
  const natsSecrets = NATS_SECRET_NAMES.map((name) => natsEnvironment[name]);
  for (const [index, secret] of natsSecrets.entries()) {
    if (typeof secret !== "string" || !/^[A-Za-z][A-Za-z0-9._~-]{23,}$/.test(secret)) {
      problems.push(`${NATS_SECRET_NAMES[index]} must use the safe production placeholder contract`);
    }
  }
  if (new Set(natsSecrets).size !== natsSecrets.length) {
    problems.push("NATS service passwords must be distinct");
  }

  if (problems.length > 0) {
    throw new Error(`Compose identity check failed:\n- ${problems.join("\n- ")}`);
  }
}

export function gatewayDependencyProblems(configuration) {
  const gateway = configuration.services?.["api-gateway"];
  if (!gateway) return ["Compose service api-gateway is missing"];

  const problems = [];
  for (const [variableName, value] of Object.entries(gateway.environment ?? {})) {
    if (!variableName.endsWith("_SERVICE_URL")) continue;

    let upstreamService;
    try {
      upstreamService = new URL(value).hostname;
    } catch {
      problems.push(`api-gateway ${variableName} must be a valid internal service URL`);
      continue;
    }

    if (!configuration.services?.[upstreamService]) {
      problems.push(`api-gateway ${variableName} references missing Compose service ${upstreamService}`);
      continue;
    }

    if (gateway.depends_on?.[upstreamService] !== undefined) {
      problems.push(
        `api-gateway must not use a startup dependency on ${upstreamService}; downstream availability is runtime state`
      );
    }
  }
  return problems;
}

export function eventTransportProblems(base, overlay) {
  const problems = [];
  if (base.services?.nats) problems.push("Base Compose must not include NATS");
  if (!overlay.services?.nats) problems.push("JetStream overlay must include NATS");

  for (const serviceName of DURABLE_EVENT_SERVICES) {
    if (base.services?.[serviceName]?.environment?.DURABLE_EVENT_TRANSPORT !== "http") {
      problems.push(`${serviceName} must use the HTTP rollback transport in base Compose`);
    }
    if (overlay.services?.[serviceName]?.environment?.DURABLE_EVENT_TRANSPORT !== "jetstream") {
      problems.push(`${serviceName} must use JetStream when the overlay is active`);
    }
  }
  return problems;
}

function requireService(configuration, serviceName, problems) {
  const service = configuration.services?.[serviceName];
  if (!service) problems.push(`Compose service ${serviceName} is missing`);
  return service;
}

function connectionUsername(value, label, problems, allowNoUser = false) {
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`${label} is missing`);
    return undefined;
  }
  try {
    const url = new URL(value);
    if (allowNoUser) {
      if (url.username || url.password) problems.push(`${label} must not embed credentials`);
      return url.username;
    }
    if (!url.username) problems.push(`${label} must contain a database identity`);
    return decodeURIComponent(url.username);
  } catch {
    problems.push(`${label} is not a valid URL`);
    return undefined;
  }
}

function renderCompose(files) {
  const argumentsList = [
    "compose",
    "--env-file",
    ".env.example",
    ...files.flatMap((file) => ["-f", file]),
    "config",
    "--format",
    "json"
  ];
  const result = spawnSync("docker", argumentsList, { encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`Could not render Compose configuration: ${(result.stderr || "unknown error").trim()}`);
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const base = renderCompose(["infra/docker-compose.yml"]);
  const overlay = renderCompose(["infra/docker-compose.yml", "infra/docker-compose.jetstream.yml"]);
  validateComposeIdentities(base, overlay);
  process.stdout.write("Compose service identities OK\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
