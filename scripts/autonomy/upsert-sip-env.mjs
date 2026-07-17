/**
 * One-shot helper: write VoipCentral SIP vars into local .env (gitignored).
 * Prefer setting SIP_TRUNK_PASSWORD via env when rotating:
 *   SIP_TRUNK_PASSWORD='...' node scripts/autonomy/upsert-sip-env.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_PATH = resolve(ROOT, ".env");

function quoteIfNeeded(v) {
  if (/[)(#\s"']/.test(v)) return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return v;
}

function upsertEnv(pairs) {
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!m) return line;
    const k = m[1];
    if (Object.prototype.hasOwnProperty.call(pairs, k)) {
      seen.add(k);
      return `${k}=${quoteIfNeeded(pairs[k])}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(pairs)) {
    if (!seen.has(k)) out.push(`${k}=${quoteIfNeeded(v)}`);
  }
  writeFileSync(ENV_PATH, `${out.join("\n").replace(/\n*$/, "\n")}`, "utf8");
}

const password = process.env.SIP_TRUNK_PASSWORD?.trim();
if (!password) {
  console.error("SIP_TRUNK_PASSWORD is required in the environment for this helper");
  process.exit(64);
}

const pairs = {
  SIP_TRUNK_ADDRESS: process.env.SIP_TRUNK_ADDRESS?.trim() || "sip.voipcentral.net",
  SIP_TRUNK_USERNAME: process.env.SIP_TRUNK_USERNAME?.trim() || "0208213500000",
  SIP_TRUNK_PASSWORD: password,
  SIP_TRUNK_TRANSPORT: process.env.SIP_TRUNK_TRANSPORT?.trim() || "tcp",
  SIP_SMOKE_DDI_E164: process.env.SIP_SMOKE_DDI_E164?.trim() || "+573110456598",
  SIP_DDI_E164_LIST:
    process.env.SIP_DDI_E164_LIST?.trim() ||
    [
      "+573110456598",
      "+573110456599",
      "+573110456600",
      "+573110456601",
      "+573110456602",
      "+573110456603",
      "+573110456604",
      "+573110456605",
      "+573110456606",
      "+573110456607"
    ].join(",")
};

upsertEnv(pairs);
console.log("WROTE_SIP_KEYS=" + Object.keys(pairs).join(","));
