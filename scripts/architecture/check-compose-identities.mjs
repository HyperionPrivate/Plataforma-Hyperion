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
  "lumen-service": "hyperion_lumen",
  "nova-core-service": "hyperion_nova",
  "voice-channel-service": "hyperion_voice",
  "liwa-channel-service": "hyperion_liwa",
  "documents-service": "hyperion_documents"
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

const NODE_RUNTIME_SERVICES = [...Object.keys(DATABASE_IDENTITIES), "api-gateway"];

export const DEPLOYMENT_ENVIRONMENT_BASE_SERVICES = ["migrations", "db-role-bootstrap", ...NODE_RUNTIME_SERVICES];

export const DEPLOYMENT_ENVIRONMENT_OVERLAY_SERVICES = ["nats", "jetstream-topology-bootstrap"];

const HTTP_EDGE_IDENTITIES = {
  GATEWAY_TO_IDENTITY_TOKEN: ["api-gateway", "identity-service"],
  GATEWAY_TO_INTEGRATION_TOKEN: ["api-gateway", "integration-service"],
  GATEWAY_TO_PULSO_TOKEN: ["api-gateway", "pulso-iris-service"],
  GATEWAY_TO_LUMEN_TOKEN: ["api-gateway", "lumen-service"],
  GATEWAY_TO_NOVA_TOKEN: ["api-gateway", "nova-core-service"],
  GATEWAY_TO_VOICE_TOKEN: ["api-gateway", "voice-channel-service"],
  GATEWAY_TO_LIWA_TOKEN: ["api-gateway", "liwa-channel-service"],
  GATEWAY_TO_DOCUMENTS_TOKEN: ["api-gateway", "documents-service"],
  GATEWAY_TO_TENANT_TOKEN: ["api-gateway", "tenant-service"],
  GATEWAY_TO_AUDIT_TOKEN: ["api-gateway", "audit-service"],
  GATEWAY_TO_KNOWLEDGE_TOKEN: ["api-gateway", "knowledge-service"],
  GATEWAY_TO_SOFIA_TOKEN: ["api-gateway", "agent-service"],
  GATEWAY_OPERATOR_ASSERTION_KEY: [
    "api-gateway",
    "identity-service",
    "integration-service",
    "pulso-iris-service",
    "lumen-service",
    "nova-core-service",
    "voice-channel-service",
    "liwa-channel-service",
    "documents-service"
  ],
  INTEGRATION_TO_CHANNEL_TOKEN: ["integration-service", "whatsapp-channel-service"],
  INTEGRATION_TO_SOFIA_TOKEN: ["integration-service", "agent-service"],
  CHANNEL_TO_PULSO_TOKEN: ["whatsapp-channel-service", "pulso-iris-service"],
  PULSO_TO_CHANNEL_TOKEN: ["pulso-iris-service", "whatsapp-channel-service"],
  CHANNEL_TO_AUDIT_TOKEN: ["whatsapp-channel-service", "audit-service"],
  PULSO_TO_SOFIA_TOKEN: ["pulso-iris-service", "agent-service"],
  PULSO_TO_AUDIT_TOKEN: ["pulso-iris-service", "audit-service"],
  PULSO_TO_LUMEN_TOKEN: ["pulso-iris-service", "lumen-service"],
  SOFIA_TO_CHANNEL_TOKEN: ["agent-service", "whatsapp-channel-service"],
  SOFIA_TO_PROMPT_FLOW_TOKEN: ["agent-service", "prompt-flow-service"],
  SOFIA_TO_PULSO_TOKEN: ["agent-service", "pulso-iris-service"],
  SOFIA_TO_AUDIT_TOKEN: ["agent-service", "audit-service"],
  LUMEN_TO_AUDIT_TOKEN: ["lumen-service", "audit-service"],
  ACCESS_TO_LUMEN_TOKEN: ["identity-service", "lumen-service"],
  ACCESS_TO_NOVA_TOKEN: ["identity-service", "nova-core-service"],
  NOVA_TO_AUDIT_TOKEN: ["nova-core-service", "audit-service"],
  NOVA_TO_VOICE_TOKEN: ["nova-core-service", "voice-channel-service"],
  NOVA_TO_LIWA_TOKEN: ["nova-core-service", "liwa-channel-service"],
  NOVA_TO_DOCUMENTS_TOKEN: ["nova-core-service", "documents-service"],
  VOICE_TO_AUDIT_TOKEN: ["voice-channel-service", "audit-service"],
  VOICE_TO_NOVA_TOKEN: ["voice-channel-service", "nova-core-service"],
  LIWA_TO_AUDIT_TOKEN: ["liwa-channel-service", "audit-service"],
  LIWA_TO_NOVA_TOKEN: ["liwa-channel-service", "nova-core-service"],
  DOCUMENTS_TO_AUDIT_TOKEN: ["documents-service", "audit-service"],
  DOCUMENTS_TO_NOVA_TOKEN: ["documents-service", "nova-core-service"]
};

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
  problems.push(...roleBootstrapDependencyProblems(base));
  problems.push(...eventTransportProblems(base, overlay));
  problems.push(...deploymentEnvironmentProblems(base, overlay));
  problems.push(...httpWorkloadIdentityProblems(base));
  problems.push(...shutdownLifecycleProblems(base));

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

