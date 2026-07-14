import { isIP } from "node:net";

export { assertJetStreamProductionGate } from "./jetstream-production-gate.js";
export {
  assertNoPlaceholderSecrets,
  ENV_EXAMPLE_PLACEHOLDER_VALUES,
  findPlaceholderSecretProblems,
  HYPERION_DEPLOYMENT_ENVIRONMENTS,
  isCiDeploymentEnvironment,
  isPlaceholderSecret,
  isRestrictedDeploymentEnvironment,
  readDeploymentEnvironment,
  REQUIRED_SECRET_ENV_KEYS,
  shouldEnforcePlaceholderRejection,
  type HyperionDeploymentEnvironment
} from "@hyperion/config";

/**
 * The current durable dispatchers can drain ten sequential five-second
 * deliveries. Keep enough headroom for their final database bookkeeping.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 65_000;
export const MIN_SHUTDOWN_TIMEOUT_MS = 55_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 15 * 60_000;

export function resolveShutdownTimeoutMs(
  explicitValue: number | undefined,
  environmentValue: string | undefined
): number {
  const value = explicitValue ?? parseOptionalInteger(environmentValue);
  const resolved = value ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

  if (!Number.isSafeInteger(resolved) || resolved < MIN_SHUTDOWN_TIMEOUT_MS || resolved > MAX_SHUTDOWN_TIMEOUT_MS) {
    throw new Error(
      `SHUTDOWN_TIMEOUT_MS must be an integer between ${MIN_SHUTDOWN_TIMEOUT_MS} and ${MAX_SHUTDOWN_TIMEOUT_MS}`
    );
  }

  return resolved;
}

/**
 * Fastify accepts permissive trust-proxy modes, including trusting every
 * upstream hop. The runtime intentionally accepts only explicit IP/CIDR
 * entries so a directly reachable service cannot be switched to trust-all.
 */
export function resolveTrustedProxies(value: string | undefined): false | string[] {
  const normalized = value?.trim();
  if (!normalized || normalized.toLowerCase() === "false") {
    return false;
  }

  if (normalized.toLowerCase() === "true") {
    throw new Error("TRUST_PROXY must list explicit proxy IP or CIDR entries; trust-all is not allowed");
  }

  const rules = normalized
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);

  if (rules.length === 0 || rules.some((rule) => !isSafeProxyRule(rule))) {
    throw new Error("TRUST_PROXY must be a comma-separated list of explicit proxy IP or CIDR entries");
  }

  return rules;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^[0-9]+$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

function isSafeProxyRule(rule: string): boolean {
  const separator = rule.indexOf("/");
  const address = separator === -1 ? rule : rule.slice(0, separator);
  const prefix = separator === -1 ? undefined : rule.slice(separator + 1);
  const version = isIP(address);

  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^[0-9]+$/.test(prefix)) return false;

  const prefixLength = Number(prefix);
  const maximum = version === 4 ? 32 : 128;
  // A /0 rule is semantically equivalent to trusting every source.
  return prefixLength >= 1 && prefixLength <= maximum;
}
