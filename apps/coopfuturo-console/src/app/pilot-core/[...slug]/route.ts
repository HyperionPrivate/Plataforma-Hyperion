import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Backend-for-frontend that keeps the CoopFuturo (PULSO) UI contract
 * (`/pilot-core/ops/*`) intact while translating every live call to the Hyperion
 * api-gateway. Running server-side avoids CORS and never exposes internal URLs.
 *
 * All reads are wired to real NOVA data (no bundled sample datasets). The
 * Laboratorio dispatch places a real voice call; the post-call WhatsApp is then
 * emitted automatically by nova-core when the call completes with positive intent.
 */

export const dynamic = "force-dynamic";

const GATEWAY = (process.env.HYPERION_GATEWAY_URL ?? "http://api-gateway:8080").replace(/\/$/, "");
const TENANT_ENV = (process.env.COOPFUTURO_TENANT_ID ?? "").trim();
const LIWA_DEFAULT_FLOW = (
  process.env.COOPFUTURO_LIWA_FLOW_ID?.trim() ||
  process.env.LIWA_DEFAULT_FLOW_ID?.trim() ||
  "1784249919201"
);

function bearer(req: NextRequest): string {
  const header = req.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

type GwResult = { ok: boolean; status: number; data: unknown };

async function gw(path: string, token: string, init?: RequestInit): Promise<GwResult> {
  try {
    const res = await fetch(`${GATEWAY}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const data =
      body && typeof body === "object" && "data" in (body as Record<string, unknown>)
        ? (body as Record<string, unknown>).data
        : body;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 502, data: null };
  }
}

async function resolveTenant(token: string): Promise<string> {
  if (TENANT_ENV) return TENANT_ENV;
  const me = await gw("/v1/auth/me", token);
  const ids = (me.data as { tenantIds?: string[] } | null)?.tenantIds;
  return Array.isArray(ids) && ids[0] ? ids[0] : "";
}

async function resolveOperatorId(token: string): Promise<string | null> {
  const me = await gw("/v1/auth/me", token);
  const id = (me.data as { operator?: { id?: string } } | null)?.operator?.id;
  return typeof id === "string" && id ? id : null;
}

function hhmm(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Best-effort E.164 for Colombian mobiles when the UI sends a bare number. */
function normalizePhone(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.startsWith("+")) return value.replace(/[^\d+]/g, "");
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+57${digits}`;
  if (digits.length === 12 && digits.startsWith("57")) return `+${digits}`;
  return `+${digits}`;
}

type NovaContact = {
  contact_id: string;
  phone_e164: string | null;
  full_name: string | null;
  agency_code: string | null;
  universidad?: string | null;
  ciudad?: string | null;
  segmento?: string | null;
  segment?: string | null;
};

function spokenFirstName(raw?: string | null): string {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleaned) return "Asociado";
  const parts = cleaned.split(" ").slice(0, 2);
  return parts
    .map((p) => p.charAt(0).toLocaleUpperCase("es-CO") + p.slice(1).toLocaleLowerCase("es-CO"))
    .join(" ");
}

async function contactMap(token: string, tenant: string): Promise<Map<string, NovaContact>> {
  const res = await gw(`/v1/tenants/${tenant}/nova/contacts?limit=200`, token);
  const items = ((res.data as { items?: NovaContact[] } | null)?.items ?? []) as NovaContact[];
  return new Map(items.map((c) => [c.contact_id, c]));
}

// ---------------------------------------------------------------------------
// Conversations (live chat espejo)
// ---------------------------------------------------------------------------

type NovaConversation = {
  conversation_id: string;
  contact_id: string;
  channel: string | null;
  agency_code: string | null;
  status: string | null;
  claimed_by: string | null;
  last_message_at: string | null;
};

type NovaMessage = {
  message_id: string;
  direction: "inbound" | "outbound";
  body: string;
  kind: "text" | "document" | "system";
  external_id: string | null;
  created_at: string;
};

/** Advisor replies use `reply:`; bot/flow/lab outbound use liwa-bot / wa-sent / liwa-out / lab-. */
function messageSourceFromExternalId(externalId: string | null | undefined): "advisor" | "bot" {
  const id = String(externalId ?? "");
  if (id.startsWith("reply:")) return "advisor";
  return "bot";
}

/** Hide residual Lab/smoke bodies so Conversaciones stays demo-ready. */
function isSmokeConversationBody(body: string): boolean {
  const text = String(body ?? "").trim();
  if (!text) return true;
  if (/\{\{[a-z_]+\}\}/i.test(text)) return true;
  if (/espejo/i.test(text)) return true;
  if (/\bsmoke\b/i.test(text)) return true;
  if (/hola desde lab/i.test(text)) return true;
  if (/texto exacto/i.test(text)) return true;
  if (/reply asesor/i.test(text)) return true;
  if (/^flujo\s+.+\s+enviado$/i.test(text)) return true;
  if (/^flujo whatsapp enviado$/i.test(text)) return true;
  if (/^flujo liwa enviado$/i.test(text)) return true;
  return false;
}

async function buildConversations(token: string, tenant: string): Promise<NextResponse> {
  const base = `/v1/tenants/${tenant}/nova`;
  const [listRes, contacts] = await Promise.all([gw(`${base}/conversations`, token), contactMap(token, tenant)]);
  if (!listRes.ok) return NextResponse.json({ activeCount: 0, conversations: [], pii_masked: false });

  const rows = (Array.isArray(listRes.data) ? listRes.data : []) as NovaConversation[];
  const enriched = (
    await Promise.all(
      rows.slice(0, 60).map(async (row) => {
        const msgRes = await gw(`${base}/conversations/${row.conversation_id}/messages`, token);
        const rawMessages = (Array.isArray(msgRes.data) ? msgRes.data : []) as NovaMessage[];
        const messages = rawMessages.filter((m) => !isSmokeConversationBody(m.body));
        if (!messages.length) return null;
        const contact = contacts.get(row.contact_id);
        const last = messages[messages.length - 1];
        const status = row.status ?? "open";
        return {
          id: row.conversation_id,
          name: contact?.full_name || contact?.phone_e164 || "Asociado",
          phone: contact?.phone_e164 ?? undefined,
          contact_id: row.contact_id,
          topic: (row.channel ?? "whatsapp") === "voz" ? "Voz" : "WhatsApp",
          snippet: last?.body ?? "Sin mensajes todavía",
          channel: (row.channel ?? "whatsapp") === "voz" ? "voz" : "whatsapp",
          sentiment: "neutral",
          time: hhmm(row.last_message_at ?? last?.created_at),
          tags: status === "claimed" ? ["En atención"] : ["Abierta"],
          botActive: status === "open",
          botPaused: status !== "open",
          claimedBy: row.claimed_by ?? undefined,
          messages: messages.map((m) => ({
            id: m.message_id,
            role: m.direction === "inbound" ? "user" : "bot",
            source: m.direction === "outbound" ? messageSourceFromExternalId(m.external_id) : undefined,
            text: m.body,
            at: hhmm(m.created_at),
          })),
        };
      }),
    )
  ).filter((row): row is NonNullable<typeof row> => row != null);

  return NextResponse.json({
    activeCount: enriched.length,
    conversations: enriched,
    pii_masked: false,
  });
}

// ---------------------------------------------------------------------------
// Overview reads (real NOVA data, no sample fallback)
// ---------------------------------------------------------------------------

type AnalyticsDay = {
  day: string;
  channel?: string | null;
  contacts_imported?: number;
  calls_requested?: number;
  calls_completed?: number;
  calls_failed?: number;
  wa_sent?: number;
  leads_contacted?: number;
  leads_interested?: number;
  leads_won?: number;
  leads_lost?: number;
  handoffs_queued?: number;
};

function formatDayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}

function formatOpsNumber(n: number): string {
  return new Intl.NumberFormat("es-CO").format(Math.max(0, Math.trunc(n)));
}

async function buildDashboard(token: string, tenant: string): Promise<NextResponse> {
  const [dashRes, analyticsRes, leadsRes, convRes, contacts] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/dashboard`, token),
    gw(`/v1/tenants/${tenant}/nova/analytics/daily`, token),
    gw(`/v1/tenants/${tenant}/nova/leads`, token),
    gw(`/v1/tenants/${tenant}/nova/conversations`, token),
    contactMap(token, tenant),
  ]);

  const d = (dashRes.data as Record<string, number> | null) ?? {};
  const analytics = (Array.isArray(analyticsRes.data) ? analyticsRes.data : []) as AnalyticsDay[];
  const leads = (Array.isArray(leadsRes.data) ? leadsRes.data : []) as Array<Record<string, unknown>>;
  const conversations = (Array.isArray(convRes.data) ? convRes.data : []) as Array<Record<string, unknown>>;

  const byDay = new Map<string, { voz: number; whatsapp: number }>();
  let callsRequested = 0;
  let callsCompleted = 0;
  let callsFailed = 0;
  let waSent = 0;
  for (const row of analytics) {
    const day = String(row.day ?? "").slice(0, 10);
    if (!day) continue;
    const bucket = byDay.get(day) ?? { voz: 0, whatsapp: 0 };
    const completed = Number(row.calls_completed ?? 0);
    const requested = Number(row.calls_requested ?? 0);
    const failed = Number(row.calls_failed ?? 0);
    const wa = Number(row.wa_sent ?? 0);
    bucket.voz += completed || requested;
    bucket.whatsapp += wa;
    byDay.set(day, bucket);
    callsRequested += requested;
    callsCompleted += completed;
    callsFailed += failed;
    waSent += wa;
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const today = byDay.get(todayKey) ?? { voz: 0, whatsapp: 0 };
  const todayRow = analytics.find((r) => String(r.day ?? "").slice(0, 10) === todayKey);
  const todayRequested = Number(todayRow?.calls_requested ?? today.voz);
  const todayCompleted = Number(todayRow?.calls_completed ?? 0);
  const todayFailed = Number(todayRow?.calls_failed ?? 0);
  const todayWa = Number(todayRow?.wa_sent ?? today.whatsapp);
  const connectionRate =
    todayRequested > 0 ? Math.round((todayCompleted / todayRequested) * 100) : todayCompleted > 0 ? 100 : 0;

  const contactsByDay = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-14)
    .map(([day, v]) => ({ date: formatDayLabel(day), voz: v.voz, whatsapp: v.whatsapp }));

  const funnelKeys = ["contactado", "interesado", "documento", "transferido", "renovado"] as const;
  const funnelCounts = Object.fromEntries(funnelKeys.map((k) => [k, 0])) as Record<(typeof funnelKeys)[number], number>;
  const statusCounts = {
    contactados: 0,
    no_contactados: 0,
    no_disponibles: 0,
    rechazados: 0,
    otros: 0,
  };
  for (const lead of leads) {
    const stage = String(lead.stage ?? "pendiente");
    if (stage in funnelCounts) funnelCounts[stage as (typeof funnelKeys)[number]] += 1;
    if (stage === "pendiente") statusCounts.no_contactados += 1;
    else if (stage === "no_interes") statusCounts.rechazados += 1;
    else if (["contactado", "interesado", "documento", "transferido", "renovado"].includes(stage)) {
      statusCounts.contactados += 1;
    } else statusCounts.otros += 1;
  }
  const funnelTop = Math.max(funnelCounts.contactado, leads.length, 1);
  const funnelRenovacion = funnelKeys.map((key) => ({
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1).replace("_", " "),
    count: funnelCounts[key],
    pct: Math.round((funnelCounts[key] / funnelTop) * 1000) / 10,
  }));
  const statusTotal = Math.max(
    statusCounts.contactados +
      statusCounts.no_contactados +
      statusCounts.no_disponibles +
      statusCounts.rechazados +
      statusCounts.otros,
    1,
  );
  const baseStatus = [
    { key: "contactados", label: "Contactados", count: statusCounts.contactados, pct: Math.round((statusCounts.contactados / statusTotal) * 1000) / 10, color: "success" },
    { key: "no_contactados", label: "No contactados", count: statusCounts.no_contactados, pct: Math.round((statusCounts.no_contactados / statusTotal) * 1000) / 10, color: "muted" },
    { key: "no_disponibles", label: "No disponibles", count: statusCounts.no_disponibles, pct: Math.round((statusCounts.no_disponibles / statusTotal) * 1000) / 10, color: "warning" },
    { key: "rechazados", label: "Rechazados", count: statusCounts.rechazados, pct: Math.round((statusCounts.rechazados / statusTotal) * 1000) / 10, color: "danger" },
    { key: "otros", label: "Otros", count: statusCounts.otros, pct: Math.round((statusCounts.otros / statusTotal) * 1000) / 10, color: "info" },
  ];

  const liveEvents = conversations
    .slice(0, 12)
    .map((c, idx) => {
      const contact = contacts.get(String(c.contact_id ?? ""));
      const channel = String(c.channel ?? "whatsapp").includes("voice") || String(c.channel ?? "").includes("voz")
        ? "voz"
        : "whatsapp";
      return {
        id: String(c.conversation_id ?? idx),
        channel,
        personName: contact?.full_name || contact?.phone_e164 || "Contacto",
        kind: String(c.status ?? "open") === "claimed" ? "Conversación claimed" : "Conversación abierta",
        at: hhmm(c.last_message_at) || hhmm(new Date().toISOString()),
      };
    });

  const kpi = (id: string, label: string, value: number, unit = "") => ({
    id,
    label,
    value: Number(value ?? 0),
    unit,
    delta: 0,
    deltaUnit: "",
    sparkline: [] as number[],
  });

  return NextResponse.json({
    kpis: [
      kpi("contactos", "Contactos", d.contacts ?? 0),
      kpi("llamadas_hoy", "Llamadas hoy", todayRequested || todayCompleted),
      kpi("wa_hoy", "WhatsApp hoy", todayWa),
      kpi("leads", "Leads", d.leads ?? leads.length),
      kpi("conversaciones", "Conversaciones abiertas", d.openConversations ?? conversations.length),
      kpi("handoffs", "Handoffs en cola", d.handoffsQueued ?? 0),
    ],
    contactsByDay,
    funnelRenovacion,
    baseStatus,
    ops: [
      { id: "llamadas", label: "Llamadas realizadas", value: formatOpsNumber(callsCompleted || callsRequested) },
      { id: "wa", label: "WhatsApps enviados", value: formatOpsNumber(waSent) },
      { id: "conexion", label: "Tasa de conexión voz", value: `${connectionRate}%` },
      { id: "fallidas", label: "Llamadas fallidas", value: formatOpsNumber(callsFailed || todayFailed) },
      { id: "solicitadas", label: "Llamadas solicitadas", value: formatOpsNumber(callsRequested) },
      { id: "campanas", label: "Campañas", value: formatOpsNumber(d.campaigns ?? 0) },
    ],
    liveEvents,
  });
}

async function buildCampaigns(token: string, tenant: string): Promise<NextResponse> {
  const base = `/v1/tenants/${tenant}/nova`;
  const [campaignsRes, analyticsRes, complianceRes] = await Promise.all([
    gw(`${base}/campaigns`, token),
    gw(`${base}/analytics/daily`, token),
    gw(`${base}/compliance/settings`, token),
  ]);

  const rows = (Array.isArray(campaignsRes.data) ? campaignsRes.data : []) as Array<Record<string, unknown>>;
  const analytics = (Array.isArray(analyticsRes.data) ? analyticsRes.data : []) as AnalyticsDay[];
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayRows = analytics.filter((r) => String(r.day ?? "").slice(0, 10) === todayKey);
  const llamadasCompleted = todayRows.reduce((sum, r) => sum + Number(r.calls_completed ?? 0), 0);
  const llamadasRequested = todayRows.reduce((sum, r) => sum + Number(r.calls_requested ?? 0), 0);
  const whatsappHoy = todayRows.reduce((sum, r) => sum + Number(r.wa_sent ?? 0), 0);

  const compliance = (complianceRes.data as Record<string, unknown> | null) ?? {};
  const startHour = Number(compliance.window_start_hour ?? 8);
  const endHour = Number(compliance.window_end_hour ?? 20);
  const pad = (n: number) => String(Number.isFinite(n) ? n : 0).padStart(2, "0");
  const ventana = `${pad(startHour)}–${pad(endHour)} COT`;

  const campaigns = rows.map((c) => {
    const total = Number(c.total ?? 0);
    const contacted = Number(c.reached ?? 0);
    const converted = Number(c.converted ?? 0);
    const conversion = total > 0 ? Math.round((converted / total) * 100) : 0;
    return {
      id: String(c.campaign_id ?? ""),
      name: String(c.name ?? "Campaña"),
      segment: String(c.product_flow ?? ""),
      channels: c.channel ? [String(c.channel)] : [],
      continuous: false,
      contacted,
      total,
      conversion,
      status: String(c.status ?? "draft"),
    };
  });

  return NextResponse.json({
    dayChips: {
      llamadasHoy: llamadasCompleted || llamadasRequested,
      whatsappHoy,
      reintentos: 0,
      ventana,
    },
    campaigns,
  });
}

const CRM_COLUMNS: Array<{ id: string; label: string }> = [
  { id: "pendiente", label: "Pendiente" },
  { id: "contactado", label: "Contactado" },
  { id: "interesado", label: "Interesado" },
  { id: "documento", label: "Documento" },
  { id: "transferido", label: "Transferido" },
  { id: "renovado", label: "Renovado" },
  { id: "no_interes", label: "No interés" },
];

/** Mirrors nova-core CRM_TRANSITIONS (post-call.ts). */
const CRM_ALLOWED_NEXT: Record<string, string[]> = {
  pendiente: ["contactado", "no_interes"],
  contactado: ["interesado", "pendiente", "no_interes"],
  interesado: ["documento", "contactado", "no_interes"],
  documento: ["transferido", "interesado", "no_interes"],
  transferido: ["renovado", "documento", "no_interes"],
  renovado: [],
  no_interes: ["pendiente"],
};

function normalizeProductLine(raw: unknown): string {
  const value = String(raw ?? "renovacion")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  if (value.includes("react")) return "reactivacion";
  if (value.includes("nuevo")) return "nuevos";
  if (value.includes("micro")) return "microcredito";
  return "renovacion";
}

function productLineFromSegment(raw: unknown): string {
  return normalizeProductLine(raw);
}

const CRM_STAGE_RANK: Record<string, number> = {
  pendiente: 0,
  contactado: 1,
  interesado: 2,
  documento: 3,
  transferido: 4,
  renovado: 5,
  no_interes: -1,
};

const TIPIFICATION_LABELS: Record<string, string> = {
  interesado: "Interesado",
  quiere_pensarlo: "Quiere pensarlo",
  no_contactar: "No contactar",
  no_interes: "No interés",
  renovar: "Renovar",
  reactivar: "Reactivar",
  voicemail: "Buzón de voz",
  unknown: "Sin tipificar",
  no_contesta: "No contesta",
  numero_errado: "Número errado",
  volver_llamar: "Volver a llamar",
  opt_out: "Opt-out",
};

function tipificationLabel(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (!key) return raw;
  if (TIPIFICATION_LABELS[key]) return TIPIFICATION_LABELS[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function dedupeLeadsByContact(leads: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byContact = new Map<string, Record<string, unknown>>();
  for (const lead of leads) {
    const contactId = String(lead.contact_id ?? "").trim();
    if (!contactId) continue;
    const prev = byContact.get(contactId);
    if (!prev) {
      byContact.set(contactId, lead);
      continue;
    }
    const prevStage = String(prev.stage ?? "pendiente");
    const nextStage = String(lead.stage ?? "pendiente");
    const prevRank = CRM_STAGE_RANK[prevStage] ?? -2;
    const nextRank = CRM_STAGE_RANK[nextStage] ?? -2;
    const prevUpdated = Date.parse(String(prev.updated_at ?? "")) || 0;
    const nextUpdated = Date.parse(String(lead.updated_at ?? "")) || 0;
    if (nextRank > prevRank || (nextRank === prevRank && nextUpdated >= prevUpdated)) {
      byContact.set(contactId, lead);
    }
  }
  return [...byContact.values()];
}

function crmFunnelFor(
  leads: Array<Record<string, unknown>>,
  contacts: Map<string, NovaContact>,
  productLine: string,
) {
  const funnelLeads = dedupeLeadsByContact(
    leads.filter((l) => normalizeProductLine(l.product_line) === productLine),
  );
  const columns = CRM_COLUMNS.map((col) => {
    const cards = funnelLeads
      .filter((l) => String(l.stage ?? "pendiente") === col.id)
      .map((l) => {
        const contact = contacts.get(String(l.contact_id ?? ""));
        const stage = String(l.stage ?? "pendiente");
        return {
          id: String(l.lead_id ?? ""),
          name: contact?.full_name || contact?.phone_e164 || "Lead",
          universidad: "",
          score: 0,
          channel: "whatsapp",
          urgency: "",
          phone: contact?.phone_e164 ?? undefined,
          allowed_next: CRM_ALLOWED_NEXT[stage] ?? [],
        };
      });
    return { id: col.id, label: col.label, count: cards.length, cards };
  });
  const tipCounts = new Map<string, number>();
  for (const lead of funnelLeads) {
    const tip = String(lead.tipification ?? "").trim();
    if (!tip) continue;
    tipCounts.set(tip, (tipCounts.get(tip) ?? 0) + 1);
  }
  const tipificaciones = [...tipCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([key, count]) => ({ key, label: tipificationLabel(key), count }));
  return { columns, tipificaciones };
}

async function buildCrm(token: string, tenant: string): Promise<NextResponse> {
  const [leadsRes, contacts] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/leads`, token),
    contactMap(token, tenant),
  ]);
  const leads = (Array.isArray(leadsRes.data) ? leadsRes.data : []) as Array<Record<string, unknown>>;
  return NextResponse.json({
    funnels: {
      Renovación: crmFunnelFor(leads, contacts, "renovacion"),
      Reactivación: crmFunnelFor(leads, contacts, "reactivacion"),
      Nuevos: crmFunnelFor(leads, contacts, "nuevos"),
      Microcrédito: crmFunnelFor(leads, contacts, "microcredito"),
    },
  });
}

