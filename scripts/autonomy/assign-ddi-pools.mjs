/**
 * Re-assign CoopFuturo SIP DDIs to Flujo A/B agents and print env pairs.
 * Intended: A 598-602 · B 603-607
 * Operational: A skips 599 (ElevenLabs conflict/not listable) until recovered.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(import.meta.dirname, "../../.env");
const writeEnv = process.argv.includes("--write-env");

function loadDotEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    let val = m[2] ?? "";
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
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

loadDotEnv();
const key = process.env.ELEVENLABS_API_KEY;
const agentA = process.env.ELEVENLABS_AGENT_ID;
const agentB = process.env.ELEVENLABS_AGENT_ID_B;

const poolA = ["+573110456598", "+573110456600", "+573110456601", "+573110456602"];
const poolB = ["+573110456603", "+573110456604", "+573110456605", "+573110456606", "+573110456607"];
const listADoc = "+573110456598,+573110456599,+573110456600,+573110456601,+573110456602";
const listBDoc = "+573110456603,+573110456604,+573110456605,+573110456606,+573110456607";

const res = await fetch("https://api.elevenlabs.io/v1/convai/phone-numbers", {
  headers: { "xi-api-key": key, Accept: "application/json" }
});
const json = await res.json();
const list = Array.isArray(json) ? json : json.phone_numbers || [];
const byE164 = new Map();
for (const row of list) {
  const phone = String(row.phone_number || row.number || "");
  const id = String(row.phone_number_id || row.id || "");
  if (phone && id) byE164.set(phone, id);
}

async function assign(e164, agentId, flow) {
  const id = byE164.get(e164);
  if (!id) {
    console.log(JSON.stringify({ e164, flow, ok: false, error: "not_listed" }));
    return null;
  }
  const patch = await fetch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${id}`, {
    method: "PATCH",
    headers: {
      "xi-api-key": key,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ agent_id: agentId })
  });
  console.log(JSON.stringify({ e164, flow, id, status: patch.status, agentId }));
  return patch.ok ? id : null;
}

const idsA = [];
const idsB = [];
for (const e164 of poolA) {
  const id = await assign(e164, agentA, "A");
  if (id) idsA.push(id);
}
for (const e164 of poolB) {
  const id = await assign(e164, agentB, "B");
  if (id) idsB.push(id);
}

const pairs = {
  SIP_DDI_E164_LIST:
    "+573110456598,+573110456599,+573110456600,+573110456601,+573110456602,+573110456603,+573110456604,+573110456605,+573110456606,+573110456607",
  SIP_DDI_E164_LIST_A: listADoc,
  SIP_DDI_E164_LIST_B: listBDoc,
  // Operational pools (only listable / working IDs)
  DEMO_DDI_PHONE_NUMBER_IDS_A: idsA.join(","),
  DEMO_DDI_PHONE_NUMBER_IDS_B: idsB.join(","),
  DEMO_DDI_PHONE_NUMBER_ID: idsA[0] || "",
  FALLBACK_DDI_PHONE_NUMBER_ID: idsA[0] || "",
  DEMO_DDI_PHONE_NUMBER_ID_B: idsB[0] || "",
  FALLBACK_DDI_PHONE_NUMBER_ID_B: idsB[0] || "",
  DEMO_AGENT_ID: agentA,
  DEMO_AGENT_ID_B: agentB
};

console.log("POOL_A", poolA.join(","), "->", idsA.length, idsA);
console.log("POOL_B", poolB.join(","), "->", idsB.length, idsB);
console.log("NOTE: +573110456599 exists in ElevenLabs but is not listable (409 on create).");

if (writeEnv) {
  upsertEnv(pairs);
  console.log("WROTE_ENV=1");
}
