import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CHANNEL_VALUES = new Set(["legacy_pre_outbox_v1", "current_v2"]);
const LUMEN_VALUES = new Set(["legacy_ephemeral_v1", "deterministic_v2"]);
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

  return {
    channel_contract: capabilities.channelInbound === "current_v2" ? "current" : "legacy",
    lumen_contract: capabilities.lumenAudioCleanup === "deterministic_v2" ? "current" : "legacy",
    channel_v1_compatibility: capabilities.channelInbound === "current_v2" ? "disabled" : "enabled"
  };
}

export function validatePolicy(value) {
  requireObject(value, "compatibility policy");
  requireExactKeys(value, ["schemaVersion", "self", "legacyBaseOverrides"], "compatibility policy");
  if (value.schemaVersion !== 1) throw new Error("Unsupported compatibility policy schemaVersion");
  const self = validateCapabilities(value.self, "self");
  requireObject(value.legacyBaseOverrides, "legacyBaseOverrides");

  const legacyBaseOverrides = {};
  for (const [sha, capabilities] of Object.entries(value.legacyBaseOverrides)) {
    if (!SHA_PATTERN.test(sha)) throw new Error("Legacy compatibility override key must be an exact commit SHA");
    legacyBaseOverrides[sha] = validateCapabilities(capabilities, `legacyBaseOverrides.${sha}`);
  }
  return { schemaVersion: 1, self, legacyBaseOverrides };
}

function validateCapabilities(value, label) {
  requireObject(value, label);
  requireExactKeys(value, ["channelInbound", "lumenAudioCleanup"], label);
  if (!CHANNEL_VALUES.has(value.channelInbound)) throw new Error(`${label}.channelInbound is unsupported`);
  if (!LUMEN_VALUES.has(value.lumenAudioCleanup)) throw new Error(`${label}.lumenAudioCleanup is unsupported`);
  return {
    channelInbound: value.channelInbound,
    lumenAudioCleanup: value.lumenAudioCleanup
  };
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
