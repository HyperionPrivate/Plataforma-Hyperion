import { novaAgencyTagByCode, novaCatalog } from "@hyperion/contracts";
import { randomUUID } from "node:crypto";

const EVENT_ALIASES: Record<string, string> = {
  documento: "document_received",
  document: "document_received",
  doc_received: "document_received",
  prequal: "prequal_completed",
  precalificacion: "prequal_completed",
  handoff: "handoff_requested",
  asesor: "handoff_requested",
  transfer: "handoff_requested",
  nps: "csat",
  satisfaction: "csat",
  optout: "opt_out",
  baja: "opt_out",
  tipify: "tipificacion",
  tipificacion: "tipificacion",
  message: "message",
  mensaje: "message",
  text: "message",
  chat: "message"
};

const CITY_TAG: Record<string, string> = {
  barranquilla: "AG_BARRANQUILLA",
  bucaramanga: "AG_BUCARAMANGA",
  cucuta: "AG_CUCUTA",
  floridablanca: "AG_FLORIDABLANCA",
  piedecuesta: "AG_PIEDECUESTA",
  "san gil": "AG_SAN GIL",
  sangil: "AG_SAN GIL",
  barrancabermeja: "AG_BARRANCABERMEJA",
  valledupar: "AG_VALLEDUPAR",
  villavicencio: "AG_VILLAVICENCIO",
  bogota: "AG_BUCARAMANGA",
  "bogota d.c.": "AG_BUCARAMANGA",
  "bogota dc": "AG_BUCARAMANGA"
};

export type NormalizedLiwaEventKind =
  | "document_received"
  | "prequal_completed"
  | "handoff_requested"
  | "csat"
  | "opt_out"
  | "tipificacion"
  | "message"
  | "unknown";

export interface NormalizedLiwaPayload {
  event: NormalizedLiwaEventKind | string;
  phone: string;
  contactId?: string;
  externalId: string;
  tenantIdHint?: string;
  ciudad?: string;
  agencia?: string;
  agencyTag?: string;
  agencyCode?: string;
  documentUrl?: string;
  filename: string;
  kind: string;
  score?: number;
  tipificacion?: string;
  name: string;
  motivo: string;
  /** Free-text / last user message when LIWA sends event=message. */
  text?: string;
  fields: Record<string, unknown>;
}

/** Colombian-friendly E.164 normalize (aligned with nova-core / piloto). */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let candidate = raw.trim().replace(/[\s()-]/g, "");
  if (!candidate) return null;
  if (!candidate.startsWith("+")) {
    if (candidate.startsWith("00")) candidate = `+${candidate.slice(2)}`;
    else if (candidate.startsWith("57") && candidate.length >= 12) candidate = `+${candidate}`;
    else if (/^3\d{9}$/.test(candidate)) candidate = `+57${candidate}`;
    else if (candidate.startsWith("0") && candidate.length >= 10) candidate = `+57${candidate.slice(1)}`;
    else return null;
  }
  candidate = `+${candidate.slice(1).replace(/\D/g, "")}`;
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}

function fold(text: string): string {
  return text.trim().toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ");
}

