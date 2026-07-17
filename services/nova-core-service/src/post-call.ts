/**
 * Post-call intent inference ported from coopfuturo pilot_core/modules/post_call/service.py
 */

const CONTINUE = new Set([
  "interesado",
  "renovar",
  "continuar",
  "si",
  "sí",
  "yes",
  "true",
  "1",
  "qualified",
  "lead_qualified",
  "quiere_renovar",
  "follow_up",
  "follow_up_whatsapp",
  "pedir_whatsapp",
  "whatsapp",
  "whatsapp_followup",
  "enviar_whatsapp",
  "documento",
  "enviar_documento",
  "doc_solicitado",
  "success_interested",
  "reactivar",
  "reactivacion",
  "quiere_reactivar",
  "retomar",
  "retoma_estudios"
]);

const STOP = new Set([
  "no_interes",
  "no_interest",
  "no",
  "false",
  "0",
  "opt_out",
  "optout",
  "voicemail",
  "amd",
  "no_answer",
  "busy",
  "failed",
  "hangup",
  "rechazo",
  "no_contesta"
]);

const SUMMARY_CONTINUE =
  /\b(interesad[oa]|quiere renovar|desea renovar|acept[oa]|continuar|reactivar|reactivaci[oó]n|retomar|retoma|quiere reactivar|enviar (el )?documento|orden de matr[ií]cula|cupo preaprobado|whats?\s*app|m[aá]ndeme|env[ií](e|ame)|por whatsapp|pdf de (la )?matr[ií]cula)\b/i;

const SUMMARY_STOP =
  /\b(no le interesa|no interesa|no desea|rechaz|opt[- ]?out|buz[oó]n|no contest|colg[oó]|voicemail)\b/i;

const TRANSCRIPT_WHATSAPP =
  /\b(whats?\s*app|m[aá]ndeme.{0,40}whats|env[ií].{0,40}whats|por\s+wsp|por\s+wa\b|matr[ií]cula.{0,30}whats|whats.{0,30}matr[ií]cula)\b/i;

/** Unwrap ElevenLabs data_collection `{ value: "..." }` or plain scalars. */
export function coerceAnalysisValue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    const text = String(raw).trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["value", "result", "answer", "selected"]) {
      const nested = coerceAnalysisValue(obj[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function normalizeIntent(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const value = raw.trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
  const aliases: Record<string, string> = {
    interested: "interesado",
    interest: "interesado",
    renew: "renovar",
    renewal: "renovar",
    continue: "continuar",
    sí: "si",
    no_interesado: "no_interes",
    not_interested: "no_interes",
    machine: "voicemail",
    answering_machine: "voicemail",
    reactivation: "reactivar",
    reactivar_credito: "reactivar",
    wa: "pedir_whatsapp",
    wsp: "pedir_whatsapp",
    send_whatsapp: "pedir_whatsapp",
    whatsapp_request: "pedir_whatsapp",
    whatsapp_followup: "pedir_whatsapp",
    enviar_wa: "pedir_whatsapp",
    quiere_whatsapp: "pedir_whatsapp",
    contactar_whatsapp: "pedir_whatsapp"
  };
  return aliases[value] ?? value;
}

export function intentWantsWhatsapp(intent: string): boolean {
  const normalized = normalizeIntent(intent);
  if (STOP.has(normalized)) return false;
  return CONTINUE.has(normalized);
}

export function intentIsStop(intent: string): boolean {
  return STOP.has(normalizeIntent(intent));
}

export function inferIntentFromPayload(payload: {
  intent?: string | null;
  disposition?: string | null;
  result_code?: string | null;
  amd_label?: string | null;
  transcript_excerpt?: string | null;
  analysis?: Record<string, unknown> | null;
}): string {
  if (payload.amd_label && /voicemail|machine|amd/i.test(payload.amd_label)) {
    return "voicemail";
  }

  const explicit = normalizeIntent(payload.intent ?? payload.disposition ?? undefined);
  if (explicit !== "unknown") return explicit;

  const analysis = payload.analysis ?? {};
  const dataCollection = (analysis.data_collection_results as Record<string, unknown> | undefined) ?? {};
  for (const key of [
    "intencion",
    "intent",
    "disposition",
    "quiere_renovar",
    "pedir_whatsapp",
    "enviar_whatsapp",
    "quiere_whatsapp"
  ]) {
    const value = coerceAnalysisValue(dataCollection[key]);
    if (value) return normalizeIntent(value);
  }

  const transcript = payload.transcript_excerpt ?? "";
  if (TRANSCRIPT_WHATSAPP.test(transcript)) return "pedir_whatsapp";
  if (SUMMARY_STOP.test(transcript)) return "no_interes";
  if (SUMMARY_CONTINUE.test(transcript)) return "interesado";

  const result = normalizeIntent(payload.result_code ?? undefined);
  if (result === "failed" || result === "no_answer" || result === "busy") return result;

  if (analysis.call_successful === false || analysis.call_successful === "failure") {
    return "failed";
  }

  return "unknown";
}

export type CrmStage =
  "pendiente" | "contactado" | "interesado" | "documento" | "transferido" | "renovado" | "no_interes";

const CRM_TRANSITIONS: Record<CrmStage, CrmStage[]> = {
  pendiente: ["contactado", "no_interes"],
  contactado: ["interesado", "pendiente", "no_interes"],
  interesado: ["documento", "contactado", "no_interes"],
  documento: ["transferido", "interesado", "no_interes"],
  transferido: ["renovado", "documento", "no_interes"],
  renovado: [],
  no_interes: ["pendiente"]
};

export function canTransitionCrm(from: CrmStage, to: CrmStage): boolean {
  if (from === to) return true;
  return CRM_TRANSITIONS[from]?.includes(to) ?? false;
}

export function stageFromPostCallIntent(intent: string): {
  stage: CrmStage;
  tipification?: string;
  wantsWhatsapp: boolean;
} {
  const normalized = normalizeIntent(intent);
  if (intentWantsWhatsapp(normalized)) {
    return { stage: "interesado", tipification: normalized, wantsWhatsapp: true };
  }
  if (intentIsStop(normalized) && !["voicemail", "amd", "busy", "no_answer"].includes(normalized)) {
    return { stage: "no_interes", tipification: normalized, wantsWhatsapp: false };
  }
  return { stage: "contactado", tipification: normalized === "unknown" ? undefined : normalized, wantsWhatsapp: false };
}
