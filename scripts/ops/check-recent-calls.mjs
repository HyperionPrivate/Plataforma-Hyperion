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
  "coalesce(c.dialer_call_ref,''), coalesce(c.provider_conversation_id,''),",
  "to_char(c.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS'),",
  "to_char(c.updated_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS')",
  "FROM voice.calls c",
  "LEFT JOIN nova.contacts ct ON ct.tenant_id=c.tenant_id AND ct.contact_id=c.contact_id",
  "ORDER BY c.created_at DESC LIMIT 6"
].join(" ");

const rows = sql(q);
const calls = rows.split("\n").filter(Boolean).map((line) => {
  const [call_id, status, phone, name, dialer_ref, conversation_id, created, updated] = line.split("|");
  return { call_id, status, phone, name, dialer_ref, conversation_id, created, updated };
});

console.log("=== voice.calls ===");
console.log(JSON.stringify(calls, null, 2));

async function el(path) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, Accept: "application/json" }
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const list = await el("/v1/convai/conversations?page_size=15");
const items = Array.isArray(list.json?.conversations)
  ? list.json.conversations
  : Array.isArray(list.json)
    ? list.json
    : [];
console.log("\n=== ElevenLabs recent conversations ===");
for (const c of items.slice(0, 12)) {
  const start = c.start_time_unix_secs || c.metadata?.start_time_unix_secs;
  const when = start ? new Date(Number(start) * 1000).toISOString() : null;
  console.log(
    JSON.stringify({
      conversation_id: c.conversation_id || c.id,
      agent_id: c.agent_id,
      status: c.status,
      when,
      duration: c.call_duration_secs || c.metadata?.call_duration_secs,
      to: c.metadata?.phone_call?.external_number || c.metadata?.phone_call?.to_number || c.metadata?.phone_call?.agent_phone_number_id
    })
  );
}

for (const call of calls.slice(0, 5)) {
  if (!call.conversation_id) {
    console.log(`\n[SIN CONV] ${call.created} ${call.phone} ${call.name} status=${call.status} dialer=${call.dialer_ref}`);
    continue;
  }
  const detail = await el(`/v1/convai/conversations/${call.conversation_id}`);
  const j = detail.json || {};
  const transcript = Array.isArray(j.transcript) ? j.transcript : [];
  console.log(`\n[CON CONV] ${call.created} ${call.phone}`);
  console.log(
    JSON.stringify({
      conversation_id: call.conversation_id,
      el_status: j.status,
      duration: j.metadata?.call_duration_secs,
      termination: j.metadata?.termination_reason,
      turns: transcript.length
    })
  );
}

try {
  const logs = execFileSync(
    "docker",
    ["logs", "--since", "25m", "plataforma-hyperion-neutral-dialer-1"],
    { encoding: "utf8", maxBuffer: 5_000_000 }
  );
  const interesting = logs
    .split("\n")
    .filter((l) => /demo|initiate|error|429|failed|573002555948|phone_number|conversation/i.test(l))
    .slice(-60);
  console.log("\n=== dialer log hits ===");
  console.log(interesting.join("\n") || "(none)");
} catch (e) {
  console.log("dialer logs error", e.message);
}
