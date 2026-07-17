/**
 * Import VoipCentral SIP DDI(s) into ElevenLabs ConvAI and assign to NOVA Flujo A.
 *
 * Usage:
 *   node scripts/autonomy/elevenlabs-import-sip-ddi.mjs
 *   node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --write-env
 *   node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --all --write-env
 *
 * Env:
 *   ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID (Flujo A)
 *   SIP_TRUNK_ADDRESS, SIP_TRUNK_USERNAME, SIP_TRUNK_PASSWORD
 *   SIP_TRUNK_TRANSPORT (default tcp)
 *   SIP_SMOKE_DDI_E164 (default +573110456598)
 *   SIP_DDI_E164_LIST (comma-separated; used with --all)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_PATH = resolve(ROOT, ".env");
const BASE = "https://api.elevenlabs.io";
const writeEnv = process.argv.includes("--write-env");
const importAll = process.argv.includes("--all");

function loadDotEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2] ?? "";
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
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
      return `${k}=${pairs[k]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(pairs)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  writeFileSync(ENV_PATH, `${out.join("\n").replace(/\n*$/, "\n")}`, "utf8");
}

async function el(path, { method = "GET", body } = {}) {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new Error("ELEVENLABS_API_KEY is required");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "xi-api-key": key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`ElevenLabs ${method} ${path} => ${res.status}`);
    err.detail = json;
    throw err;
  }
  return json;
}

function normalizeE164(raw) {
  let n = String(raw || "").trim().replace(/[\s()-]/g, "");
  if (!n) return "";
  if (!n.startsWith("+")) {
    if (n.startsWith("57") && n.length >= 12) n = `+${n}`;
    else if (/^3\d{9}$/.test(n)) n = `+57${n}`;
    else return "";
  }
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : "";
}

function listPhones(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.phone_numbers)) return payload.phone_numbers;
  return [];
}

function phoneIdOf(row) {
  return String(row?.phone_number_id ?? row?.id ?? "").trim();
}

function phoneE164Of(row) {
  return normalizeE164(row?.phone_number ?? row?.number ?? "");
}

async function ensureSipPhone({ e164, label, agentId, trunk }) {
  const existing = listPhones(await el("/v1/convai/phone-numbers"));
  const found = existing.find((row) => phoneE164Of(row) === e164);
  let phoneNumberId = found ? phoneIdOf(found) : "";
  let created = false;

  if (!phoneNumberId) {
    const createdRow = await el("/v1/convai/phone-numbers", {
      method: "POST",
      body: {
        provider: "sip_trunk",
        phone_number: e164,
        label,
        supports_inbound: true,
        supports_outbound: true,
        agent_id: agentId || null,
        inbound_trunk_config: null,
        outbound_trunk_config: {
          address: trunk.address,
          transport: trunk.transport,
          credentials: {
            username: trunk.username,
            password: trunk.password,
          },
        },
      },
    });
    phoneNumberId = phoneIdOf(createdRow);
    created = true;
    if (!phoneNumberId) {
      throw new Error(`Import ${e164} succeeded but phone_number_id missing: ${JSON.stringify(createdRow)}`);
    }
  }

  if (agentId) {
    await el(`/v1/convai/phone-numbers/${phoneNumberId}`, {
      method: "PATCH",
      body: { agent_id: agentId },
    });
  }

  return { phoneNumberId, created, e164 };
}

async function main() {
  loadDotEnv();

  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim() || process.env.DEMO_AGENT_ID?.trim();
  if (!agentId) throw new Error("ELEVENLABS_AGENT_ID (Flujo A) is required");

  const trunk = {
    address: process.env.SIP_TRUNK_ADDRESS?.trim() || "sip.voipcentral.net",
    username: process.env.SIP_TRUNK_USERNAME?.trim() || "",
    password: process.env.SIP_TRUNK_PASSWORD?.trim() || "",
    transport: process.env.SIP_TRUNK_TRANSPORT?.trim() || "tcp",
  };
  if (!trunk.username || !trunk.password) {
    throw new Error("SIP_TRUNK_USERNAME and SIP_TRUNK_PASSWORD are required");
  }

  const smoke = normalizeE164(process.env.SIP_SMOKE_DDI_E164 || "+573110456598");
  if (!smoke) throw new Error("SIP_SMOKE_DDI_E164 must be E.164");

  const allList = String(process.env.SIP_DDI_E164_LIST || "")
    .split(",")
    .map((s) => normalizeE164(s))
    .filter(Boolean);

  const targets = importAll ? (allList.length ? allList : [smoke]) : [smoke];
  const results = [];

  for (const e164 of targets) {
    const label = `Coopfuturo SIP ${e164}`;
    const result = await ensureSipPhone({ e164, label, agentId, trunk });
    results.push(result);
    console.log(
      JSON.stringify({
        e164: result.e164,
        phone_number_id: result.phoneNumberId,
        created: result.created,
        agent_id: agentId,
      })
    );
  }

  const primary = results.find((r) => r.e164 === smoke) ?? results[0];
  if (!primary) throw new Error("No DDI imported");

  console.log(`DEMO_DDI_PHONE_NUMBER_ID=${primary.phoneNumberId}`);
  console.log(`IMPORTED_COUNT=${results.length}`);

  if (writeEnv) {
    upsertEnv({ DEMO_DDI_PHONE_NUMBER_ID: primary.phoneNumberId });
    console.log("WROTE_ENV=1");
  }
}

main().catch((err) => {
  console.error(err.message);
  if (err.detail) console.error(JSON.stringify(err.detail, null, 2));
  process.exit(1);
});
