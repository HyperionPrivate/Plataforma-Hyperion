#!/usr/bin/env node
/**
 * Bootstrap ElevenLabs Conversational AI agents for NOVA (Coopfuturo).
 * Reads ELEVENLABS_API_KEY from env / .env. Writes agent ids to stdout as KEY=value.
 * Does NOT purchase/import DDI (requires Twilio SID/token or SIP trunk).
 *
 * Usage:
 *   node scripts/autonomy/elevenlabs-bootstrap-nova.mjs
 *   node scripts/autonomy/elevenlabs-bootstrap-nova.mjs --write-env
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_PATH = resolve(ROOT, ".env");
const BASE = "https://api.elevenlabs.io";

const VOICE_RENOVACION = {
  voiceId: "NyQ87MpRGbszyh7rZLXM", // Fernanda — Warm & Natural (es)
  publicOwnerId: "909042158451df29bd1cad6a1a599e0fe5d3dedb5969181ff78406db3dcfcd5a",
  libraryName: "NOVA Fernanda ES"
};
const VOICE_REACTIVACION = {
  voiceId: "OgAcRHdVLdLpidpAVSz8", // Veronica — Calm & Friendly (es)
  publicOwnerId: "c5c9f609b3c693a05eb394e5eca23dc5c1f90d0590f06563af9c743d0a324a88",
  libraryName: "NOVA Veronica ES"
};

function loadDotEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2] ?? "";
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
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
  writeFileSync(
    ENV_PATH,
    `${out
      .filter((l, i) => !(l === "" && out[i - 1] === ""))
      .join("\n")
      .replace(/\n*$/, "\n")}`,
    "utf8"
  );
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

function agentPayload({ name, prompt, firstMessage, voiceId, tags }) {
  return {
    name,
    tags,
    conversation_config: {
      asr: { quality: "high", provider: "scribe_realtime" },
      turn: { turn_timeout: 7, mode: "turn" },
      tts: {
        model_id: "eleven_flash_v2_5",
        voice_id: voiceId,
        agent_output_audio_format: "pcm_16000"
      },
      conversation: { text_only: false, max_duration_seconds: 600 },
      agent: {
        first_message: firstMessage,
        language: "es",
        prompt: {
          prompt,
          llm: "gemini-2.0-flash",
          temperature: 0.4
        }
      }
    },
    platform_settings: {
      data_collection: {},
      overrides: {
        conversation_config_override: {
          agent: {
            first_message: true,
            language: true,
            prompt: { prompt: true }
          },
          tts: { voice_id: true }
        }
      }
    }
  };
}

const PROMPT_RENOVACION = `Eres Valerie, asesora telefónica de Coopfuturo (cooperativa colombiana).
Tu objetivo es contactar asociados con CDAT o productos próximos a vencer para ofrecer renovación.

Reglas:
- Habla español colombiano, tono cálido, profesional y breve (frases cortas).
- Preséntate, confirma que hablas con la persona correcta y pide un momento.
- Explica de forma simple el beneficio de renovar (continuidad, tasas/condiciones vigentes según lo que el asociado ya conoce; no inventes tasas ni montos).
- Si pregunta cifras exactas, tasas o saldos que no tienes, ofrece transferir a un asesor humano de su sede.
- Si no le interesa, agradece y cierra con cortesía; registra mentalmente el motivo.
- Si pide no ser contactado, confirma opt-out y despídete.
- Nunca digas que eres un modelo de IA de un proveedor; eres la asesora de voz de Coopfuturo.
- No pidas datos sensibles (contraseñas, OTP, CVV). Máximo pide confirmar sede/ciudad si hace falta para el handoff.
- Si el asociado acepta renovar o quiere hablar con un humano, indícalo claramente ("perfecto, un asesor de su sede le contactará / continúa el proceso").
`;

const PROMPT_REACTIVACION = `Eres Valerie, asesora telefónica de Coopfuturo (cooperativa colombiana).
Tu objetivo es reactivar asociados inactivos o con productos vencidos, invitando a volver a colocar o renovar.

Reglas:
- Habla español colombiano, tono cercano y respetuoso, sin presión agresiva.
- Confirma identidad, explica el motivo del llamado (reactivación / volver a operar con la cooperativa).
- No inventes montos, tasas ni beneficios no confirmados.
- Ofrece handoff a asesor humano de la sede cuando pida detalle o acepte avanzar.
- Respeta opt-out de inmediato.
- Nunca reveles que eres un sistema de un proveedor externo.
`;

async function ensureSharedVoice({ voiceId, publicOwnerId, libraryName }) {
  const voices = await el("/v1/voices");
  const list = voices?.voices ?? [];
  if (list.some((v) => v.voice_id === voiceId)) return voiceId;
  await el(`/v1/voices/add/${publicOwnerId}/${voiceId}`, {
    method: "POST",
    body: { new_name: libraryName }
  });
  return voiceId;
}

async function findOrCreate(name, payload, { preferredId, legacyNames = [] } = {}) {
  const list = await el("/v1/convai/agents");
  const agents = Array.isArray(list?.agents) ? list.agents : Array.isArray(list) ? list : [];
  const byId = preferredId ? agents.find((a) => String(a.agent_id || "").trim() === preferredId) : null;
  const byName = agents.find((a) => {
    const n = String(a.name || "").trim();
    return n === name || legacyNames.includes(n);
  });
  const existing = byId || byName;
  if (existing?.agent_id) {
    await el(`/v1/convai/agents/${existing.agent_id}`, { method: "PATCH", body: payload });
    return { agent_id: existing.agent_id, created: false };
  }
  if (preferredId) {
    // Env points at an id not returned by list (pagination/race): still PATCH by id.
    try {
      await el(`/v1/convai/agents/${preferredId}`, { method: "PATCH", body: payload });
      return { agent_id: preferredId, created: false };
    } catch {
      // fall through to create
    }
  }
  const created = await el("/v1/convai/agents/create", { method: "POST", body: payload });
  const agentId = created?.agent_id ?? created?.agentId;
  if (!agentId) throw new Error(`Create agent ${name}: missing agent_id in response`);
  return { agent_id: agentId, created: true };
}

async function main() {
  loadDotEnv();
  const writeEnv = process.argv.includes("--write-env");

  const voiceA = await ensureSharedVoice(VOICE_RENOVACION);
  const voiceB = await ensureSharedVoice(VOICE_REACTIVACION);

  const nameA = "Valerie Coopfuturo - Flujo A";
  const nameB = "Valerie Coopfuturo - Flujo B";

  const renov = await findOrCreate(
    nameA,
    agentPayload({
      name: nameA,
      prompt: PROMPT_RENOVACION,
      firstMessage:
        "Buenos días, le habla Valerie de Coopfuturo. ¿Me confirma si hablo con el asociado o la asociada de la cuenta?",
      voiceId: voiceA,
      tags: ["nova", "coopfuturo", "renovacion", "flujo-a", "valerie"]
    }),
    {
      preferredId: process.env.ELEVENLABS_AGENT_ID?.trim() || process.env.DEMO_AGENT_ID?.trim() || "",
      legacyNames: ["NOVA Renovacion Coopfuturo"]
    }
  );

  const react = await findOrCreate(
    nameB,
    agentPayload({
      name: nameB,
      prompt: PROMPT_REACTIVACION,
      firstMessage:
        "Buenos días, le habla Valerie de Coopfuturo. Quería saludarle para retomar el contacto con la cooperativa. ¿Me confirma si es un buen momento?",
      voiceId: voiceB,
      tags: ["nova", "coopfuturo", "reactivacion", "flujo-b", "valerie"]
    }),
    {
      preferredId: process.env.ELEVENLABS_AGENT_ID_B?.trim() || "",
      legacyNames: ["NOVA Reactivacion Coopfuturo"]
    }
  );

  const phones = await el("/v1/convai/phone-numbers");
  const phoneList = Array.isArray(phones) ? phones : (phones?.phone_numbers ?? []);
  let ddi = process.env.DEMO_DDI_PHONE_NUMBER_ID?.trim() || "";
  if (!ddi && phoneList.length > 0) {
    ddi = String(phoneList[0].phone_number_id || "");
    if (ddi) {
      await el(`/v1/convai/phone-numbers/${ddi}`, {
        method: "PATCH",
        body: { agent_id: renov.agent_id }
      });
    }
  }

  const pairs = {
    ELEVENLABS_AGENT_ID: renov.agent_id,
    ELEVENLABS_AGENT_ID_B: react.agent_id,
    DEMO_AGENT_ID: renov.agent_id
  };
  if (ddi) pairs.DEMO_DDI_PHONE_NUMBER_ID = ddi;

  console.log(`ELEVENLABS_AGENT_ID=${renov.agent_id}`);
  console.log(`ELEVENLABS_AGENT_ID_B=${react.agent_id}`);
  console.log(`DEMO_DDI_PHONE_NUMBER_ID=${ddi || ""}`);
  console.log(`PHONE_NUMBERS_IN_ACCOUNT=${phoneList.length}`);
  console.log(`RENOVACION_CREATED=${renov.created}`);
  console.log(`REACTIVACION_CREATED=${react.created}`);

  if (writeEnv) {
    upsertEnv(pairs);
    console.log("WROTE_ENV=1");
  }

  if (!ddi) {
    console.log(
      "DDI_PENDING=1 import a Twilio/SIP number via POST /v1/convai/phone-numbers then re-run with --write-env"
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  if (err.detail) console.error(JSON.stringify(err.detail, null, 2));
  process.exit(1);
});