function mapReviewStatus(status: string): { tab: string; whatsapp_status: string; whatsapp_sent: boolean } {
  if (status === "pending_review") return { tab: "pending", whatsapp_status: "pending_review", whatsapp_sent: false };
  if (status === "skipped") return { tab: "skipped", whatsapp_status: "skipped", whatsapp_sent: false };
  if (status === "failed") return { tab: "failed", whatsapp_status: "failed", whatsapp_sent: false };
  // approved / sent → "sent" tab in UI
  return { tab: "sent", whatsapp_status: status === "sent" ? "sent" : "approved", whatsapp_sent: true };
}

async function buildWhatsAppPending(token: string, tenant: string): Promise<NextResponse> {
  const [reviewsRes, contacts, convRes] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/reviews`, token),
    contactMap(token, tenant),
    gw(`/v1/tenants/${tenant}/nova/conversations`, token),
  ]);
  const reviews = (Array.isArray(reviewsRes.data) ? reviewsRes.data : []) as Array<Record<string, unknown>>;
  const conversations = (Array.isArray(convRes.data) ? convRes.data : []) as Array<Record<string, unknown>>;
  const convByContact = new Map<string, string>();
  for (const c of conversations) {
    const contactId = String(c.contact_id ?? "");
    if (contactId && !convByContact.has(contactId)) {
      convByContact.set(contactId, String(c.conversation_id ?? ""));
    }
  }

  const items = reviews.map((r) => {
    const contactId = String(r.contact_id ?? "");
    const contact = contacts.get(contactId);
    const status = String(r.status ?? "pending_review");
    const mapped = mapReviewStatus(status);
    return {
      id: String(r.review_id ?? ""),
      review_id: String(r.review_id ?? ""),
      contact_id: contactId,
      phone: contact?.phone_e164 ?? undefined,
      first_name: contact?.full_name ?? undefined,
      intent: r.intent ?? undefined,
      flow_id: r.flow_id ?? LIWA_DEFAULT_FLOW,
      flow: "A",
      conversation_id: convByContact.get(contactId) ?? undefined,
      status: mapped.whatsapp_status,
      whatsapp_status: mapped.whatsapp_status,
      whatsapp_sent: mapped.whatsapp_sent,
      whatsapp: {
        message: {
          text: `Seguimiento post-llamada (${String(r.intent ?? "interesado")}) — flujo ${String(r.flow_id ?? LIWA_DEFAULT_FLOW)}`,
        },
      },
      _created_at: r.created_at ?? undefined,
    };
  });

  return NextResponse.json({ items, count: items.length, scope: "review", pii_masked: false });
}

async function buildReport(token: string, tenant: string, reportId: string): Promise<NextResponse> {
  const [dash, analyticsRes, leadsRes, handoffsRes, convRes] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/dashboard`, token),
    gw(`/v1/tenants/${tenant}/nova/analytics/daily`, token),
    gw(`/v1/tenants/${tenant}/nova/leads`, token),
    gw(`/v1/tenants/${tenant}/nova/handoffs`, token),
    gw(`/v1/tenants/${tenant}/nova/conversations`, token),
  ]);
  const d = (dash.data as Record<string, number> | null) ?? {};
  const analytics = (Array.isArray(analyticsRes.data) ? analyticsRes.data : []) as AnalyticsDay[];
  const leads = (Array.isArray(leadsRes.data) ? leadsRes.data : []) as Array<Record<string, unknown>>;
  const handoffs = (Array.isArray(handoffsRes.data) ? handoffsRes.data : []) as Array<Record<string, unknown>>;
  const conversations = (Array.isArray(convRes.data) ? convRes.data : []) as Array<Record<string, unknown>>;

  const last7 = analytics.slice(0, 7);
  const sum = (key: keyof AnalyticsDay) =>
    last7.reduce((acc, row) => acc + Number(row[key] ?? 0), 0);

  const stageCounts: Record<string, number> = {};
  const tipCounts: Record<string, number> = {};
  for (const lead of leads) {
    const stage = String(lead.stage ?? "pendiente");
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
    const tip = String(lead.tipification ?? "").trim();
    if (tip) tipCounts[tip] = (tipCounts[tip] ?? 0) + 1;
  }

  const claimed = conversations.filter((c) => String(c.status ?? "") === "claimed").length;
  const queuedHandoffs = handoffs.filter((h) => String(h.status ?? "") === "queued").length;

  const reports: Record<string, Record<string, unknown>> = {
    semanal: {
      generated_at: new Date().toISOString(),
      kpis: {
        contacts: d.contacts ?? 0,
        campaigns: d.campaigns ?? 0,
        leads: d.leads ?? leads.length,
        open_conversations: d.openConversations ?? conversations.length,
        handoffs_queued: d.handoffsQueued ?? queuedHandoffs,
      },
      last_7_days: {
        calls_requested: sum("calls_requested"),
        calls_completed: sum("calls_completed"),
        calls_failed: sum("calls_failed"),
        wa_sent: sum("wa_sent"),
        leads_contacted: sum("leads_contacted"),
        leads_interested: sum("leads_interested"),
      },
      daily: last7,
    },
    funnel: {
      generated_at: new Date().toISOString(),
      product_line: "renovacion",
      stages: CRM_COLUMNS.map((col) => ({
        stage: col.id,
        label: col.label,
        count: stageCounts[col.id] ?? 0,
      })),
      tipificaciones: tipCounts,
    },
    asesores: {
      generated_at: new Date().toISOString(),
      conversations_claimed: claimed,
      conversations_open: conversations.filter((c) => String(c.status ?? "") === "open").length,
      handoffs_queued: queuedHandoffs,
      handoffs_total: handoffs.length,
      handoffs: handoffs.slice(0, 50).map((h) => ({
        id: h.handoff_id,
        status: h.status,
        agency_code: h.agency_code,
        reason: h.reason,
        created_at: h.created_at,
      })),
    },
    cumplimiento: {
      generated_at: new Date().toISOString(),
      calls_requested: sum("calls_requested"),
      calls_completed: sum("calls_completed"),
      calls_failed: sum("calls_failed"),
      wa_sent: sum("wa_sent"),
      tipificaciones: tipCounts,
      connection_rate:
        sum("calls_requested") > 0
          ? Math.round((sum("calls_completed") / sum("calls_requested")) * 100)
          : 0,
    },
  };

  const report = reports[reportId];
  if (!report) {
    return NextResponse.json({ ok: false, error: `Reporte desconocido: ${reportId}` }, { status: 404 });
  }
  return NextResponse.json({ ok: true, format: "json", report });
}

