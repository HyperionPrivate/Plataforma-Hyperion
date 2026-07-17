import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ENV_PATH = resolve(import.meta.dirname, "../../.env");
if (existsSync(ENV_PATH)) {
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

function sql(q) {
  return execFileSync(
    "docker",
    ["exec", "plataforma-hyperion-postgres-1", "psql", "-U", "hyperion", "-d", "hyperion", "-At", "-F", "|", "-c", q],
    { encoding: "utf8" }
  ).trim();
}

const q = [
  "SELECT c.call_id::text, c.status, c.contact_phone_e164, coalesce(ct.full_name,''),",
  "coalesce(c.provider_conversation_id,''),",
  "to_char(c.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS')",
  "FROM voice.calls c",
  "LEFT JOIN nova.contacts ct ON ct.tenant_id=c.tenant_id AND ct.contact_id=c.contact_id",
  "WHERE c.provider_conversation_id IS NOT NULL AND c.provider_conversation_id <> ''",
  "ORDER BY c.created_at DESC LIMIT 8"
].join(" ");

const calls = sql(q)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [call_id, status, phone, name, conversation_id, created] = line.split("|");
    return { call_id, status, phone, name, conversation_id, created };
  });

async function el(path) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, Accept: "application/json" }
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let chosen = null;
let detail = null;
for (const call of calls) {
  const d = await el(`/v1/convai/conversations/${call.conversation_id}`);
  const j = d.json || {};
  const transcript = Array.isArray(j.transcript) ? j.transcript : [];
  const duration = j.metadata?.call_duration_secs ?? 0;
  const turns = transcript.filter((t) => (t.message || t.text || "").trim()).length;
  if (duration >= 20 && turns >= 4) {
    chosen = { ...call, duration, turns, termination: j.metadata?.termination_reason, analysis: j.analysis, agent_id: j.agent_id };
    detail = j;
    break;
  }
}

if (!chosen) {
  console.log(JSON.stringify({ error: "no_good_call", recent: calls }, null, 2));
  process.exit(1);
}

const transcript = (detail.transcript || [])
  .map((t) => ({
    role: t.role || "?",
    text: String(t.message || t.text || "").trim()
  }))
  .filter((t) => t.text);

console.log(
  JSON.stringify(
    {
      meta: chosen,
      summary: chosen.analysis?.transcript_summary || null,
      transcript
    },
    null,
    2
  )
);
