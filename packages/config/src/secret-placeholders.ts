/**
 * Fail-closed placeholder detection for production/staging runtimes.
 * `.env.example` may keep `replace-*` values for CI/dev; real deployments must not.
 */

const PLACEHOLDER_PREFIX = /^replace-/i;

/** Exact secret values shipped in `.env.example` (must stay in sync when examples change). */
export const ENV_EXAMPLE_PLACEHOLDER_VALUES = new Set([
  "replace-with-real-secret",
  "replace-access-db-secret-0001",
  "replace-sofia-db-secret-00002",
  "replace-knowledge-db-secret-03",
  "replace-audit-db-secret-00004",
  "replace-integration-db-secret-5",
  "replace-pulso-db-secret-00006",
  "replace-channel-db-secret-0007",
  "replace-lumen-db-secret-000008",
  "replace-gateway-identity-edge-001",
  "replace-gateway-integration-edge-002",
  "replace-gateway-pulso-edge-001",
  "replace-gateway-lumen-edge-002",
  "replace-gateway-tenant-edge-016",
  "replace-gateway-audit-edge-017",
  "replace-gateway-knowledge-edge-018",
  "replace-gateway-sofia-edge-019",
  "replace-integration-channel-003",
  "replace-integration-sofia-edge-004",
  "replace-channel-pulso-edge-005",
  "replace-pulso-channel-lookup-016",
  "replace-channel-audit-edge-006",
  "replace-pulso-sofia-edge-007",
  "replace-pulso-audit-edge-008",
  "replace-pulso-lumen-edge-009",
  "replace-sofia-channel-edge-010",
  "replace-sofia-prompt-flow-011",
  "replace-sofia-pulso-edge-012",
  "replace-sofia-audit-edge-013",
  "replace-lumen-audit-edge-014",
  "replace-access-lumen-edge-015",
  "replace-topology-nats-secret-01",
  "replace-channel-nats-secret-002",
  "replace-pulso-nats-secret-0003",
  "replace-sofia-nats-secret-00004",
  "replace-audit-nats-secret-000005",
  "replace-lumen-nats-secret-000006",
  "replace-channel-phone-hash-key-00001",
  "replace-with-real-admin-password"
]);

/** Env keys whose values must not be example placeholders in restricted environments. */
export const REQUIRED_SECRET_ENV_KEYS = [
  "POSTGRES_PASSWORD",
  "ACCESS_DATABASE_PASSWORD",
  "SOFIA_DATABASE_PASSWORD",
  "KNOWLEDGE_DATABASE_PASSWORD",
  "AUDIT_DATABASE_PASSWORD",
  "INTEGRATION_DATABASE_PASSWORD",
  "PULSO_DATABASE_PASSWORD",
  "CHANNEL_DATABASE_PASSWORD",
  "LUMEN_DATABASE_PASSWORD",
  "GATEWAY_TO_IDENTITY_TOKEN",
  "GATEWAY_TO_INTEGRATION_TOKEN",
  "GATEWAY_TO_PULSO_TOKEN",
  "GATEWAY_TO_LUMEN_TOKEN",
  "GATEWAY_TO_TENANT_TOKEN",
  "GATEWAY_TO_AUDIT_TOKEN",
  "GATEWAY_TO_KNOWLEDGE_TOKEN",
  "GATEWAY_TO_SOFIA_TOKEN",
  "INTEGRATION_TO_CHANNEL_TOKEN",
  "INTEGRATION_TO_SOFIA_TOKEN",
  "CHANNEL_TO_PULSO_TOKEN",
  "PULSO_TO_CHANNEL_TOKEN",
  "CHANNEL_TO_AUDIT_TOKEN",
  "PULSO_TO_SOFIA_TOKEN",
  "PULSO_TO_AUDIT_TOKEN",
  "PULSO_TO_LUMEN_TOKEN",
  "SOFIA_TO_CHANNEL_TOKEN",
  "SOFIA_TO_PROMPT_FLOW_TOKEN",
  "SOFIA_TO_PULSO_TOKEN",
  "SOFIA_TO_AUDIT_TOKEN",
  "LUMEN_TO_AUDIT_TOKEN",
  "ACCESS_TO_LUMEN_TOKEN",
  "NATS_TOPOLOGY_PASSWORD",
  "NATS_CHANNEL_PASSWORD",
  "NATS_PULSO_PASSWORD",
  "NATS_SOFIA_PASSWORD",
  "NATS_AUDIT_PASSWORD",
  "NATS_LUMEN_PASSWORD",
  "WHATSAPP_PHONE_HASH_KEY",
  "INITIAL_ADMIN_PASSWORD"
] as const;

export function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (PLACEHOLDER_PREFIX.test(normalized)) return true;
  return ENV_EXAMPLE_PLACEHOLDER_VALUES.has(normalized);
}

export function shouldEnforcePlaceholderRejection(environment: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = (environment.NODE_ENV ?? "development").trim().toLowerCase();
  const hyperionEnv = (environment.HYPERION_ENVIRONMENT ?? "").trim().toLowerCase();
  const restricted =
    nodeEnv === "production" ||
    nodeEnv === "staging" ||
    hyperionEnv === "production" ||
    hyperionEnv === "staging";
  if (!restricted) return false;

  // Explicit Hyperion environment always enforces, even under CI.
  if (hyperionEnv === "production" || hyperionEnv === "staging") return true;

  // Compose hardcodes NODE_ENV=production for every workload. CI and local
  // rehearsals that intentionally load `.env.example` may keep placeholders.
  if (environment.CI === "true") return false;
  if (environment.HYPERION_ALLOW_EXAMPLE_SECRETS === "true") return false;
  return true;
}

export function findPlaceholderSecretProblems(environment: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  for (const key of REQUIRED_SECRET_ENV_KEYS) {
    const value = environment[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (isPlaceholderSecret(value)) problems.push(key);
  }

  const databaseUrl = environment.DATABASE_URL?.trim();
  if (databaseUrl) {
    const embedded = passwordFromDatabaseUrl(databaseUrl);
    if (embedded && isPlaceholderSecret(embedded)) {
      problems.push("DATABASE_URL");
    }
  }

  return [...new Set(problems)].sort();
}

/**
 * Refuses known `.env.example` placeholders when NODE_ENV / HYPERION_ENVIRONMENT
 * is production or staging (fail closed). Development accepts placeholders.
 */
export function assertNoPlaceholderSecrets(environment: NodeJS.ProcessEnv = process.env): void {
  if (!shouldEnforcePlaceholderRejection(environment)) return;

  const problems = findPlaceholderSecretProblems(environment);
  if (problems.length === 0) return;

  throw new Error(
    `Refusing to start with .env.example placeholder secrets in production/staging: ${problems.join(", ")}. ` +
      "Replace every replace-* value and unset HYPERION_ALLOW_EXAMPLE_SECRETS before deploying."
  );
}

function passwordFromDatabaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.password ? decodeURIComponent(parsed.password) : undefined;
  } catch {
    return undefined;
  }
}
