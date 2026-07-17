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

const agents = [
  ["A", process.env.ELEVENLABS_AGENT_ID],
  ["B", process.env.ELEVENLABS_AGENT_ID_B]
].filter(([, id]) => id);

for (const [label, agent] of agents) {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agent}`, {
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, Accept: "application/json" }
  });
  const j = await res.json();
  const prompt = String(j?.conversation_config?.agent?.prompt?.prompt ?? "");
  const first = String(j?.conversation_config?.agent?.first_message ?? "");
  const lower = prompt.toLowerCase();
  const idxs = [];
  for (const needle of ["recibo", "matrícula", "matricula", "enviamos", "enviar", "whatsapp", "orden"]) {
    let from = 0;
    while (true) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      idxs.push({ needle, i, snip: prompt.slice(Math.max(0, i - 40), i + 140).replace(/\s+/g, " ") });
      from = i + needle.length;
      if (idxs.length > 30) break;
    }
  }
  console.log("==== AGENT", label, agent, "status", res.status);
  console.log("FIRST:", first.slice(0, 280));
  console.log("SNIPS:");
  for (const s of idxs.slice(0, 15)) console.log("-", s.needle, "::", s.snip);
}
