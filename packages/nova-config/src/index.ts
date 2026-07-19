export const NOVA_SERVICE_NAMES = [
  "nova-core-service",
  "voice-channel-service",
  "liwa-channel-service",
  "documents-service"
] as const;

export type NovaServiceName = (typeof NOVA_SERVICE_NAMES)[number];

export const HYPERION_DEPLOYMENT_ENVIRONMENTS = ["local", "ci", "staging", "production"] as const;
export type HyperionDeploymentEnvironment = (typeof HYPERION_DEPLOYMENT_ENVIRONMENTS)[number];

export interface NovaServiceConfig {
  serviceName: NovaServiceName;
  environment: HyperionDeploymentEnvironment;
  host: string;
  port: number;
  serviceVersion: string;
  databaseUrl?: string;
  corsAllowedOrigins: string[];
}

export interface NovaServiceUrlMap {
  audit: string;
  novaCore: string;
  voiceChannel: string;
  liwaChannel: string;
  documents: string;
}

const DEFAULT_PORTS: Record<NovaServiceName, number> = {
  "nova-core-service": 8091,
  "voice-channel-service": 8092,
  "liwa-channel-service": 8093,
  "documents-service": 8094
};

export const NOVA_SECRET_KEYS = [
  "DATABASE_URL",
  "NOVA_DATABASE_PASSWORD",
  "VOICE_DATABASE_PASSWORD",
  "LIWA_DATABASE_PASSWORD",
  "DOCUMENTS_DATABASE_PASSWORD",
  "NOVA_MIGRATOR_DATABASE_PASSWORD",
  "NOVA_MIGRATOR_DATABASE_URL",
  "NOVA_POSTGRES_ADMIN_URL",
  "GATEWAY_TO_NOVA_TOKEN",
  "GATEWAY_TO_VOICE_TOKEN",
  "GATEWAY_TO_LIWA_TOKEN",
  "GATEWAY_TO_DOCUMENTS_TOKEN",
  "NOVA_BFF_TO_NOVA_TOKEN",
  "NOVA_BFF_TO_VOICE_TOKEN",
  "NOVA_BFF_TO_LIWA_TOKEN",
  "NOVA_BFF_TO_DOCUMENTS_TOKEN",
  "NOVA_OPERATOR_ASSERTION_KEY",
  "NOVA_TO_AUDIT_TOKEN",
  "NOVA_TO_VOICE_TOKEN",
  "NOVA_TO_LIWA_TOKEN",
  "NOVA_TO_DOCUMENTS_TOKEN",
  "VOICE_TO_NOVA_TOKEN",
  "VOICE_TO_AUDIT_TOKEN",
  "VOICE_TO_DIALER_TOKEN",
  "LIWA_TO_NOVA_TOKEN",
  "LIWA_TO_AUDIT_TOKEN",
  "DOCUMENTS_TO_NOVA_TOKEN",
  "DOCUMENTS_TO_AUDIT_TOKEN",
  "LIWA_API_TOKEN",
  "LIWA_ACCESS_TOKEN",
  "LIWA_WEBHOOK_SECRET",
  "DIALER_ADMIN_PASSWORD",
  "DIALER_DEMO_API_KEY",
  "VOICE_DIALER_PASSWORD",
  "DIALER_WEBHOOK_HMAC_SECRET",
  "WEBHOOK_HMAC_SECRET",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_WEBHOOK_SECRET",
  "ELEVENLABS_WEBHOOK_HMAC_SECRET",
  "DOCUMENTS_S3_ACCESS_KEY",
  "DOCUMENTS_S3_SECRET_KEY"
] as const;

export function readDeploymentEnvironment(environment: NodeJS.ProcessEnv = process.env): HyperionDeploymentEnvironment {
  const explicit = environment.HYPERION_ENVIRONMENT?.trim().toLowerCase();
  if (explicit) {
    if (!HYPERION_DEPLOYMENT_ENVIRONMENTS.includes(explicit as HyperionDeploymentEnvironment)) {
      throw new Error(`HYPERION_ENVIRONMENT must be one of: ${HYPERION_DEPLOYMENT_ENVIRONMENTS.join(", ")}`);
    }
    return explicit as HyperionDeploymentEnvironment;
  }

  const nodeEnvironment = (environment.NODE_ENV ?? "development").trim().toLowerCase();
  if (nodeEnvironment === "test" || nodeEnvironment === "ci") return "ci";
  if (nodeEnvironment === "staging" || nodeEnvironment === "production") return nodeEnvironment;
  if (nodeEnvironment === "development" || nodeEnvironment === "local") return "local";
  throw new Error("NODE_ENV must be development, local, test, ci, staging or production");
}

export function isRestrictedDeploymentEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  const deployment = readDeploymentEnvironment(environment);
  return deployment === "staging" || deployment === "production";
}

export function isCiDeploymentEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return readDeploymentEnvironment(environment) === "ci";
}

export function readNovaServiceConfig(
  serviceName: NovaServiceName,
  environment: NodeJS.ProcessEnv = process.env
): NovaServiceConfig {
  return {
    serviceName,
    environment: readDeploymentEnvironment(environment),
    host: environment.HOST?.trim() || "0.0.0.0",
    port: readPositiveInteger(environment.PORT, DEFAULT_PORTS[serviceName]),
    serviceVersion: environment.SERVICE_VERSION?.trim() || "0.1.0",
    databaseUrl: readOptional(environment.DATABASE_URL),
    corsAllowedOrigins: readCsv(environment.CORS_ALLOWED_ORIGINS)
  };
}

export function readServiceUrls(environment: NodeJS.ProcessEnv = process.env): NovaServiceUrlMap {
  return {
    audit: environment.AUDIT_SERVICE_URL ?? "http://localhost:8086",
    novaCore: environment.NOVA_CORE_SERVICE_URL ?? "http://localhost:8091",
    voiceChannel: environment.VOICE_CHANNEL_SERVICE_URL ?? "http://localhost:8092",
    liwaChannel: environment.LIWA_CHANNEL_SERVICE_URL ?? "http://localhost:8093",
    documents: environment.DOCUMENTS_SERVICE_URL ?? "http://localhost:8094"
  };
}

export function assertNoNovaPlaceholderSecrets(environment: NodeJS.ProcessEnv = process.env): void {
  if (!isRestrictedDeploymentEnvironment(environment)) return;
  const invalid = NOVA_SECRET_KEYS.filter((key) => {
    const value = environment[key]?.trim();
    return value !== undefined && /(?:^|[:/@])replace-/i.test(value);
  });
  if (invalid.length > 0) {
    throw new Error(`NOVA production secrets must not use placeholders: ${invalid.join(", ")}`);
  }
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${raw}`);
  return parsed;
}

function readOptional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value || undefined;
}

function readCsv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}
