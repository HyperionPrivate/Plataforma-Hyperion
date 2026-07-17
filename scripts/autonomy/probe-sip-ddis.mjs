import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

const numbers = [
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

const key = process.env.ELEVENLABS_API_KEY;
const trunk = {
  address: process.env.SIP_TRUNK_ADDRESS || "sip.voipcentral.net",
  username: process.env.SIP_TRUNK_USERNAME,
  password: process.env.SIP_TRUNK_PASSWORD,
  transport: process.env.SIP_TRUNK_TRANSPORT || "tcp"
};
const agentA = process.env.ELEVENLABS_AGENT_ID;
const agentB = process.env.ELEVENLABS_AGENT_ID_B;

async function el(path, init = {}) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    headers: {
      "xi-api-key": key,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
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

const listed = await el("/v1/convai/phone-numbers");
const list = Array.isArray(listed.json) ? listed.json : listed.json?.phone_numbers || [];
console.log("LISTED", list.length);

for (let i = 0; i < numbers.length; i++) {
  const e164 = numbers[i];
  const agentId = i < 5 ? agentA : agentB;
  const flow = i < 5 ? "A" : "B";
  const existing = list.find((r) => String(r.phone_number || r.number || "").includes(e164.slice(-10)));
  if (existing) {
    const id = existing.phone_number_id || existing.id;
    const patch = await el(`/v1/convai/phone-numbers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ agent_id: agentId })
    });
    console.log(JSON.stringify({ e164, flow, action: "patch_existing", id, status: patch.status }));
    continue;
  }
  const created = await el("/v1/convai/phone-numbers", {
    method: "POST",
    body: JSON.stringify({
      provider: "sip_trunk",
      phone_number: e164,
      label: `Coopfuturo SIP ${e164} · Flujo ${flow}`,
      supports_inbound: true,
      supports_outbound: true,
      agent_id: agentId,
      inbound_trunk_config: null,
      outbound_trunk_config: {
        address: trunk.address,
        transport: trunk.transport,
        credentials: { username: trunk.username, password: trunk.password }
      }
    })
  });
  console.log(
    JSON.stringify({
      e164,
      flow,
      action: "create",
      status: created.status,
      id: created.json?.phone_number_id || created.json?.id || null,
      err: created.status >= 400 ? created.json?.detail || created.json : null
    })
  );
}
