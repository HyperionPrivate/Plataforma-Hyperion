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

const res = await fetch("https://api.elevenlabs.io/v1/convai/phone-numbers", {
  headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, Accept: "application/json" }
});
const json = await res.json();
const list = Array.isArray(json) ? json : (json.phone_numbers ?? []);
console.log(JSON.stringify({ status: res.status, count: list.length }, null, 2));
for (const row of list) {
  console.log(
    JSON.stringify({
      id: row.phone_number_id ?? row.id,
      phone: row.phone_number ?? row.number,
      agent: row.agent_id,
      label: row.label
    })
  );
}