export function resolveAgencyFromGeo(input: {
  ciudad?: string | null;
  agencia?: string | null;
  fallbackTag?: string;
}): { tag: string; code: string; source: string } {
  const fallbackTag = input.fallbackTag ?? "AG_BUCARAMANGA";
  const agencyKey = fold(input.agencia ?? "");
  const cityKey = fold(input.ciudad ?? "");

  if (agencyKey.startsWith("ag_")) {
    const tag = (input.agencia ?? fallbackTag).trim().toUpperCase().replace(/\s+/g, " ");
    return { tag, code: codeFromTag(tag) ?? "BGA", source: "agencia_tag" };
  }

  for (const [key, tag] of Object.entries(CITY_TAG)) {
    if (agencyKey && agencyKey.includes(key)) {
      return { tag, code: codeFromTag(tag) ?? "BGA", source: "agencia" };
    }
  }

  if (cityKey && CITY_TAG[cityKey]) {
    const tag = CITY_TAG[cityKey]!;
    return { tag, code: codeFromTag(tag) ?? "BGA", source: "ciudad" };
  }

  for (const [key, tag] of Object.entries(CITY_TAG)) {
    if (cityKey.includes(key)) {
      return { tag, code: codeFromTag(tag) ?? "BGA", source: "ciudad_partial" };
    }
  }

  // Explicit agency code like BGA / BAQ
  const upperAgency = (input.agencia ?? "").trim().toUpperCase();
  if (upperAgency in novaAgencyTagByCode) {
    const tag = novaAgencyTagByCode[upperAgency as keyof typeof novaAgencyTagByCode];
    return { tag, code: upperAgency, source: "agency_code" };
  }

  return {
    tag: fallbackTag,
    code: codeFromTag(fallbackTag) ?? "BGA",
    source: input.ciudad || input.agencia ? "fallback_unmatched" : "fallback_empty"
  };
}

function codeFromTag(tag: string): string | undefined {
  const found = novaCatalog.agencies.find((agency) => agency.tag === tag);
  return found?.code;
}

export function normalizeLiwaPayload(raw: Record<string, unknown>): NormalizedLiwaPayload {
  const nested = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : undefined;
  const body = nested && !raw.event && !raw.type ? { ...raw, ...nested } : raw;

  // LIWA Tools → Webhooks native shape: { user, tag? } without top-level event.
  const userObj = body.user && typeof body.user === "object" ? (body.user as Record<string, unknown>) : {};
  const tagObj = body.tag && typeof body.tag === "object" ? (body.tag as Record<string, unknown>) : {};
  const tagName = String(tagObj.name ?? body.tag_name ?? "").trim();

  let event = String(body.event ?? body.type ?? body.event_type ?? body.action ?? "")
    .trim()
    .toLowerCase();
  event = EVENT_ALIASES[event] ?? event;

  if (!event || event === "unknown") {
    const inferred = inferToolsWebhookEvent(body, userObj, tagName);
    if (inferred) event = inferred;
  }

  const contactObj = body.contact && typeof body.contact === "object" ? (body.contact as Record<string, unknown>) : {};
  const fields = body.fields && typeof body.fields === "object" ? (body.fields as Record<string, unknown>) : {};

  const phoneRaw = String(
    body.phone ??
      body.telefono ??
      body.msisdn ??
      body.from ??
      body.wa_id ??
      body.sender ??
      contactObj.phone ??
      contactObj.telefono ??
      userObj.phone ??
      userObj.from ??
      ""
  ).trim();
  const phone = normalizePhoneE164(phoneRaw) ?? phoneRaw;

  const contactIdRaw = body.contact_id ?? body.user_id ?? contactObj.id ?? userObj.id;
  const contactId =
    contactIdRaw !== undefined && contactIdRaw !== null && String(contactIdRaw).trim() !== ""
      ? String(contactIdRaw).trim()
      : undefined;

  const ciudad = String(body.ciudad ?? body.city ?? fields.ciudad ?? fields.city ?? "").trim() || undefined;
  const agencia = String(body.agencia ?? fields.agencia ?? "").trim() || undefined;
  const geo = resolveAgencyFromGeo({ ciudad, agencia });

  let score: number | undefined;
  const scoreRaw = body.score ?? body.csat ?? body.rating;
  if (scoreRaw !== undefined && scoreRaw !== null && String(scoreRaw).trim() !== "") {
    const parsed = Number(scoreRaw);
    if (Number.isFinite(parsed)) score = parsed;
  }

  const name = String(
    body.name ??
      body.first_name ??
      userObj.full_name ??
      userObj.first_name ??
      fields.nombre ??
      fields.name ??
      "Asociado"
  ).trim();

  const textRaw = String(
    body.text ?? body.message ?? body.body ?? body.last_message ?? fields.text ?? fields.message ?? ""
  ).trim();
  const text = textRaw.length > 0 ? textRaw.slice(0, 4000) : undefined;

  let tipificacion = String(body.tipificacion ?? body.disposition ?? "").trim() || undefined;
  if (!tipificacion && event === "tipificacion" && tagName) {
    tipificacion = fold(tagName).replace(/\s+/g, "_");
  }

  const tagId = String(tagObj.id ?? "").trim();
  const tagExternalId = tagId && contactId ? `liwa-tag:${contactId}:${tagId}:${Date.now()}` : randomUUID();
  const externalId = String(body.external_id ?? body.message_id ?? body.id ?? body.uuid ?? tagExternalId).trim();

  return {
    event: (event || "unknown") as NormalizedLiwaEventKind,
    phone,
    contactId,
    externalId,
    tenantIdHint: String(body.tenant_id ?? "").trim() || undefined,
    ciudad,
    agencia,
    agencyTag: geo.tag,
    agencyCode: geo.code,
    documentUrl:
      typeof body.document_url === "string"
        ? body.document_url
        : typeof body.url === "string"
          ? body.url
          : typeof fields.document_url === "string"
            ? fields.document_url
            : undefined,
    filename: String(body.filename ?? fields.filename ?? "documento_liwa.pdf"),
    kind: String(body.kind ?? fields.kind ?? "orden_matricula"),
    score,
    tipificacion,
    name,
    text,
    motivo: String(body.motivo ?? body.reason ?? (tagName ? `Tag LIWA: ${tagName}` : "Handoff desde flujo LIWA")),
    fields: Object.fromEntries(
      Object.entries({
        cedula: body.cedula ?? fields.cedula,
        direccion: body.direccion ?? fields.direccion,
        universidad: body.universidad ?? fields.universidad,
        programa: body.programa ?? fields.programa,
        liwa_tag: tagName || undefined,
        liwa_page_id: userObj.page_id ?? userObj.account_id,
        ...fields
      }).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    )
  };
}

