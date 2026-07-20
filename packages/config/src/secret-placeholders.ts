/**
 * Fail-closed placeholder detection for production/staging runtimes.
 * `.env.example` may keep `replace-*` values for CI/dev; real deployments must not.
 */

import { isRestrictedDeploymentEnvironment } from "./deployment-environment.js";

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
  "replace-nova-db-secret-0000009",
  "replace-voice-db-secret-000010",
  "replace-liwa-db-secret-0000011",
  "replace-documents-db-secret-12",
  "replace-gateway-identity-edge-001",
  "replace-nova-bff-access-edge-0041",
  "replace-lumen-bff-access-edge-0042",
  "replace-pulso-bff-access-edge-0043",
  "replace-platform-admin-access-0044",
  "replace-platform-admin-identity-0045",
  "replace-platform-admin-tenant-0046",
  "replace-platform-admin-audit-0047",
  "replace-platform-admin-assert-0048",
  "replace-gateway-integration-edge-002",
  "replace-gateway-pulso-edge-001",
  "replace-gateway-lumen-edge-002",
  "replace-gateway-nova-edge-000021",
  "replace-gateway-voice-edge-00022",
  "replace-gateway-liwa-edge-000023",
  "replace-gateway-documents-edge-24",
  "replace-gateway-tenant-edge-016",
  "replace-gateway-audit-edge-017",
  "replace-gateway-knowledge-edge-018",
  "replace-gateway-sofia-edge-019",
  "replace-gateway-operator-assert-020",
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
  "replace-access-nova-edge-000025",
  "replace-nova-audit-edge-000026",
  "replace-nova-voice-edge-000027",
  "replace-nova-liwa-edge-0000028",
  "replace-nova-documents-edge-29",
  "replace-voice-audit-edge-000030",
  "replace-voice-dialer-edge-00031",
  "replace-voice-nova-edge-0000032",
  "replace-liwa-audit-edge-000033",
  "replace-liwa-nova-edge-0000034",
  "replace-documents-audit-edge-35",
  "replace-documents-nova-edge-36",
  "replace-liwa-webhook-secret-0037",
  "replace-dialer-webhook-hmac-38",
  "replace-dialer-admin-password-39",
  "replace-dialer-jwt-secret-at-least-32-chars",
  "replace-dialer-demo-api-key-000040",
  "replace-dialer-ml-hmac-key-32chars-min",
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
  "NOVA_DATABASE_PASSWORD",
  "VOICE_DATABASE_PASSWORD",
  "LIWA_DATABASE_PASSWORD",
  "DOCUMENTS_DATABASE_PASSWORD",
  "GATEWAY_TO_IDENTITY_TOKEN",
  "NOVA_BFF_TO_ACCESS_TOKEN",
  "LUMEN_BFF_TO_ACCESS_TOKEN",
  "PULSO_BFF_TO_ACCESS_TOKEN",
  "PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN",
  "PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN",
  "PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN",
  "PLATFORM_ADMIN_BFF_TO_AUDIT_TOKEN",
  "PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY",
  "GATEWAY_TO_INTEGRATION_TOKEN",
  "GATEWAY_TO_PULSO_TOKEN",
  "GATEWAY_TO_LUMEN_TOKEN",
  "GATEWAY_TO_NOVA_TOKEN",
  "GATEWAY_TO_VOICE_TOKEN",
  "GATEWAY_TO_LIWA_TOKEN",
  "GATEWAY_TO_DOCUMENTS_TOKEN",
  "GATEWAY_TO_TENANT_TOKEN",
  "GATEWAY_TO_AUDIT_TOKEN",
  "GATEWAY_TO_KNOWLEDGE_TOKEN",
  "GATEWAY_TO_SOFIA_TOKEN",
  "GATEWAY_OPERATOR_ASSERTION_KEY",
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
  "ACCESS_TO_CHANNEL_TOKEN",
  "ACCESS_TO_PULSO_TOKEN",
  "ACCESS_TO_NOVA_TOKEN",
  "NOVA_TO_AUDIT_TOKEN",
  "NOVA_TO_VOICE_TOKEN",
  "NOVA_TO_LIWA_TOKEN",
  "NOVA_TO_DOCUMENTS_TOKEN",
  "VOICE_TO_AUDIT_TOKEN",
  "VOICE_TO_DIALER_TOKEN",
  "VOICE_TO_NOVA_TOKEN",
  "LIWA_TO_AUDIT_TOKEN",
  "LIWA_TO_NOVA_TOKEN",
  "DOCUMENTS_TO_AUDIT_TOKEN",
  "DOCUMENTS_TO_NOVA_TOKEN",
  "LIWA_WEBHOOK_SECRET",
  "DIALER_WEBHOOK_HMAC_SECRET",
  "NATS_TOPOLOGY_PASSWORD",
  "NATS_CHANNEL_PASSWORD",
  "NATS_PULSO_PASSWORD",
  "NATS_SOFIA_PASSWORD",
  "NATS_AUDIT_PASSWORD",
  "NATS_LUMEN_PASSWORD",
  "NATS_PASSWORD",
  "NATS_AUTH_TOKEN",
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
  return isRestrictedDeploymentEnvironment(environment);
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
 * Refuses known `.env.example` placeholders in restricted deployments.
 * Explicit local and CI rehearsals accept placeholders.
 */
export function assertNoPlaceholderSecrets(environment: NodeJS.ProcessEnv = process.env): void {
  if (!shouldEnforcePlaceholderRejection(environment)) return;

  const problems = findPlaceholderSecretProblems(environment);
  if (problems.length === 0) return;

  throw new Error(
    `Refusing to start with .env.example placeholder secrets in production/staging: ${problems.join(", ")}. ` +
      "Replace every replace-* value before deploying."
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
