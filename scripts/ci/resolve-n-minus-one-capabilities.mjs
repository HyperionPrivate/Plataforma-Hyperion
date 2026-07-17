import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CHANNEL_CONTRACTS = new Map([
  ["legacy_pre_outbox_v1", "legacy"],
  ["current_v2", "current"]
]);
const CHANNEL_PULSO_CONTRACTS = new Map([
  ["legacy_direct_sql_v1", "legacy_sql"],
  ["owner_api_v2", "owner_api"]
]);
const LUMEN_CONTRACTS = new Map([
  ["legacy_ephemeral_v1", "legacy"],
  ["deterministic_v2", "current"]
]);
const SOFIA_PULSO_CONTRACTS = new Map([
  ["legacy_direct_sql_v1", "legacy_sql"],
  ["owner_api_v2", "owner_api"]
]);
const SHA_PATTERN = /^[a-f0-9]{40}$/;

export function resolveNMinusOneCapabilities({ expectedSha, actualSha, currentPolicy, basePolicy }) {
  if (!SHA_PATTERN.test(expectedSha) || !SHA_PATTERN.test(actualSha) || actualSha !== expectedSha) {
    throw new Error("N-1 checkout does not match the exact pull-request base revision");
  }

  const validatedCurrent = validatePolicy(currentPolicy);
  const capabilities =
    basePolicy !== undefined ? validatePolicy(basePolicy).self : validatedCurrent.legacyBaseOverrides[expectedSha];
  if (!capabilities) {
    throw new Error("N-1 base has no compatibility descriptor or exact legacy override");
  }

  const channelContract = resolveCapability(CHANNEL_CONTRACTS, capabilities.channelInbound, "channelInbound");
  return {
    channel_contract: channelContract,
    channel_pulso_contract: resolveCapability(
      CHANNEL_PULSO_CONTRACTS,
      capabilities.channelPulsoOwnership,
      "channelPulsoOwnership"
    ),
    lumen_contract: resolveCapability(LUMEN_CONTRACTS, capabilities.lumenAudioCleanup, "lumenAudioCleanup"),
    channel_v1_compatibility: channelContract === "current" ? "disabled" : "enabled",
    sofia_pulso_contract: resolveCapability(
      SOFIA_PULSO_CONTRACTS,
      capabilities.sofiaPulsoOwnership,
      "sofiaPulsoOwnership"
    )
  };
}

export function validatePolicy(value) {
  requireObject(value, "compatibility policy");
  requireExactKeys(value, ["schemaVersion", "self", "legacyBaseOverrides"], "compatibility policy");
  if (value.schemaVersion !== 3) throw new Error("Unsupported compatibility policy schemaVersion");
  const self = validateCapabilities(value.self, "self");
  requireObject(value.legacyBaseOverrides, "legacyBaseOverrides");

  const legacyBaseOverrides = {};
  for (const [sha, capabilities] of Object.entries(value.legacyBaseOverrides)) {
    if (!SHA_PATTERN.test(sha)) throw new Error("Legacy compatibility override key must be an exact commit SHA");
    legacyBaseOverrides[sha] = validateCapabilities(capabilities, `legacyBaseOverrides.${sha}`);
  }
  return { schemaVersion: 3, self, legacyBaseOverrides };
}

function validateCapabilities(value, label) {
  requireObject(value, label);
  requireExactKeys(
    value,
    ["channelInbound", "channelPulsoOwnership", "lumenAudioCleanup", "sofiaPulsoOwnership"],
    label
  );
  if (!CHANNEL_CONTRACTS.has(value.channelInbound)) throw new Error(`${label}.channelInbound is unsupported`);
  if (!CHANNEL_PULSO_CONTRACTS.has(value.channelPulsoOwnership)) {
    throw new Error(`${label}.channelPulsoOwnership is unsupported`);
  }
  if (!LUMEN_CONTRACTS.has(value.lumenAudioCleanup)) {
    throw new Error(`${label}.lumenAudioCleanup is unsupported`);
  }
  if (!SOFIA_PULSO_CONTRACTS.has(value.sofiaPulsoOwnership)) {
    throw new Error(`${label}.sofiaPulsoOwnership is unsupported`);
  }
  return {
    channelInbound: value.channelInbound,
    channelPulsoOwnership: value.channelPulsoOwnership,
    lumenAudioCleanup: value.lumenAudioCleanup,
    sofiaPulsoOwnership: value.sofiaPulsoOwnership
  };
}

function resolveCapability(mapping, value, label) {
  const resolved = mapping.get(value);
  if (resolved === undefined) throw new Error(`${label} has no fail-closed contract mapping`);
  return resolved;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Invalid capability resolver arguments");
    values[key.slice(2)] = value;
  }
  requireExactKeys(values, ["base-dir", "expected-sha", "policy"], "resolver arguments");
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const baseDir = path.resolve(args["base-dir"]);
  const expectedSha = args["expected-sha"].trim().toLowerCase();
  const actualSha = execFileSync("git", ["-C", baseDir, "rev-parse", "HEAD"], { encoding: "utf8" })
    .trim()
    .toLowerCase();
  const currentPolicy = JSON.parse(readFileSync(path.resolve(args.policy), "utf8"));
  const basePolicyPath = path.join(baseDir, "infra", "compatibility-policy.json");
  const basePolicy = existsSync(basePolicyPath) ? JSON.parse(readFileSync(basePolicyPath, "utf8")) : undefined;
  const resolved = resolveNMinusOneCapabilities({ expectedSha, actualSha, currentPolicy, basePolicy });
  for (const [key, value] of Object.entries(resolved)) process.stdout.write(`${key}=${value}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
