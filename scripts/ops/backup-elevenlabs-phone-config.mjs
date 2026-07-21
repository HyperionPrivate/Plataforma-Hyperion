/** Back up the current ElevenLabs phone-number configuration before mutation. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const envPath = resolve(ROOT, process.env.ELEVENLABS_IMPORT_ENV_FILE?.trim() || ".env");

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    process.env[match[1]] = value;
  }
}

const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const output = process.env.ELEVENLABS_PHONE_CONFIG_BACKUP?.trim();
if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required");
if (!output || !isAbsolute(output)) throw new Error("ELEVENLABS_PHONE_CONFIG_BACKUP must be an absolute path");

const ids = new Set();
for (const key of [
  "DEMO_DDI_PHONE_NUMBER_ID",
  "DEMO_DDI_PHONE_NUMBER_ID_B",
  "DEMO_DDI_PHONE_NUMBER_IDS_A",
  "DEMO_DDI_PHONE_NUMBER_IDS_B"
]) {
  for (const value of String(process.env[key] || "").split(",")) {
    if (value.trim()) ids.add(value.trim());
  }
}
if (process.env.ELEVENLABS_BACKUP_ALL_SIP_TRUNKS === "true") {
  const response = await fetch("https://api.elevenlabs.io/v1/convai/phone-numbers", {
    headers: { "xi-api-key": apiKey, Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`ElevenLabs phone list failed with status ${response.status}`);
  const payload = await response.json();
  const phones = Array.isArray(payload) ? payload : (payload.phone_numbers ?? []);
  for (const phone of phones) {
    if (phone.provider !== "sip_trunk") continue;
    const id = String(phone.phone_number_id ?? phone.id ?? "").trim();
    if (id) ids.add(id);
  }
}
if (!ids.size) throw new Error("No configured DDI phone-number IDs found");

const rows = [];
for (const id of ids) {
  const response = await fetch(`https://api.elevenlabs.io/v1/convai/phone-numbers/${encodeURIComponent(id)}`, {
    headers: { "xi-api-key": apiKey, Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`ElevenLabs phone read failed with status ${response.status}`);
  rows.push(await response.json());
}

writeFileSync(output, `${JSON.stringify({ captured_at: new Date().toISOString(), phones: rows }, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600
});
console.log(`BACKED_UP_PHONE_CONFIGS=${rows.length}`);
console.log(`BACKUP_PATH=${output}`);
