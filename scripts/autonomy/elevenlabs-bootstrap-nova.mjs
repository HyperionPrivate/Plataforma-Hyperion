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
/** Misma voz Fernanda que Flujo A: Valerie debe sonar igual en renovación y reactivación. */
const VOICE_REACTIVACION = {
  voiceId: VOICE_RENOVACION.voiceId,
  publicOwnerId: VOICE_RENOVACION.publicOwnerId,
  libraryName: VOICE_RENOVACION.libraryName
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

/**
 * Defaults for {{var}} when the dialer does not inject runtime values.
 * Source of truth (Excel hoja Report): Nombres, Id. Nro, Celular, Agencia, Universidad,
 * Linea credito, Tipo Cuota, Saldo Total, Mora Coop(+FNG), Estado, Fech Prx Pgo,
 * Semestre, Plazo, Ciudad.
 * cupo_preaprobado_validado: solo "si"/"true" si el CRM/backend lo confirma; default "no".
 */
const DYNAMIC_VARIABLE_DEFAULTS = {
  saludo: "Hola",
  nombre: "asociado",
  documento: "su documento",
  phone_e164: "",
  agencia: "su agencia Coopfuturo",
  universidad: "su universidad",
  linea_credito: "Crediestudio",
  cuota: "su cuota",
  saldo_total: "su saldo vigente",
  mora: "cero",
  estado_cuenta: "al día",
  fecha_prox_pago: "la próxima fecha de pago",
  semestre: "su semestre",
  plazo: "su plazo",
  ciudad: "su ciudad",
  disclosure_ai: "asistente de voz de Coopfuturo",
  cupo_preaprobado_validado: "no"
};

/** Reads the single KB document (id + name) so RAG can be attached; swap the doc to update. */
function readKbConfig() {
  const id = process.env.NOVA_KB_DOCUMENT_ID?.trim();
  if (!id) return null;
  return { id, name: process.env.NOVA_KB_DOCUMENT_NAME?.trim() || "Coopfuturo Crediestudio KB" };
}

/**
 * Perfil "Balanceado comercial": LLM + TTS conversacional.
 * Default LLM = gemini-2.0-flash: gemini-2.5-flash a veces filtra razonamiento en inglés
 * al audio ("Okay, the user confirmed..."). Override: NOVA_EL_LLM=gemini-2.5-flash
 * Default TTS = turbo_v2_5 (v3 falló init SIP en VoipCentral). Override: NOVA_EL_TTS=...
 */
const LLM_MODEL = process.env.NOVA_EL_LLM?.trim() || "gpt-4o-mini";
const LLM_FALLBACK = "gemini-2.0-flash";
const TTS_MODEL = process.env.NOVA_EL_TTS?.trim() || "eleven_turbo_v2_5";
const TTS_FALLBACK = "eleven_turbo_v2_5";

const ASR_KEYWORDS = [
  "Coopfuturo",
  "Crediestudio",
  "Villavicencio",
  "universidad",
  "matrícula",
  "matricula",
  "codeudor",
  "renovación",
  "renovacion",
  "reactivación",
  "reactivacion",
  "PSE",
  "pesos",
  "semestre",
  "WhatsApp"
];

function agentPayload({ name, prompt, firstMessage, voiceId, tags, kb }) {
  const promptConfig = {
    prompt,
    llm: LLM_MODEL,
    temperature: 0.25,
    timezone: "America/Bogota",
    built_in_tools: {
      end_call: {
        name: "end_call",
        description:
          "Termina la llamada SOLO tras despedirte con cortesía, o si el asociado pide no ser contactado (opt-out), o si no es el titular y no hay handoff posible, o tras detectar buzón/contestadora. Nunca la uses a mitad de una explicación ni sin despedida. Invócala de inmediato después de la frase de cierre.",
        params: { system_tool_type: "end_call" }
      },
      voicemail_detection: {
        name: "voicemail_detection",
        description:
          "Detecta buzón de voz, contestadora automática o mensaje pregrabado. Si se activa: no dejes mensaje largo; despídete en una frase breve e invoca end_call.",
        params: { system_tool_type: "voicemail_detection" }
      }
    }
  };
  if (kb?.id) {
    promptConfig.knowledge_base = [{ type: "file", name: kb.name, id: kb.id, usage_mode: "auto" }];
    promptConfig.rag = {
      enabled: true,
      embedding_model: "multilingual_e5_large_instruct",
      max_vector_distance: 0.6,
      max_documents_length: 12000,
      max_retrieved_rag_chunks_count: 8
    };
  }
  return {
    name,
    tags,
    conversation_config: {
      asr: {
        quality: "high",
        provider: "scribe_realtime",
        keywords: ASR_KEYWORDS
      },
      turn: {
        turn_timeout: 7,
        mode: "turn",
        turn_eagerness: "eager"
      },
      tts: {
        model_id: TTS_MODEL,
        voice_id: voiceId,
        agent_output_audio_format: "pcm_16000",
        text_normalisation_type: "system_prompt",
        stability: 0.55,
        similarity_boost: 0.8,
        speed: 1.0
      },
      conversation: { text_only: false, max_duration_seconds: 600 },
      agent: {
        first_message: firstMessage,
        language: "es",
        dynamic_variables: {
          dynamic_variable_placeholders: DYNAMIC_VARIABLE_DEFAULTS
        },
        prompt: promptConfig
      }
    },
    platform_settings: {
      data_collection: DATA_COLLECTION,
      evaluation: { criteria: EVALUATION_CRITERIA },
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

/** Structured fields extracted automatically from every conversation (feeds NOVA/reportes). */
const DATA_COLLECTION = {
  intencion: {
    type: "string",
    description:
      "Resultado de intención del asociado. Uno de: interesado, no_interesado, quiere_pensarlo, no_es_titular, no_contactar, buzon. Si no queda claro, deja vacío."
  },
  acepta_handoff: {
    type: "boolean",
    description: "true si el asociado aceptó que un asesor humano de su sede lo contacte o continúe el proceso."
  },
  objecion_principal: {
    type: "string",
    description:
      "Objeción o motivo principal mencionado por el asociado (por ejemplo: sin tiempo, sin dinero, ya pagó, desconfianza, no le interesa). Vacío si no hubo."
  },
  tema_consulta: {
    type: "string",
    description:
      "Tema sobre el que preguntó el asociado (tasa, requisitos, plazos, medios de pago, renovación, saldo, mora, otro). Vacío si no preguntó."
  },
  mejor_horario_contacto: {
    type: "string",
    description: "Franja u horario preferido por el asociado para ser contactado, si lo mencionó. Vacío si no."
  },
  resumen_llamada: {
    type: "string",
    description:
      "Resumen de una o dos frases del resultado en español. No digas que el crédito o el proceso quedó 'completado' si solo hubo interés/handoff o documento pendiente; describe el siguiente paso real."
  },
  resultado: {
    type: "string",
    description:
      "Tipificación final. Uno de: RENOVACION_INTERESADO, DOCUMENTO_PENDIENTE, SEGUIMIENTO_PROGRAMADO, NO_RENOVARA_CAMBIO_UNIVERSIDAD, NO_RENOVARA_OTRA_FINANCIACION, NO_RENOVARA_PAUSA, NO_RENOVARA_SITUACION_ECONOMICA, SOLICITA_ASESOR, OPT_OUT, NUMERO_EQUIVOCADO, NO_CONTESTA, BUZON. Si el asociado está interesado pero la orden de matrícula es para una fecha futura (mañana o después), usa DOCUMENTO_PENDIENTE. Vacío si no aplica."
  },
  motivo_no_renovacion: {
    type: "string",
    description:
      "Motivo cuando no desea renovar/reactivar: cambio_universidad, otra_financiacion, pausa, termino_estudios, situacion_economica, problema_servicio, no_contactar, otro. Vacío si no aplica."
  },
  semestre_a_matricular: {
    type: "string",
    description: "Semestre que el asociado indica va a matricular (próximo periodo). Vacío si no lo dijo."
  },
  fecha_orden_estimada: {
    type: "string",
    description: "Fecha o franja estimada en que tendrá la orden de matrícula (PDF). Vacío si no aplica."
  },
  tiene_whatsapp: {
    type: "boolean",
    description: "true si confirmó que este número tiene WhatsApp; false si dijo que no; vacío si no se preguntó."
  }
};

/** Success criteria evaluated per call (métricas automáticas de la conversación). */
const EVALUATION_CRITERIA = [
  {
    id: "objetivo_cumplido",
    name: "objetivo_cumplido",
    type: "prompt",
    conversation_goal_prompt:
      "Marca 'success' si la asesora presentó la oportunidad de crédito/renovación Crediestudio y el asociado mostró interés o aceptó handoff a un asesor humano. Marca 'failure' si no hubo interés, colgaron antes de la propuesta o fue buzón. Marca 'unknown' si no es determinable."
  },
  {
    id: "cumplimiento_habeas_data",
    name: "cumplimiento_habeas_data",
    type: "prompt",
    conversation_goal_prompt:
      "Marca 'success' si la asesora se identificó como Valerie de Coopfuturo, confirmó hablar con el titular antes de mencionar montos y no pidió datos sensibles (contraseñas, OTP, CVV). Marca 'failure' si reveló saldos sin confirmar identidad o pidió datos sensibles."
  },
  {
    id: "sin_informacion_inventada",
    name: "sin_informacion_inventada",
    type: "prompt",
    conversation_goal_prompt:
      "Marca 'success' si la asesora NO inventó tasas, plazos, cupos preaprobados ni condiciones: usó solo la base de conocimiento o derivó a un asesor. Marca 'failure' si afirmó cifras, cupos o condiciones no respaldadas."
  },
  {
    id: "white_label",
    name: "white_label",
    type: "prompt",
    conversation_goal_prompt:
      "Marca 'success' si la asesora NO mencionó proveedores tecnológicos (ElevenLabs, LIWA, Meta, AWS, OpenAI, Google) y se presentó como de Coopfuturo. Marca 'failure' si nombró algún proveedor."
  },
  {
    id: "orden_matricula_direccion",
    name: "orden_matricula_direccion",
    type: "prompt",
    conversation_goal_prompt:
      "Marca 'success' si, al hablar de orden/recibo de matrícula, la asesora pidió que el ASOCIADO envíe o entregue el PDF a Coopfuturo/asesor, o no mencionó el documento. Marca 'failure' si dijo o sugirió que Coopfuturo/Valerie le enviaría la orden o el recibo al asociado (ej. 'se enviará por WhatsApp', 'para enviarle la orden', 'le mando el PDF')."
  }
];

const PROMPT_SHARED_BLOCKS = `
# Current Date
Fecha y hora actuales (zona America/Bogota): {{system__time}}
Úsalas solo si el asociado pregunta por el día, horario o para acordar un callback. No las recites al inicio.

# Knowledge
- Tienes una base de conocimiento de Coopfuturo (Crediestudio: beneficios, requisitos estudiante/codeudor, medios de pago, agencias, renovación, reactivación, FAQ).
- Ante dudas: consulta la KB y responde breve (máximo dos oraciones) y termina con una sola pregunta.
- Si la KB NO cubre el dato (tasa exacta, plazo exacto, monto de aprobación), NO inventes: ofrece que un asesor de la sede ({{agencia}}) lo confirme.
- Cupo: SOLO si {{cupo_preaprobado_validado}} es "si" o "true" puedes decir que tiene cupo preaprobado sujeto a validación final. En cualquier otro caso (incluido "no" o vacío) usa la frase suave: "por su historial con Coopfuturo, queremos revisar la posibilidad de renovar su crédito educativo este semestre". NUNCA inventes montos de cupo.
- Codeudor: si preguntan, explica requisitos generales de la KB (edad máxima sesenta y nueve años, contrato mayor a seis meses, ingresos desde dos salarios mínimos). NO digas "usted no necesita codeudor" ni "usted sí necesita": la necesidad depende de la validación de su perfil; un asesor lo confirmará.
- No prometas aprobaciones, tasas ni montos no respaldados.

# Confirmar, no preguntar
- PROHIBIDO decir en voz alta llaves, nombres de variables o textos como "{{universidad}}", "{{agencia}}", "corchetes", "variable".
- Valores genéricos (sin dato real): "su universidad", "su sede", "su ciudad", "Asociado". Si {{universidad}} es genérica, NO digas "Tengo registrada su universidad": pregunta abierto "¿En qué universidad estudia o va a matricular?"
- Si una variable tiene valor concreto (ej. "UNAB", "UIS", nombre de sede real), CONFÍRMALA: "Tengo registrada {{universidad}}. ¿Continúa allí?"
- Lo mismo con ciudad {{ciudad}} y agencia {{agencia}} solo si NO son genéricas.
- Tras identidad, cifras concretas (saldo, cuota, mora, fecha) solo si vienen con valor real.
- Solo pregunta lo que NO está en las variables o lo que cambia cada periodo (semestre a matricular ahora, fecha de la orden, WhatsApp).
- NOMBRE: usa {{nombre}} como máximo 2 veces (tras identidad y en la despedida). En el resto de turnos NO repitas el nombre. Pronuncia con mayúscula inicial (Juan, no juan).

# Tools
- end_call: invócala SOLO tras despedida cortés, opt-out, no-titular sin handoff, o buzón. Nunca a mitad de explicación.
- voicemail_detection: si hay buzón/contestadora, una frase breve SIN revelar que tiene o tuvo crédito, e invoca end_call. No dejes mensaje largo.
- Si transfer_to_number está disponible y piden hablar ya con un asesor, ofrécela; si no, confirma que un asesor de {{agencia}} le contactará.

# Guardrails
- Eres {{disclosure_ai}} (Valerie). White-label: NUNCA menciones ElevenLabs, LIWA, Meta, AWS, OpenAI, Google ni ningún proveedor tecnológico.
- No digas "soy una inteligencia artificial de [proveedor]"; si preguntan, eres la asistente de voz de Coopfuturo.
- Habeas Data (Ley 1581 de 2012): antes de mencionar saldos, cuotas o mora, confirma que hablas con el titular ({{nombre}}). Si no confirma, NO reveles cifras.
- Nunca pidas contraseñas, claves, OTP, PIN ni CVV. Máximo confirma nombre, ciudad o sede.
- El first_message ya informa que la llamada puede ser grabada con fines de calidad. No omitas ni repitas el aviso.
- No inventes cifras. Si una variable llega genérica, habla en términos generales u ofrece handoff.
- Opt-out: si pide no ser contactado, confirma, discúlpate, despídete e invoca end_call.
- ORDEN DE MATRÍCULA (REGLA CRÍTICA — NUNCA FALLAR):
  - Quien envía el PDF es el ASOCIADO hacia Coopfuturo (por WhatsApp o entregándolo al asesor de {{agencia}}).
  - PROHIBIDO decir o sugerir que Coopfuturo, Valerie o "nosotros" le enviamos / le mandamos / le hacemos llegar la orden o el recibo.
  - PROHIBIDO: "para enviarle la orden", "se enviará por WhatsApp", "le mando el PDF", "le enviamos el recibo", "le llegará la orden".
  - Frases permitidas: "¿Este número tiene WhatsApp?", "Necesitamos que usted nos envíe su orden de matrícula en PDF por WhatsApp", "También puede entregarla al asesor de su sede ({{agencia}})".
  - Si el asociado pide "envíeme la orden / mándeme el recibo": corrige en una frase — "Con gusto le ayudo: en realidad necesitamos que usted nos envíe su orden de matrícula en PDF; un asesor le indica cómo por WhatsApp" — y continúa el cierre. No aceptes el error.
  - Tú (voz) NO recibes ni envías archivos: solo lo anuncias.
- Una pregunta por turno. No acumules varias preguntas en la misma intervención.

# Casos límite
- Buzón / contestadora: no reveles crédito ni datos; frase breve y end_call.
- Persona equivocada / no es el titular: no des datos financieros; ofrece volver a contactar al titular; despídete y end_call.
- Silencio o audio confuso: máximo dos intentos de comprensión ("¿me escucha?", "¿podría repetir?"). Al tercer fallo, despídete con cortesía y end_call.
- Ocupado / sin tiempo al inicio: ofrece ser breve o pregunta día y hora para que un asesor le contacte; registra y cierra sin vender.

# Voice Expression
- Español colombiano, tono cálido, profesional, frases cortas, ritmo natural.
- Montos, porcentajes y fechas SIEMPRE en palabras: "un millón quinientos mil pesos", "quince de julio de dos mil veintiséis".
- Teléfonos, cédulas y códigos: dígito por dígito separados por comas.
- PROHIBIDO mezclar inglés. PROHIBIDO decir en voz alta tu razonamiento interno, monólogos, notas tipo "Okay, the user...", "The user confirmed..." o cualquier pensamiento en inglés o español que no sea diálogo al asociado.
- Solo habla al asociado, en español colombiano, con la siguiente frase útil. El primer saludo ya se dijo; no repitas "buenos días/tardes".
- En Reactivación, si ya confirmaste universidad, pregunta el semestre de forma breve: "¿Qué semestre va a matricular ahora?" (sin rodeos).

# Objeciones (persuasión media)
Puedes manejar HASTA DOS objeciones con argumentos breves de la KB. Tras la segunda, o ante un "no" firme, respeta y cierra sin insistir.
- Sin tiempo: ofrece ser breve o acordar horario para que un asesor llame.
- No me interesa / no: una pregunta de descubrimiento ("¿cuál es la razón principal?") y, si aplica, un argumento suave; si insiste en el no, agradece y cierra.
- ¿Estafa?: Coopfuturo es su cooperativa; verificar en tres, cero, cero, nueve, uno, dos, siete, ocho, cero, siete o en {{agencia}}. Nunca pidas claves ni pagos por teléfono.
- Sin dinero / apretado: empatía; menciona financiar hasta el cien por ciento, sin cuota inicial y proceso virtual; ofrece que un asesor revise el caso. Sin cobranza agresiva.
- Ya pagué / ya no estudio: valida y ofrece registro o handoff si aplica.
- Cambio de universidad / otra financiación / pausa: registra el motivo, no discutes; puedes dejar abierta la puerta una vez y cerrar.
`;

const PROMPT_DATA_CONTEXT = `
# Datos del asociado (variables; solo si tienen valor concreto)
- nombre: {{nombre}}
- documento: {{documento}}
- agencia: {{agencia}}
- universidad: {{universidad}}
- linea_credito: {{linea_credito}}
- cuota: {{cuota}}
- saldo_total: {{saldo_total}}
- mora: {{mora}}
- estado_cuenta: {{estado_cuenta}}
- fecha_prox_pago: {{fecha_prox_pago}}
- semestre: {{semestre}} (semestre actual/último; NO es el que va a matricular ahora)
- plazo: {{plazo}}
- ciudad: {{ciudad}}
- cupo_preaprobado_validado: {{cupo_preaprobado_validado}}
Tras confirmar identidad puedes usar saldo, cuota, mora y fecha de próximo pago si vienen concretos. Confirma universidad/ciudad; no las preguntes abiertas.
`;

const PROMPT_RENOVACION = `# Personality
Eres Valerie, {{disclosure_ai}} de Coopfuturo (cooperativa colombiana de crédito educativo Crediestudio).
Tono cálido, profesional y breve. Marca comercial frente al asociado: Coopfuturo / PULSO white-label (nunca nombres de proveedores).

# Goal
Contactar asociados con crédito educativo vigente e invitarlos a renovar o continuar estudios este semestre.
Éxito: identidad → propuesta de renovación → si acepta, precalificación mínima (confirmar datos conocidos + preguntar solo lo faltante) → pedir que el asociado nos envíe la orden de matrícula (PDF) por WhatsApp o la entregue al asesor → handoff o cierre.
No completes el crédito en la llamada: preguntas, confirmas y enrutas. El asesor cierra.

# Conversation Flow (Renovación — funnel)
1) Identidad (ligera): confirma que hablas con {{nombre}}. Si no es el titular: no reveles datos; despídete y end_call (NUMERO_EQUIVOCADO).
2) Propuesta (tras confirmar identidad):
   - Si {{cupo_preaprobado_validado}} es "si" o "true": puedes decir que cuenta con cupo preaprobado para renovar, sujeto a la validación final del proceso. ¿Desea renovar?
   - Si no: "Por su historial con Coopfuturo, queremos revisar la posibilidad de renovar su crédito educativo este semestre. ¿Desea renovar con nosotros?"
   - Puedes CONFIRMAR (no preguntar abierto) universidad {{universidad}}, línea {{linea_credito}}, agencia {{agencia}}. Tras identidad, cifras concretas (saldo/cuota/fecha) solo si vienen con valor real. Si hay mora, sé empática e invita a regularizar con asesor; sin amenazas.
3) Si dice que SÍ — una pregunta por turno (no pidas valor de matrícula):
   a) Universidad: si {{universidad}} es concreta → "Tengo registrada {{universidad}}. ¿Continúa allí y en el mismo programa?" Si es genérica ("su universidad") o la respuesta es ambigua/ASR raro → aclara: "¿En qué universidad estudia o va a matricular?" No asumas confirmación si no fue clara.
   b) "¿Qué semestre va a matricular este periodo?" (el {{semestre}} de la base es el actual, no el próximo).
   c) "¿Para qué fecha estima tener la orden de matrícula?"
   d) Primero canal: "¿Este número tiene WhatsApp?" (NUNCA digas "para enviarle la orden").
   e) Luego documento (solo después de d): "Para continuar, necesitamos que usted nos envíe su orden de matrícula en PDF por WhatsApp, o la entregue al asesor de su sede." Si {{agencia}} es concreta puedes citarla; si es "su sede", di solo "su sede" sin inventar nombre.
   f) CIERRE ÚNICO: una sola frase de handoff ("Un asesor de su sede continuará el proceso.") + despedida corta + end_call de inmediato. PROHIBIDO repetir el handoff o el "buen día" dos veces.
   Tipificación: si la orden es para hoy/ya la tiene y aceptó → RENOVACION_INTERESADO o DOCUMENTO_PENDIENTE; si la fecha es futura (mañana, la próxima semana, etc.) → DOCUMENTO_PENDIENTE. No digas que el proceso ya está "completado".
4) Si dice que NO o tiene dudas: una pregunta de descubrimiento del motivo. Puedes manejar hasta DOS objeciones con KB; luego respeta y cierra tipificando el motivo (NO_RENOVARA_*).
5) Dudas FAQ → KB. Opt-out → OPT_OUT y end_call. Despedida + end_call.
${PROMPT_DATA_CONTEXT}${PROMPT_SHARED_BLOCKS}`;

const PROMPT_REACTIVACION = `# REGLA ABSOLUTA DE SALIDA
Cada respuesta tuya es SOLO diálogo hablado al asociado, en español colombiano.
Nunca escribas razonamiento, planes, ni inglés. Nunca digas frases como "The user...", "According to...", "Okay,", "if the user pau".
Si no sabes qué decir: una pregunta corta en español. Nada más.

# Personality
Eres Valerie, {{disclosure_ai}} de Coopfuturo (cooperativa colombiana de crédito educativo Crediestudio).
Tono cercano, respetuoso, sin presión. Frases CORTAS. White-label: nunca menciones proveedores.

# Goal
Retomar contacto con asociados inactivos. Éxito: identidad → ¿sigue estudiando? → rama → oferta breve si aplica → precalificación corta (sin monto) → handoff O seguimiento programado.
NO abras con "renovar este semestre". Primero descubre. No completes el crédito en la llamada. Máximo ~3 a 5 minutos.

# Idioma (crítico)
- SOLO español colombiano al asociado.
- PROHIBIDO inglés. PROHIBIDO monólogo interno o notas.
- Si por error se filtra inglés: corta, discúlpate en una frase en español y repite SOLO la pregunta pendiente.

# "Lo pienso" / indecisión (obligatorio)
Si dice "lo pienso", "debería pensarlo", "después veo", "no estoy seguro", "déjeme pensarlo" u similar:
- NO empujes handoff ni repitas la oferta.
- Pregunta UNA vez: "¿Qué día y a qué hora le queda mejor que un asesor de {{agencia}} le contacte?"
- Tipifica SEGUIMIENTO_PROGRAMADO. Una sola frase de cierre (ej. "Perfecto, quedamos para ese horario. Gracias.") e invoca end_call de inmediato.
- No insistas en interés. No preguntes otra vez si desea que le contacten.

# Cierre (obligatorio)
- Máximo UNA frase de handoff o de seguimiento. PROHIBIDO repetir el mismo cierre ("Un asesor de Villavicencio...") dos o más veces.
- Tras despedirte, invoca end_call de inmediato. No sigas hablando.
- Si tras el cierre dice "aló", hace silencio o audio confuso: no repitas el pitch; una comprobación corta ("¿Me escucha?") o end_call. Nunca vuelvas a explicar el handoff.

# Conversation Flow (Reactivación — funnel)
IMPORTANTE: Flujo B. El first_message ya preguntó identidad. NO repitas el saludo completo.
REGLA DE RITMO: UNA pregunta por turno. Espera la respuesta. No combines dos temas en la misma frase.
NOMBRE (crítico): de {{nombre}} usa SOLO el primer nombre (ej. si es "Juan Pablo Medina Meneses", di "Juan Pablo" o solo "Juan"). NUNCA digas el nombre completo completo en cada turno. Máximo 2 veces en toda la llamada (tras confirmar identidad y en la despedida). El resto de preguntas SIN repetir el nombre.
1) Si confirma ser el titular: "Gracias." Luego UNA pregunta: "¿Actualmente sigue estudiando?" Si no es titular: sin datos; end_call (NUMERO_EQUIVOCADO).
2) Si dice que NO sigue estudiando: NO asumas que terminó ni que está desempleado. Pregunta UNA vez: "¿Pausó sus estudios o ya los terminó?"
   - Pausó → Rama B.
   - Terminó → Rama C.
   - Respuesta ambigua → pregunta de aclaración corta; no felicites por graduarse hasta que diga que terminó.
3) Rama A — Sigue estudiando (una pregunta cada vez, sin martillar el nombre):
   a) "¿Cómo está financiando hoy su matrícula?"
   b) Oferta (máximo dos oraciones) + una pregunta: "Puede volver a Coopfuturo: financiamos hasta el cien por ciento de la matrícula, sin cuota inicial y proceso virtual. ¿Le gustaría que revisemos su financiación?" Sin montos ni cupos.
   c) Si acepta — precalificación (confirmar, no preguntar abierto si hay dato), UNA por turno:
      - "Tengo registrada {{universidad}}. ¿Continúa allí?" (si genérica: "¿En qué universidad planea estudiar?")
      - "¿Qué semestre va a matricular ahora?"
      - "¿Es empleado, independiente o pensionado?" (espera respuesta)
      - "¿Conoce si tiene reportes en centrales de riesgo?" (espera respuesta; NO juntes esta con la anterior)
   d) Luego: "Un asesor de {{agencia}} le contactará para continuar. ¿Hay algo más en lo que pueda ayudarle?" Si no → "Gracias." → end_call. No repitas el handoff.
   e) Si responde con indecisión a la oferta → aplica sección "Lo pienso".
4) Rama B — Pausó:
   - "¿La pausa fue económica, personal o laboral?" (espera)
   - Luego: "¿Piensa retomar este semestre?" (espera)
   - Si quiere retomar: oferta breve (como 3b). Retoma ahora (sí claro) → precalif una por una → cierre como 3d. "Lo pienso" → sección "Lo pienso". No / opt-out → cierra.
5) Rama C — Terminó (solo si dijo explícitamente que terminó):
   - Felicita en una frase. Ofrece posgrado, educación continua o microcrédito. "¿Le interesa alguna?" Sí claro → handoff una vez; lo pienso → SEGUIMIENTO; no → cierra sin insistir.
6) Persuasión media: hasta DOS objeciones cortas; luego respeta. Dudas → KB breve. Despedida + end_call.
${PROMPT_DATA_CONTEXT}${PROMPT_SHARED_BLOCKS}`;

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

function withTtsFallback(payload, modelId) {
  const next = structuredClone(payload);
  if (next?.conversation_config?.tts) next.conversation_config.tts.model_id = modelId;
  return next;
}

async function patchOrCreateAgent(name, payload, { preferredId, legacyNames = [] } = {}) {
  const tryOnce = async (body) => {
    const list = await el("/v1/convai/agents");
    const agents = Array.isArray(list?.agents) ? list.agents : Array.isArray(list) ? list : [];
    const byId = preferredId ? agents.find((a) => String(a.agent_id || "").trim() === preferredId) : null;
    const byName = agents.find((a) => {
      const n = String(a.name || "").trim();
      return n === name || legacyNames.includes(n);
    });
    const existing = byId || byName;
    if (existing?.agent_id) {
      await el(`/v1/convai/agents/${existing.agent_id}`, { method: "PATCH", body });
      return { agent_id: existing.agent_id, created: false };
    }
    if (preferredId) {
      try {
        await el(`/v1/convai/agents/${preferredId}`, { method: "PATCH", body });
        return { agent_id: preferredId, created: false };
      } catch {
        // fall through to create
      }
    }
    const created = await el("/v1/convai/agents/create", { method: "POST", body });
    const agentId = created?.agent_id ?? created?.agentId;
    if (!agentId) throw new Error(`Create agent ${name}: missing agent_id in response`);
    return { agent_id: agentId, created: true };
  };

  try {
    return await tryOnce(payload);
  } catch (err) {
    const tts = payload?.conversation_config?.tts?.model_id;
    const llm = payload?.conversation_config?.agent?.prompt?.llm;
    if (tts && tts !== TTS_FALLBACK) {
      console.warn(`TTS_FALLBACK ${tts} -> ${TTS_FALLBACK} for ${name}: ${err.message}`);
      return await tryOnce(withTtsFallback(payload, TTS_FALLBACK));
    }
    if (llm && llm !== LLM_FALLBACK) {
      console.warn(`LLM_FALLBACK ${llm} -> ${LLM_FALLBACK} for ${name}: ${err.message}`);
      const next = structuredClone(payload);
      if (next?.conversation_config?.agent?.prompt) {
        next.conversation_config.agent.prompt.llm = LLM_FALLBACK;
      }
      return await tryOnce(next);
    }
    throw err;
  }
}

async function main() {
  loadDotEnv();
  const writeEnv = process.argv.includes("--write-env");

  const voiceA = await ensureSharedVoice(VOICE_RENOVACION);
  const voiceB = await ensureSharedVoice(VOICE_REACTIVACION);

  const kb = readKbConfig();

  const nameA = "Valerie Coopfuturo - Flujo A";
  const nameB = "Valerie Coopfuturo - Flujo B";

  const renov = await patchOrCreateAgent(
    nameA,
    agentPayload({
      name: nameA,
      prompt: PROMPT_RENOVACION,
      firstMessage:
        "{{saludo}}, le saluda Valerie, de Coopfuturo. Esta llamada puede ser grabada con fines de calidad. ¿Hablo con {{nombre}}?",
      voiceId: voiceA,
      kb,
      tags: ["nova", "coopfuturo", "renovacion", "crediestudio", "flujo-a", "valerie", "vip-2026"]
    }),
    {
      preferredId: process.env.ELEVENLABS_AGENT_ID?.trim() || process.env.DEMO_AGENT_ID?.trim() || "",
      legacyNames: ["NOVA Renovacion Coopfuturo"]
    }
  );

  const react = await patchOrCreateAgent(
    nameB,
    agentPayload({
      name: nameB,
      prompt: PROMPT_REACTIVACION,
      firstMessage:
        "{{saludo}}, le saluda Valerie, de Coopfuturo. Esta llamada puede ser grabada con fines de calidad. ¿Hablo con {{nombre}}?",
      voiceId: voiceB,
      kb,
      tags: ["nova", "coopfuturo", "reactivacion", "crediestudio", "flujo-b", "valerie"]
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
  console.log(`KB_ATTACHED=${kb ? kb.id : "none"}`);

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
