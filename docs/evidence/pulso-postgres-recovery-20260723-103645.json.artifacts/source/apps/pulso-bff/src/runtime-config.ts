const PRIVATE_HTTP_ENVIRONMENTS = new Set(["local", "development", "test", "ci"]);
const LOCAL_FALLBACK_ENVIRONMENTS = new Set(["local", "development", "test"]);

export interface PulsoBffServiceOrigins {
  access: string;
  core: string;
  sofia: string;
  "prompt-flow": string;
  knowledge: string;
  integration: string;
  whatsapp: string;
}

export function allowPrivateAccessJwksHttp(environment: NodeJS.ProcessEnv): boolean {
  if (environment.ACCESS_JWKS_ALLOW_PRIVATE_HTTP?.trim().toLowerCase() !== "true") return false;

  const deployment = (environment.HYPERION_ENVIRONMENT ?? environment.NODE_ENV ?? "local").trim().toLowerCase();
  if (!PRIVATE_HTTP_ENVIRONMENTS.has(deployment)) {
    throw new Error("ACCESS_JWKS_ALLOW_PRIVATE_HTTP is forbidden outside local/CI");
  }
  return true;
}

export function readPulsoBffServiceOrigins(environment: NodeJS.ProcessEnv): PulsoBffServiceOrigins {
  return Object.freeze({
    access: readServiceOrigin(environment, "ACCESS_SERVICE_URL", "http://localhost:8081"),
    core: readServiceOrigin(environment, "PULSO_IRIS_SERVICE_URL", "http://localhost:8088"),
    sofia: readServiceOrigin(environment, "AGENT_SERVICE_URL", "http://localhost:8083"),
    "prompt-flow": readServiceOrigin(environment, "PROMPT_FLOW_SERVICE_URL", "http://localhost:8084"),
    knowledge: readServiceOrigin(environment, "KNOWLEDGE_SERVICE_URL", "http://localhost:8085"),
    integration: readServiceOrigin(environment, "INTEGRATION_SERVICE_URL", "http://localhost:8087"),
    whatsapp: readServiceOrigin(environment, "WHATSAPP_CHANNEL_SERVICE_URL", "http://localhost:8089")
  });
}

function readServiceOrigin(environment: NodeJS.ProcessEnv, name: string, localFallback: string): string {
  const configured = environment[name]?.trim();
  const deployment = deploymentEnvironment(environment);
  if (!configured) {
    if (LOCAL_FALLBACK_ENVIRONMENTS.has(deployment)) return localFallback;
    throw new Error(`${name} is required outside local development`);
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) origin`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTP(S) origin without path, query or hash`);
  }
  return url.origin;
}

function deploymentEnvironment(environment: NodeJS.ProcessEnv): string {
  return (environment.HYPERION_ENVIRONMENT ?? environment.NODE_ENV ?? "local").trim().toLowerCase();
}
