import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

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
  const escaped = q.replace(/'/g, "'\\''");
  return execSync(
    `docker exec plataforma-hyperion-postgres-1 psql -U hyperion -d hyperion -At -F '|' -c '${escaped}'`,
    { encoding: "utf8" }
  ).trim();
}

const rows = sql(`
SELECT c.call_id::text, c.status, c.contact_phone_e164, coalesce(ct.full_name,''),
       coalesce(c.dialer_call_ref,''), coalesce(c.provider_conversation_id,''),
       to_char(c.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS'),
       to_char(c.updated_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS')
FROM voice.calls c
LEFT JOIN nova.contacts ct ON ct.tenant_id=c.tenant_id AND ct.contact_id=c.contact_id
ORDER BY c.created_at DESC LIMIT 3
`);

const calls = rows.split("\n").filter(Boolean).map((line) => {
  const [call_id, status, phone, name, dialer_ref, conversation_id, created, updated] = line.split("|");
  return { call_id, status, phone, name, dialer_ref, conversation_id, created, updated };
});

console.log("=== Ultimas 3 llamadas ===");
console.log(JSON.stringify(calls, null, 2));

const latest = calls[0];
const withConv = calls.find((c) => c.conversation_id) || latest;

async function el(path) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, Accept: "application/json" }
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

if (withConv?.conversation_id) {
  console.log("\n=== Revisando conversacion ElevenLabs ===", withConv.conversation_id);
  const detail = await el(`/v1/convai/conversations/${withConv.conversation_id}`);
  const j = detail.json || {};
  console.log(
    JSON.stringify(
      {
        http: detail.status,
        call_id: withConv.call_id,
        phone: withConv.phone,
        name: withConv.name,
        status: withConv.status,
        created: withConv.created,
        el_status: j.status,
        agent_id: j.agent_id,
        call_duration_secs: j.metadata?.call_duration_secs ?? j.call_duration_secs,
        termination_reason: j.metadata?.termination_reason ?? j.termination_reason,
        analysis: j.analysis
          ? {
              call_successful: j.analysis.call_successful,
              transcript_summary: j.analysis.transcript_summary,
              call_summary_title: j.analysis.call_summary_title
            }
          : null
      },
      null,
      2
    )
  );

  const transcript = Array.isArray(j.transcript) ? j.transcript : [];
  console.log("\n=== Transcripcion ===");
  for (const turn of transcript) {
    const role = turn.role || turn.speaker || "?";
    const msg = turn.message || turn.text || turn.content || "";
    if (!msg) continue;
    console.log(`${role}: ${msg}`);
  }

  // Highlight recibo/matrícula claims
  const blob = transcript.map((t) => `${t.role}: ${t.message || t.text || ""}`).join("\n");
  const lower = blob.toLowerCase();
  const flags = [];
  if (/enviamos.*(recibo|orden|matr)/i.test(blob) || /le enviamos/i.test(blob)) {
    flags.push("POSIBLE: agente dice que NOSOTROS enviamos el recibo/orden");
  }
  if (/puede enviar/i.test(blob) || /envíenos|envienos|mándenos|manden/i.test(lower)) {
    flags.push("OK-ish: pide que el asociado envíe / menciona envío del asociado");
  }
  if (/recibo|orden de matr/i.test(blob)) flags.push("Menciona recibo/orden de matrícula");
  console.log("\n=== Flags guion ===");
  console.log(flags.length ? flags.join("\n") : "(sin menciones claras de recibo)");
} else {
  console.log("\nSin conversation_id aun en las ultimas llamadas.");
}

// post-call reviews for latest phone
const phone = latest?.phone || "";
if (phone) {
  const reviews = sql(`
SELECT r.review_id::text, coalesce(r.status,''), coalesce(r.intent,''), coalesce(r.flow_id,''),
       to_char(r.created_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:MI:SS')
FROM nova.whatsapp_reviews r
WHERE r.phone_e164='${phone}'
ORDER BY r.created_at DESC LIMIT 5
`);
  console.log("\n=== Reviews WA del telefono ===");
  console.log(reviews || "(ninguna)");
}