export function roleBootstrapDependencyProblems(configuration) {
  const services = configuration.services ?? {};
  const problems = [];
  const migrations = services.migrations;
  const bootstrap = services["db-role-bootstrap"];

  if (migrations?.depends_on?.postgres?.condition !== "service_healthy") {
    problems.push("migrations must wait for healthy postgres");
  }
  if (migrations?.depends_on?.["db-role-bootstrap"] !== undefined) {
    problems.push("migrations must run before db-role-bootstrap");
  }
  if (bootstrap?.depends_on?.migrations?.condition !== "service_completed_successfully") {
    problems.push("db-role-bootstrap must wait for successful migrations");
  }

  for (const serviceName of Object.keys(DATABASE_IDENTITIES).filter((name) => services[name])) {
    if (!dependsTransitivelyOn(services, serviceName, "db-role-bootstrap", new Set())) {
      problems.push(`${serviceName} must not start before db-role-bootstrap completes`);
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

export function deploymentEnvironmentProblems(
  base,
  overlay,
  baseServiceNames = DEPLOYMENT_ENVIRONMENT_BASE_SERVICES,
  overlayServiceNames = DEPLOYMENT_ENVIRONMENT_OVERLAY_SERVICES
) {
  const problems = [];
  const observed = new Set();
  const allowed = new Set(["local", "ci", "staging", "production"]);

  for (const [configuration, serviceNames] of [
    [base, baseServiceNames],
    [overlay, overlayServiceNames]
  ]) {
    for (const serviceName of serviceNames) {
      const environment = configuration.services?.[serviceName]?.environment ?? {};
      const deploymentEnvironment = environment.HYPERION_ENVIRONMENT;
      if (typeof deploymentEnvironment !== "string" || !allowed.has(deploymentEnvironment.toLowerCase())) {
        problems.push(`${serviceName} must declare HYPERION_ENVIRONMENT as local, ci, staging or production`);
      } else {
        observed.add(deploymentEnvironment.toLowerCase());
      }

      if (Object.prototype.hasOwnProperty.call(environment, "HYPERION_ALLOW_EXAMPLE_SECRETS")) {
        problems.push(`${serviceName} must not receive the legacy HYPERION_ALLOW_EXAMPLE_SECRETS bypass`);
      }
      if (Object.prototype.hasOwnProperty.call(environment, "CI")) {
        problems.push(`${serviceName} must not use ambient CI as a deployment security decision`);
      }
    }
  }

  if (observed.size > 1) {
    problems.push("all environment-aware Compose workloads must receive the same HYPERION_ENVIRONMENT");
  }
  return problems;
}

export function httpWorkloadIdentityProblems(configuration, edges = HTTP_EDGE_IDENTITIES) {
  const services = configuration.services ?? {};
  const problems = [];
  const resolvedSecrets = new Map();

  for (const [serviceName, service] of Object.entries(services)) {
    if (Object.prototype.hasOwnProperty.call(service.environment ?? {}, "INTERNAL_SERVICE_TOKEN")) {
      problems.push(`${serviceName} must not receive the legacy INTERNAL_SERVICE_TOKEN`);
    }
  }

  for (const [variableName, endpoints] of Object.entries(edges)) {
    const expectedServices = new Set(endpoints);
    const placements = Object.entries(services)
      .filter(([, service]) => Object.prototype.hasOwnProperty.call(service.environment ?? {}, variableName))
      .map(([serviceName]) => serviceName);

    for (const serviceName of endpoints) {
      const value = services[serviceName]?.environment?.[variableName];
      if (typeof value !== "string" || value.length === 0) {
        problems.push(`${serviceName} must receive ${variableName}`);
      }
    }
    for (const serviceName of placements) {
      if (!expectedServices.has(serviceName)) {
        problems.push(`${serviceName} must not receive unrelated credential ${variableName}`);
      }
    }

    const values = endpoints
      .map((serviceName) => services[serviceName]?.environment?.[variableName])
      .filter((value) => typeof value === "string");
    const value = values[0];
    if (values.length === endpoints.length && new Set(values).size !== 1) {
      problems.push(`${variableName} must resolve to the same value at both edge endpoints`);
      continue;
    }
    if (typeof value === "string") {
      if (!/^[A-Za-z][A-Za-z0-9._~-]{23,}$/.test(value)) {
        problems.push(`${variableName} must use the safe production secret contract`);
      } else {
        const duplicate = resolvedSecrets.get(value);
        if (duplicate) problems.push(`${variableName} must not reuse the value of ${duplicate}`);
        else resolvedSecrets.set(value, variableName);
      }
    }
  }

  const channel = services["whatsapp-channel-service"];
  if (channel) {
    const phoneHashKey = channel.environment?.WHATSAPP_PHONE_HASH_KEY;
    if (typeof phoneHashKey !== "string" || !/^[A-Za-z][A-Za-z0-9._~-]{31,511}$/.test(phoneHashKey)) {
      problems.push("whatsapp-channel-service must receive a dedicated safe WHATSAPP_PHONE_HASH_KEY");
    } else {
      const reusedBy = resolvedSecrets.get(phoneHashKey);
      if (reusedBy) problems.push(`WHATSAPP_PHONE_HASH_KEY must not reuse the value of ${reusedBy}`);
    }
  }

  return problems;
}

export function shutdownLifecycleProblems(configuration, serviceNames = NODE_RUNTIME_SERVICES) {
  const problems = [];
  const services = configuration.services ?? {};

  for (const serviceName of serviceNames) {
    const service = services[serviceName];
    if (!service) continue;

    const timeout = Number(service.environment?.SHUTDOWN_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeout) || timeout < 55_000 || timeout > 900_000) {
      problems.push(`${serviceName} must declare a valid SHUTDOWN_TIMEOUT_MS between 55000 and 900000`);
      continue;
    }

    const grace = composeDurationMilliseconds(service.stop_grace_period);
    if (grace === undefined) {
      problems.push(`${serviceName} must declare stop_grace_period`);
    } else if (grace < timeout + 5_000) {
      problems.push(`${serviceName} stop_grace_period must exceed SHUTDOWN_TIMEOUT_MS by at least 5000ms`);
    }
  }

  return problems;
}

function composeDurationMilliseconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value / 1_000_000;
  if (typeof value !== "string") return undefined;

  const units = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const parts = [...value.matchAll(/(\d+)(ms|s|m|h)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== value) return undefined;
  return parts.reduce((total, part) => total + Number(part[1]) * units[part[2]], 0);
}

function requireService(configuration, serviceName, problems) {
  const service = configuration.services?.[serviceName];
  if (!service) problems.push(`Compose service ${serviceName} is missing`);
  return service;
}

function dependsTransitivelyOn(services, serviceName, target, visited) {
  if (visited.has(serviceName)) return false;
  visited.add(serviceName);
  const dependencies = services[serviceName]?.depends_on ?? {};
  if (dependencies[target]?.condition === "service_completed_successfully") return true;
  return Object.keys(dependencies).some((dependency) => {
    if (dependency === "postgres" || dependency === "migrations") return false;
    return dependsTransitivelyOn(services, dependency, target, new Set(visited));
  });
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