async function buildHandoff(token: string, tenant: string): Promise<NextResponse> {
  const [res, contacts] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/handoffs`, token),
    contactMap(token, tenant),
  ]);
  const rows = (Array.isArray(res.data) ? res.data : []) as Array<Record<string, unknown>>;
  const queue = rows
    .filter((h) => ["queued", "claimed"].includes(String(h.status ?? "")))
    .map((h) => {
      const contact = contacts.get(String(h.contact_id ?? ""));
      return {
        id: String(h.handoff_id ?? ""),
        priority: "media",
        name: contact?.full_name || contact?.phone_e164 || "Asociado",
        segment: String(h.agency_code ?? ""),
        motivo: String(h.reason ?? ""),
        tiempoCola: hhmm(h.created_at),
        expedientePct: 0,
        aiSummary: "",
      };
    });
  return NextResponse.json({
    queue,
    kpis: [
      { id: "cola", label: "En cola", value: queue.length, unit: "" },
      { id: "atendidos", label: "Atendidos", value: rows.length - queue.length, unit: "" },
    ],
    byAdvisor: [],
    quality: { score: 0, label: "—", breakdown: [] },
  });
}

// ---------------------------------------------------------------------------
// Laboratorio: real call dispatch -> post-call WhatsApp is automatic in nova-core
// ---------------------------------------------------------------------------

async function findContactByPhone(
  token: string,
  tenant: string,
  phone: string,
): Promise<NovaContact | null> {
  const res = await gw(
    `/v1/tenants/${tenant}/nova/contacts?limit=5&q=${encodeURIComponent(phone)}`,
    token,
  );
  if (!res.ok) return null;
  const items = ((res.data as { items?: NovaContact[] } | null)?.items ?? []) as NovaContact[];
  const exact = items.find((c) => c.phone_e164 === phone);
  return exact ?? items[0] ?? null;
}

async function ensureContact(
  token: string,
  tenant: string,
  phone: string,
  name?: string,
  agency?: string,
): Promise<{ contactId: string | null; detail?: string }> {
  const res = await gw(`/v1/tenants/${tenant}/nova/contacts/import`, token, {
    method: "POST",
    body: JSON.stringify({
      contacts: [{ phone_e164: phone, full_name: name || undefined, agency_code: agency || undefined }],
    }),
  });
  const imported = (res.data as { imported?: Array<{ contact_id: string }> } | null)?.imported;
  const fromImport = imported?.[0]?.contact_id;
  if (fromImport) return { contactId: fromImport };

  // Import may return empty/failed (auth, validation) while the contact already exists.
  const existing = await findContactByPhone(token, tenant, phone);
  if (existing?.contact_id) return { contactId: existing.contact_id };

  const err =
    (res.data as { error?: string } | null)?.error ??
    (res.ok ? "import sin contact_id" : `import HTTP ${res.status}`);
  return { contactId: null, detail: err };
}

async function dispatchCall(
  token: string,
  tenant: string,
  input: { phone: string; name?: string; flow?: string },
): Promise<NextResponse> {
  const phone = normalizePhone(input.phone);
  if (!tenant || !phone) {
    return NextResponse.json({ ok: false, error: "Teléfono/tenant inválido" }, { status: 400 });
  }
  if (!token) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }
  const ensured = await ensureContact(token, tenant, phone, input.name);
  if (!ensured.contactId) {
    const detail = ensured.detail ?? "sin detalle";
    const unauthorized = /auth|session|expired|unauthorized/i.test(detail);
    return NextResponse.json(
      {
        ok: false,
        error: `No se pudo registrar el contacto (${detail})`,
      },
      { status: unauthorized ? 401 : 502 },
    );
  }
  const contactId = ensured.contactId;
  const contact = await findContactByPhone(token, tenant, phone);
  const nombre = spokenFirstName(input.name || contact?.full_name || "Asociado");
  const agencia = String(contact?.agency_code ?? "").trim() || "su sede";
  const universidad = String(contact?.universidad ?? "").trim() || "su universidad";
  const ciudad = String(contact?.ciudad ?? "").trim() || "su ciudad";
  const call = await gw(`/v1/tenants/${tenant}/voice/calls`, token, {
    method: "POST",
    body: JSON.stringify({
      phone_e164: phone,
      contact_id: contactId,
      dynamic_vars: {
        nombre,
        agencia,
        universidad,
        ciudad,
        product_flow: input.flow === "B" ? "reactivacion" : "renovacion",
      },
    }),
  });
  if (!call.ok) {
    const detail = (call.data as { error?: string } | null)?.error ?? `HTTP ${call.status}`;
    return NextResponse.json({ ok: false, error: `Dialer: ${detail}` }, { status: 502 });
  }
  const data = (call.data as Record<string, unknown>) ?? {};
  return NextResponse.json({
    ok: true,
    mock_commercial: false,
    dispatch: { id: data.call_id ?? contactId, ...data },
  });
}

async function sendWhatsAppLive(
  token: string,
  tenant: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const phone = normalizePhone(String(body.phone ?? ""));
  if (!tenant || !phone) {
    return NextResponse.json({ ok: false, error: "Teléfono/tenant inválido" }, { status: 400 });
  }
  const kind = String(body.kind ?? "flow") === "text" ? "text" : "flow";
  const text = String(body.text ?? "").trim();
  const flowId = String(body.flow_id ?? LIWA_DEFAULT_FLOW).trim() || LIWA_DEFAULT_FLOW;
  if (kind === "text" && !text) {
    return NextResponse.json({ ok: false, error: "text required for kind=text" }, { status: 422 });
  }
  if (kind === "flow" && !flowId) {
    return NextResponse.json({ ok: false, error: "flow_id required for kind=flow" }, { status: 422 });
  }

  const ensured = await ensureContact(
    token,
    tenant,
    phone,
    body.first_name ? String(body.first_name) : undefined,
  );

  const payload: Record<string, unknown> = {
    contact_ref: phone,
    contact_id: ensured.contactId || undefined,
    first_name: body.first_name ? String(body.first_name) : undefined,
    mode: kind,
    ...(kind === "text" ? { text } : { flow_id: flowId }),
  };

  const res = await gw(`/v1/tenants/${tenant}/liwa/send`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = (res.data as { error?: string; hint?: string; code?: string } | null) ?? {};
    return NextResponse.json(
      {
        ok: false,
        error: err.error ?? `LIWA HTTP ${res.status}`,
        hint: err.hint,
        code: err.code,
      },
      { status: res.status || 502 },
    );
  }
  const data = (res.data as Record<string, unknown>) ?? {};
  return NextResponse.json({
    ok: true,
    mock_commercial: false,
    message: {
      id: data.message_id ?? randomUUID(),
      status: data.status ?? "sent",
      kind,
      provider_ref: data.provider_ref,
    },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req: NextRequest, slugParts: string[]): Promise<NextResponse> {
  const slug = slugParts.join("/");
  const token = bearer(req);
  const method = req.method.toUpperCase();

  if (slug === "auth/login" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const res = await gw("/v1/auth/login", "", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) return NextResponse.json({ error: "Credenciales inválidas" }, { status: res.status || 401 });
    return NextResponse.json(res.data);
  }

  const tenant = await resolveTenant(token);

  if (method === "GET") {
    // Per-conversation LIWA status: ops/conversations/:id/liwa-status
    if (slugParts[0] === "ops" && slugParts[1] === "conversations" && slugParts[3] === "liwa-status") {
      const conversationId = slugParts[2];
      if (!tenant || !conversationId) return NextResponse.json({ ok: false });
      const res = await gw(`/v1/tenants/${tenant}/nova/conversations/${conversationId}/channel-status`, token);
      return NextResponse.json(res.ok ? (res.data as object) : { ok: false });
    }

    if (slugParts[0] === "ops" && slugParts[1] === "reports" && slugParts[2]) {
      if (!tenant) return NextResponse.json({ ok: false, error: "Sin tenant" }, { status: 400 });
      return buildReport(token, tenant, slugParts[2]);
    }

    switch (slug) {
      case "ops/conversations":
        if (!tenant) return NextResponse.json({ activeCount: 0, conversations: [] });
        return buildConversations(token, tenant);
      case "ops/dashboard":
        if (!tenant) return NextResponse.json({ kpis: [], contactsByDay: [], funnelRenovacion: [], baseStatus: [], ops: [], liveEvents: [] });
        return buildDashboard(token, tenant);
      case "ops/campaigns":
        if (!tenant) return NextResponse.json({ campaigns: [] });
        return buildCampaigns(token, tenant);
      case "ops/crm":
        if (!tenant) return NextResponse.json({ funnels: {} });
        return buildCrm(token, tenant);
      case "ops/handoff":
        if (!tenant) return NextResponse.json({ queue: [], kpis: [], byAdvisor: [], quality: { score: 0, label: "—", breakdown: [] } });
        return buildHandoff(token, tenant);
      case "ops/segmentation":
        return NextResponse.json({ points: [], waves: [], retries: [], heatmap: { days: [], hours: [], values: [] } });
      case "ops/whatsapp/flows":
        return NextResponse.json({
          ok: true,
          items: [{ id: LIWA_DEFAULT_FLOW, name: "Renovación" }],
          default_flow_id: LIWA_DEFAULT_FLOW,
          mode: "live",
        });
      case "ops/whatsapp/pending":
        if (!tenant) return NextResponse.json({ items: [], count: 0 });
        return buildWhatsAppPending(token, tenant);
      case "ops/whatsapp/status":
        return NextResponse.json({ ok: true, mode: "live", webhook: { path: "/v1/liwa/webhooks" } });
      case "ops/documents":
        return NextResponse.json({ items: [], total: 0 });
      case "ops/compliance/opt-outs":
        return NextResponse.json({ items: [], total: 0 });
      case "ops/settings":
        return NextResponse.json({
          channels: { voz: true, whatsapp: true },
          dialer: {},
          agent_config: {},
          ui: { pii_masking: false },
          whatsapp: { mode: "live", default_flow_id: LIWA_DEFAULT_FLOW, default_kind: "flow" },
        });
      case "ops/auth/status":
        return NextResponse.json({
          ok: true,
          app_env: "contabo",
          auth_disabled: false,
          oidc_configured: false,
          ready_for_production_auth: true,
        });
      default:
        return NextResponse.json({ items: [], total: 0 });
    }
  }

  if (method === "POST" || method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const base = `/v1/tenants/${tenant}/nova`;

    switch (slug) {
      // ---- Laboratorio: dispatch a real voice call (drives auto post-call WA) ----
      case "ops/orchestration/attempt":
      case "ops/calls/dispatch":
        return dispatchCall(token, tenant, {
          phone: String(body.phone ?? ""),
          name: body.first_name ? String(body.first_name) : undefined,
          flow: body.flow ? String(body.flow) : "A",
        });
      case "ops/orchestration/batch":
        return NextResponse.json({ ok: true, total: 0, sent_or_queued: 0, blocked: 0, results: [] });
      case "ops/calls/complete": {
        // Demo seed for Revisión post-llamada: create pending_review (skip live dialer completion).
        if (!tenant) return NextResponse.json({ error: "Sin tenant" }, { status: 400 });
        const phone = normalizePhone(String(body.phone ?? ""));
        if (!phone) return NextResponse.json({ error: "phone requerido" }, { status: 400 });
        const res = await gw(`${base}/reviews`, token, {
          method: "POST",
          body: JSON.stringify({
            phone_e164: phone,
            full_name: body.first_name ? String(body.first_name) : undefined,
            intent: body.intent ? String(body.intent) : "interesado",
            flow_id: body.flow_id ? String(body.flow_id) : LIWA_DEFAULT_FLOW,
          }),
        });
        if (!res.ok) {
          return NextResponse.json(
            { ok: false, error: (res.data as { error?: string } | null)?.error ?? `HTTP ${res.status}` },
            { status: res.status || 502 },
          );
        }
        return NextResponse.json({
          ok: true,
          skip_whatsapp: true,
          review: res.data,
          conversation_id: body.conversation_id ?? undefined,
        });
      }

      case "ops/whatsapp/pending/send":
      case "ops/whatsapp/pending/skip": {
        if (!tenant) return NextResponse.json({ error: "Sin tenant" }, { status: 400 });
        const decision = slug.endsWith("/skip") ? "skip" : "approve";
        let reviewId = String(body.review_id ?? body.id ?? "").trim();
        if (!reviewId) {
          const phone = normalizePhone(String(body.phone ?? ""));
          const pending = await buildWhatsAppPending(token, tenant);
          const payload = (await pending.json()) as { items?: Array<Record<string, unknown>> };
          const match = (payload.items ?? []).find((item) => {
            const status = String(item.whatsapp_status ?? item.status ?? "");
            if (status !== "pending_review") return false;
            if (phone && normalizePhone(String(item.phone ?? "")) === phone) return true;
            if (body.conversation_id && String(item.conversation_id ?? "") === String(body.conversation_id)) {
              return true;
            }
            return false;
          });
          reviewId = String(match?.id ?? match?.review_id ?? "");
        }
        if (!reviewId) {
          return NextResponse.json({ error: "review_id no encontrado (pendiente)" }, { status: 404 });
        }
        const operatorId = await resolveOperatorId(token);
        const res = await gw(`${base}/reviews/${reviewId}/decide`, token, {
          method: "POST",
          body: JSON.stringify({
            decision,
            operator_id: operatorId || undefined,
            flow_id: body.flow_id ? String(body.flow_id) : undefined,
          }),
        });
        if (!res.ok) {
          return NextResponse.json(
            { ok: false, error: (res.data as { error?: string } | null)?.error ?? "decide failed" },
            { status: res.status || 502 },
          );
        }
        return NextResponse.json({
          ok: true,
          conversation_id: body.conversation_id,
          phone: body.phone,
          status: decision === "skip" ? "skipped" : "approved",
          ...(res.data as object),
        });
      }

      // ---- LIWA lab simulate ----
      case "ops/laboratorio/liwa-event":
      case "ops/webhooks/liwa/simulate": {
        if (!tenant) return NextResponse.json({ error: "Sin tenant" }, { status: 400 });
        const res = await gw(`${base}/lab/liwa-event`, token, { method: "POST", body: JSON.stringify(body) });
        return NextResponse.json(res.data ?? { ok: res.ok });
      }

      // ---- Conversations ----
      case "ops/conversations/messages": {
        const conversationId = String(body.conversation_id ?? "");
        const text = String(body.text ?? "").trim();
        if (!tenant || !conversationId || !text) {
          return NextResponse.json({ error: "conversation_id y text requeridos" }, { status: 400 });
        }
        const res = await gw(`${base}/conversations/${conversationId}/reply`, token, {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        if (!res.ok) return NextResponse.json({ error: "No se pudo enviar" }, { status: res.status });
        return NextResponse.json({ ok: true, message: res.data });
      }
      case "ops/conversations/claim": {
        const conversationId = String(body.conversation_id ?? "");
        const operatorId = await resolveOperatorId(token);
        if (!tenant || !conversationId || !operatorId) {
          return NextResponse.json({ error: "No fue posible tomar el control" }, { status: 400 });
        }
        const res = await gw(`${base}/conversations/${conversationId}/claim`, token, {
          method: "POST",
          body: JSON.stringify({ operator_id: operatorId }),
        });
        if (!res.ok) return NextResponse.json({ error: "Conversación no disponible" }, { status: res.status });
        return NextResponse.json({ ok: true, ...(res.data as object) });
      }
      case "ops/conversations/release": {
        const conversationId = String(body.conversation_id ?? "");
        if (!tenant || !conversationId) {
          return NextResponse.json({ error: "conversation_id requerido" }, { status: 400 });
        }
        const res = await gw(`${base}/conversations/${conversationId}/release`, token, {
          method: "POST",
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          return NextResponse.json(
            { error: (res.data as { error?: string } | null)?.error ?? "No se pudo liberar" },
            { status: res.status || 502 },
          );
        }
        return NextResponse.json({ ok: true, released: true, ...(res.data as object) });
      }

      // ---- CRM ----
      case "ops/crm/move": {
        const leadId = String(body.lead_id ?? "");
        const toColumn = String(body.to_column ?? "");
        const tipificacion = body.tipificacion ? String(body.tipificacion) : "";
        if (!tenant || !leadId || !toColumn) {
          return NextResponse.json({ error: "lead_id y to_column requeridos" }, { status: 400 });
        }
        if ((toColumn === "renovado" || toColumn === "no_interes") && !tipificacion.trim()) {
          return NextResponse.json(
            { error: "tipificacion requerida para cerrar el lead" },
            { status: 422 },
          );
        }
        const res = await gw(`${base}/leads/${leadId}`, token, {
          method: "PATCH",
          body: JSON.stringify({
            stage: toColumn,
            tipification: tipificacion || undefined,
          }),
        });
        if (!res.ok) {
          return NextResponse.json(
            { error: (res.data as { error?: string } | null)?.error ?? "Transición bloqueada" },
            { status: res.status },
          );
        }
        return NextResponse.json({ ok: true, ...(res.data as object) });
      }

      // ---- Contacts import ----
      case "ops/contacts/import": {
        if (!tenant) return NextResponse.json({ error: "Sin tenant" }, { status: 400 });
        const rows = (Array.isArray(body.rows) ? body.rows : []) as Array<Record<string, unknown>>;
        const mapped = rows.map((r) => {
          const phone = normalizePhone(String(r.phone ?? r.phone_e164 ?? r.telefono ?? ""));
          const firstName = r.nombre
            ? String(r.nombre)
            : r.name
              ? String(r.name)
              : r.full_name
                ? String(r.full_name)
                : r.first_name
                  ? String(r.first_name)
                  : undefined;
          const segment = r.segmento
            ? String(r.segmento)
            : r.segment
              ? String(r.segment)
              : undefined;
          return {
            phone,
            first_name: firstName,
            segment,
            valid: Boolean(phone),
            phone_e164: phone,
            full_name: firstName,
            agency_code: r.agency_code ? String(r.agency_code) : r.agencia ? String(r.agencia) : undefined,
            product_line: productLineFromSegment(segment),
          };
        });
        const contacts = mapped
          .filter((c) => c.valid)
          .map((c) => ({
            phone_e164: c.phone_e164,
            full_name: c.full_name,
            agency_code: c.agency_code,
            segment: c.segment,
            product_line: c.product_line as "renovacion" | "reactivacion" | "nuevos" | "microcredito",
          }));
        const valid = contacts.length;
        const invalid = rows.length - valid;
        if (!body.commit) {
          return NextResponse.json({
            total: rows.length,
            valid,
            invalid,
            committed: 0,
            rows: mapped.map((c) => ({
              phone: c.phone,
              first_name: c.first_name,
              segment: c.segment,
              valid: c.valid,
              errors: c.valid ? [] : ["teléfono inválido"],
            })),
          });
        }
        const res = await gw(`${base}/contacts/import`, token, {
          method: "POST",
          body: JSON.stringify({ contacts }),
        });
        if (!res.ok) {
          const detail = (res.data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
          return NextResponse.json(
            { total: rows.length, valid, invalid, committed: 0, error: detail },
            { status: res.status || 502 },
          );
        }
        const imported = (res.data as { imported?: unknown[] } | null)?.imported ?? [];
        return NextResponse.json({ total: rows.length, valid, invalid, committed: imported.length });
      }

      // ---- Soft acks (no destructive Hyperion endpoint yet) ----
      case "ops/handoff":
        return NextResponse.json({ id: randomUUID(), status: "queued" });
      case "ops/whatsapp/send":
        if (!tenant) return NextResponse.json({ ok: false, error: "Sin tenant" }, { status: 400 });
        return sendWhatsAppLive(token, tenant, body);
      case "ops/compliance/opt-out":
        return NextResponse.json({ ok: true, phone: body.phone ?? "" });
      case "ops/documents":
        return NextResponse.json({ id: randomUUID(), status: "received", errors: [], filename: body.filename ?? "" });
      case "ops/settings":
        return NextResponse.json({ ok: true, ...(body as object) });
      default:
        return NextResponse.json({ ok: true });
    }
  }

  return NextResponse.json({ error: "Método no soportado" }, { status: 405 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  return handle(req, slug ?? []);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  return handle(req, slug ?? []);
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  return handle(req, slug ?? []);
}
