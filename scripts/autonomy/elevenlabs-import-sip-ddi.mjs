/**
 * Import VoipCentral SIP DDI(s) into ElevenLabs ConvAI and assign to NOVA agents.
 *
 * Usage:
 *   node scripts/autonomy/elevenlabs-import-sip-ddi.mjs
 *   node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --write-env
 *   node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --all --write-env
 *   node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --split-ab --write-env
 *   node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --split-ab --existing-only
 *
 * Env:
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_AGENT_ID / DEMO_AGENT_ID (Flujo A)
 *   ELEVENLABS_AGENT_ID_B (Flujo B; required with --split-ab)
 *   SIP_TRUNK_ADDRESS, SIP_TRUNK_USERNAME, SIP_TRUNK_PASSWORD
 *   SIP_TRUNK_TRANSPORT (default tcp)
 *   SIP_TRUNK_CODECS (default PCMA/8000,PCMU/8000)
 *   SIP_TRUNK_MEDIA_ENCRYPTION (default disabled)
 *   ELEVENLABS_IMPORT_ENV_FILE (default .env; may point to a deployment env file)
 *   SIP_SMOKE_DDI_E164 (default +573110456598)
 *   SIP_DDI_E164_LIST (comma-separated; used with --all / --split-ab)
 *   SIP_DDI_E164_LIST_A / SIP_DDI_E164_LIST_B (optional explicit split)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertOutboundTrunkReadback,
  buildOutboundTrunkConfig,
  normalizeSipMediaEncryption,
  parseSipTrunkCodecs
} from "./elevenlabs-sip-trunk-config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_PATH = resolve(ROOT, process.env.ELEVENLABS_IMPORT_ENV_FILE?.trim() || ".env");
const BASE = "https://api.elevenlabs.io";
const writeEnv = process.argv.includes("--write-env");
const importAll = process.argv.includes("--all");
const splitAb = process.argv.includes("--split-ab");
const existingOnly = process.argv.includes("--existing-only");

function loadDotEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2] ?? "";
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
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
      Accept: "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
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
  let n = String(raw || "")
    .trim()
    .replace(/[\s()-]/g, "");
  if (!n) return "";
  if (!n.startsWith("+")) {
    if (n.startsWith("57") && n.length >= 12) n = `+${n}`;
    else if (/^3\d{9}$/.test(n)) n = `+57${n}`;
    else return "";
  }
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : "";
}

function parseList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => normalizeE164(s))
    .filter(Boolean);
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

function findPhone(existing, e164) {
  const targetDigits = e164.replace(/\D/g, "");
  return existing.find((row) => {
    const normalized = phoneE164Of(row);
    if (normalized && normalized === e164) return true;
    const raw = String(row?.phone_number ?? row?.number ?? "").replace(/\D/g, "");
    return raw.length > 0 && (raw === targetDigits || raw.endsWith(targetDigits.slice(-10)));
  });
}

async function ensureSipPhone({ e164, label, agentId, trunk, existingOnly: skipCreate }) {
  const outboundTrunkConfig = buildOutboundTrunkConfig(trunk);
  let existing = listPhones(await el("/v1/convai/phone-numbers"));
  let found = findPhone(existing, e164);
  let phoneNumberId = found ? phoneIdOf(found) : "";
  let created = false;

  if (!phoneNumberId && skipCreate) {
    return { phoneNumberId: "", created: false, skipped: true, e164, agentId: agentId || "", trunkVerified: false };
  }

  if (!phoneNumberId) {
    try {
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
          outbound_trunk_config: outboundTrunkConfig
        }
      });
      phoneNumberId = phoneIdOf(createdRow);
      created = true;
    } catch (err) {
      // Concurrent/previous import: number exists but list lookup missed it.
      const detail = err?.detail;
      const conflict =
        err?.message?.includes("409") ||
        detail?.detail?.status === "phone_number_conflict" ||
        detail?.status === "phone_number_conflict";
      if (!conflict) throw err;
      existing = listPhones(await el("/v1/convai/phone-numbers"));
      found = findPhone(existing, e164);
      phoneNumberId = found ? phoneIdOf(found) : "";
      if (!phoneNumberId) {
        throw new Error(`Phone ${e164} reported as existing but not visible in GET /v1/convai/phone-numbers`, {
          cause: err
        });
      }
    }
    if (!phoneNumberId) {
      throw new Error(`Import ${e164} succeeded but phone_number_id missing`);
    }
  }

  await el(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "PATCH",
    body: {
      ...(agentId ? { agent_id: agentId } : {}),
      outbound_trunk_config: outboundTrunkConfig
    }
  });
  const readback = await el(`/v1/convai/phone-numbers/${phoneNumberId}`);
  assertOutboundTrunkReadback(readback, outboundTrunkConfig);

  return { phoneNumberId, created, e164, agentId: agentId || "", trunkVerified: true };
}

function defaultCoopList() {
  return [
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
  ];
}

async function main() {
  loadDotEnv();

  const agentA = process.env.ELEVENLABS_AGENT_ID?.trim() || process.env.DEMO_AGENT_ID?.trim() || "";
  const agentB = process.env.ELEVENLABS_AGENT_ID_B?.trim() || "";
  if (!agentA) throw new Error("ELEVENLABS_AGENT_ID (Flujo A) is required");
  if (splitAb && !agentB) throw new Error("ELEVENLABS_AGENT_ID_B (Flujo B) is required with --split-ab");

  const trunk = {
    address: process.env.SIP_TRUNK_ADDRESS?.trim() || "sip.voipcentral.net",
    username: process.env.SIP_TRUNK_USERNAME?.trim() || "",
    password: process.env.SIP_TRUNK_PASSWORD?.trim() || "",
    transport: process.env.SIP_TRUNK_TRANSPORT?.trim() || "tcp",
    enabledCodecs: parseSipTrunkCodecs(process.env.SIP_TRUNK_CODECS),
    mediaEncryption: normalizeSipMediaEncryption(process.env.SIP_TRUNK_MEDIA_ENCRYPTION)
  };
  if (!trunk.username || !trunk.password) {
    throw new Error("SIP_TRUNK_USERNAME and SIP_TRUNK_PASSWORD are required");
  }

  const smoke = normalizeE164(process.env.SIP_SMOKE_DDI_E164 || "+573110456598");
  if (!smoke) throw new Error("SIP_SMOKE_DDI_E164 must be E.164");

  const allFromEnv = parseList(process.env.SIP_DDI_E164_LIST);
  const listAEnv = parseList(process.env.SIP_DDI_E164_LIST_A);
  const listBEnv = parseList(process.env.SIP_DDI_E164_LIST_B);
  const coopDefault = defaultCoopList();
  const allList = allFromEnv.length ? allFromEnv : coopDefault;

  /** @type {Array<{ e164: string, agentId: string, flow: "A" | "B" }>} */
  let plan;
  if (splitAb) {
    const listA = listAEnv.length ? listAEnv : allList.slice(0, 5);
    const listB = listBEnv.length ? listBEnv : allList.slice(5, 10);
    if (!listA.length || !listB.length) {
      throw new Error(`--split-ab requires at least one DDI per flow (got A=${listA.length} B=${listB.length})`);
    }
    plan = [
      ...listA.map((e164) => ({ e164, agentId: agentA, flow: "A" })),
      ...listB.map((e164) => ({ e164, agentId: agentB, flow: "B" }))
    ];
  } else {
    const targets = importAll ? allList : [smoke];
    plan = targets.map((e164) => ({ e164, agentId: agentA, flow: "A" }));
  }

  const results = [];
  for (const item of plan) {
    const label = `Coopfuturo SIP ${item.e164} · Flujo ${item.flow}`;
    const result = await ensureSipPhone({
      e164: item.e164,
      label,
      agentId: item.agentId,
      trunk,
      existingOnly
    });
    if (result.skipped) {
      console.log(JSON.stringify({ ddi_suffix: result.e164.slice(-4), flow: item.flow, skipped: "not_listed" }));
      continue;
    }
    results.push({ ...result, flow: item.flow });
    console.log(
      JSON.stringify({
        ddi_suffix: result.e164.slice(-4),
        phone_number_id: result.phoneNumberId,
        created: result.created,
        flow: item.flow,
        agent_id: item.agentId,
        trunk_verified: result.trunkVerified
      })
    );
  }

  const flowA = results.filter((r) => r.flow === "A");
  const flowB = results.filter((r) => r.flow === "B");
  const primaryA = flowA.find((r) => r.e164 === smoke) ?? flowA[0] ?? results[0];
  const primaryB = flowB[0] ?? null;
  if (!primaryA) throw new Error("No DDI imported for Flujo A");

  console.log(`DEMO_DDI_PHONE_NUMBER_ID=${primaryA.phoneNumberId}`);
  if (primaryB) console.log(`DEMO_DDI_PHONE_NUMBER_ID_B=${primaryB.phoneNumberId}`);
  console.log(`IMPORTED_COUNT=${results.length}`);
  console.log(`FLOW_A_COUNT=${flowA.length}`);
  console.log(`FLOW_B_COUNT=${flowB.length}`);

  if (writeEnv) {
    const pairs = {
      SIP_DDI_E164_LIST: (splitAb ? [...flowA, ...flowB] : results).map((r) => r.e164).join(","),
      DEMO_DDI_PHONE_NUMBER_ID: primaryA.phoneNumberId,
      FALLBACK_DDI_PHONE_NUMBER_ID: primaryA.phoneNumberId,
      DEMO_AGENT_ID: agentA
    };
    if (splitAb) {
      pairs.SIP_DDI_E164_LIST_A = flowA.map((r) => r.e164).join(",");
      pairs.SIP_DDI_E164_LIST_B = flowB.map((r) => r.e164).join(",");
      pairs.DEMO_DDI_PHONE_NUMBER_IDS_A = flowA.map((r) => r.phoneNumberId).join(",");
      pairs.DEMO_DDI_PHONE_NUMBER_IDS_B = flowB.map((r) => r.phoneNumberId).join(",");
      if (primaryB) {
        pairs.DEMO_DDI_PHONE_NUMBER_ID_B = primaryB.phoneNumberId;
        pairs.FALLBACK_DDI_PHONE_NUMBER_ID_B = primaryB.phoneNumberId;
      }
      if (agentB) pairs.DEMO_AGENT_ID_B = agentB;
    }
    upsertEnv(pairs);
    console.log("WROTE_ENV=1");
  }
}

main().catch((err) => {
  console.error(err.message);
  if (err.detail) console.error(JSON.stringify(err.detail, null, 2));
  process.exit(1);
});
