import type { ServiceName } from "@hyperion/contracts";
import { readDeploymentEnvironment } from "./deployment-environment.js";

export {
  HYPERION_DEPLOYMENT_ENVIRONMENTS,
  isCiDeploymentEnvironment,
  isRestrictedDeploymentEnvironment,
  readDeploymentEnvironment,
  type HyperionDeploymentEnvironment
} from "./deployment-environment.js";

export {
  assertNoPlaceholderSecrets,
  ENV_EXAMPLE_PLACEHOLDER_VALUES,
  findPlaceholderSecretProblems,
  isPlaceholderSecret,
  REQUIRED_SECRET_ENV_KEYS,
  shouldEnforcePlaceholderRejection
} from "./secret-placeholders.js";

export interface ServiceConfig {
  serviceName: ServiceName;
  environment: string;
  host: string;
  port: number;
  serviceVersion: string;
  databaseUrl?: string;
  corsAllowedOrigins: string[];
}

export interface ServiceUrlMap {
  identity: string;
  tenant: string;
  agent: string;
  promptFlow: string;
  knowledge: string;
  audit: string;
  integration: string;
  pulsoIris: string;
  whatsappChannel: string;
  lumen: string;
  novaCore: string;
  voiceChannel: string;
  liwaChannel: string;
  documents: string;
}

const defaultPorts: Record<ServiceName, number> = {
  "api-gateway": 8080,
  "identity-service": 8081,
  "tenant-service": 8082,
  "agent-service": 8083,
  "prompt-flow-service": 8084,
  "knowledge-service": 8085,
  "audit-service": 8086,
  "integration-service": 8087,
  "pulso-iris-service": 8088,
  "whatsapp-channel-service": 8089,
  "lumen-service": 8090,
  "nova-core-service": 8091,
  "voice-channel-service": 8092,
  "liwa-channel-service": 8093,
  "documents-service": 8094
};

export function readServiceConfig(serviceName: ServiceName): ServiceConfig {
  return {
    serviceName,
    environment: readDeploymentEnvironment(process.env),
    host: process.env.HOST ?? "0.0.0.0",
    port: readNumber(process.env.PORT, defaultPorts[serviceName]),
    serviceVersion: process.env.SERVICE_VERSION ?? "0.1.0",
    databaseUrl: readOptional(process.env.DATABASE_URL),
    corsAllowedOrigins: readCsv(process.env.CORS_ALLOWED_ORIGINS)
  };
}

export function readServiceUrls(): ServiceUrlMap {
  return {
    identity: process.env.IDENTITY_SERVICE_URL ?? "http://localhost:8081",
    tenant: process.env.TENANT_SERVICE_URL ?? "http://localhost:8082",
    agent: process.env.AGENT_SERVICE_URL ?? "http://localhost:8083",
    promptFlow: process.env.PROMPT_FLOW_SERVICE_URL ?? "http://localhost:8084",
    knowledge: process.env.KNOWLEDGE_SERVICE_URL ?? "http://localhost:8085",
    audit: process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086",
    integration: process.env.INTEGRATION_SERVICE_URL ?? "http://localhost:8087",
    pulsoIris: process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088",
    whatsappChannel: process.env.WHATSAPP_CHANNEL_SERVICE_URL ?? "http://localhost:8089",
    lumen: process.env.LUMEN_SERVICE_URL ?? "http://localhost:8090",
    novaCore: process.env.NOVA_CORE_SERVICE_URL ?? "http://localhost:8091",
    voiceChannel: process.env.VOICE_CHANNEL_SERVICE_URL ?? "http://localhost:8092",
    liwaChannel: process.env.LIWA_CHANNEL_SERVICE_URL ?? "http://localhost:8093",
    documents: process.env.DOCUMENTS_SERVICE_URL ?? "http://localhost:8094"
  };
}

export function requireEnv(name: string): string {
  const value = readOptional(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric environment value: ${value}`);
  }

  return parsed;
}

function readCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOptional(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return value.trim();
}