/** Infer canonical event from LIWA Tools webhook payloads that omit `event`. */
function inferToolsWebhookEvent(
  body: Record<string, unknown>,
  userObj: Record<string, unknown>,
  tagName: string
): string | undefined {
  const trigger = fold(String(body.trigger ?? body.webhook_trigger ?? body.hook_name ?? body.name ?? ""));

  if (
    trigger.includes("unsubscrib") ||
    trigger.includes("opt_out") ||
    trigger.includes("opt-out") ||
    body.unsubscribed === true ||
    String(userObj.subscribed ?? "") === "0"
  ) {
    // Only treat subscribed=0 as opt_out when this looks like an unsubscribe hook,
    // not every tag payload that happens to include subscribed.
    if (
      trigger.includes("unsubscrib") ||
      trigger.includes("opt") ||
      body.unsubscribed === true ||
      (!tagName && Object.keys(userObj).length > 0 && String(userObj.subscribed ?? "") === "0")
    ) {
      return "opt_out";
    }
  }

  if (
    trigger.includes("transfer") ||
    trigger.includes("human") ||
    trigger.includes("live_chat") ||
    trigger.includes("handoff") ||
    body.transferred_to_human === true ||
    body.live_chat === true
  ) {
    return "handoff_requested";
  }

  if (tagName) {
    const folded = fold(tagName);
    if (folded.includes("renovacion_vip") || folded.includes("reactivacion_vip") || folded.endsWith("_vip")) {
      return "tipificacion";
    }
    return "tipificacion";
  }

  return undefined;
}

export function mapEventKind(event: string): NormalizedLiwaEventKind {
  if (event === "document_received" || event.includes("document")) return "document_received";
  if (event === "prequal_completed" || event.includes("prequal")) return "prequal_completed";
  if (event === "handoff_requested" || event.includes("handoff") || event.includes("asesor")) {
    return "handoff_requested";
  }
  if (event === "csat" || event.includes("csat") || event === "nps") return "csat";
  if (event === "opt_out" || event.includes("opt")) return "opt_out";
  if (event === "tipificacion" || event.includes("tipif")) return "tipificacion";
  if (event === "message" || event.includes("mensaje") || event === "chat") return "message";
  return "unknown";
}
