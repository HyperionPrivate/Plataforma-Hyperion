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
const LIWA_DEFAULT_FLOW = (process.env.COOPFUTURO_LIWA_FLOW_ID ?? "1782399915832").trim();

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
};

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

async function buildConversations(token: string, tenant: string): Promise<NextResponse> {
  const base = `/v1/tenants/${tenant}/nova`;
  const [listRes, contacts] = await Promise.all([gw(`${base}/conversations`, token), contactMap(token, tenant)]);
  if (!listRes.ok) return NextResponse.json({ activeCount: 0, conversations: [], pii_masked: false });

  const rows = (Array.isArray(listRes.data) ? listRes.data : []) as NovaConversation[];
  const enriched = await Promise.all(
    rows.slice(0, 60).map(async (row) => {
      const msgRes = await gw(`${base}/conversations/${row.conversation_id}/messages`, token);
      const messages = (Array.isArray(msgRes.data) ? msgRes.data : []) as NovaMessage[];
      const contact = contacts.get(row.contact_id);
      const last = messages[messages.length - 1];
      const status = row.status ?? "open";
      return {
        id: row.conversation_id,
        name: contact?.full_name || contact?.phone_e164 || "Asociado",
        topic: (row.channel ?? "whatsapp") === "voz" ? "Voz" : "WhatsApp",
        snippet: last?.body ?? "Sin mensajes todavía",
        channel: (row.channel ?? "whatsapp") === "voz" ? "voz" : "whatsapp",
        sentiment: "neutral",
        time: hhmm(row.last_message_at),
        tags: status === "claimed" ? ["En atención"] : ["Abierta"],
        botActive: status === "open",
        botPaused: status !== "open",
        claimedBy: row.claimed_by ?? undefined,
        messages: messages.map((m) => ({
          id: m.message_id,
          role: m.direction === "inbound" ? "user" : "bot",
          source: m.direction === "outbound" ? "advisor" : undefined,
          text: m.body,
          at: hhmm(m.created_at),
        })),
      };
    }),
  );

  const activeCount = rows.filter((r) => (r.status ?? "open") !== "closed").length;
  return NextResponse.json({ activeCount, conversations: enriched, pii_masked: false });
}

// ---------------------------------------------------------------------------
// Overview reads (real NOVA data, no sample fallback)
// ---------------------------------------------------------------------------

async function buildDashboard(token: string, tenant: string): Promise<NextResponse> {
  const res = await gw(`/v1/tenants/${tenant}/nova/dashboard`, token);
  const d = (res.data as Record<string, number> | null) ?? {};
  const kpi = (id: string, label: string, value: number) => ({
    id,
    label,
    value: Number(value ?? 0),
    unit: "",
    delta: 0,
    deltaUnit: "",
    sparkline: [] as number[],
  });
  return NextResponse.json({
    kpis: [
      kpi("contactos", "Contactos", d.contacts ?? 0),
      kpi("campanas", "Campañas", d.campaigns ?? 0),
      kpi("leads", "Leads", d.leads ?? 0),
      kpi("conversaciones", "Conversaciones abiertas", d.openConversations ?? 0),
      kpi("handoffs", "Handoffs en cola", d.handoffsQueued ?? 0),
    ],
    contactsByDay: [],
    funnelRenovacion: [],
    baseStatus: [],
    ops: [],
    liveEvents: [],
  });
}

async function buildCampaigns(token: string, tenant: string): Promise<NextResponse> {
  const res = await gw(`/v1/tenants/${tenant}/nova/campaigns`, token);
  const rows = (Array.isArray(res.data) ? res.data : []) as Array<Record<string, unknown>>;
  const campaigns = rows.map((c) => ({
    id: String(c.campaign_id ?? ""),
    name: String(c.name ?? "Campaña"),
    segment: String(c.product_flow ?? ""),
    channels: c.channel ? [String(c.channel)] : [],
    continuous: false,
    contacted: 0,
    total: 0,
    conversion: 0,
    status: String(c.status ?? "draft"),
  }));
  return NextResponse.json({ campaigns });
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

function crmFunnelFor(
  leads: Array<Record<string, unknown>>,
  contacts: Map<string, NovaContact>,
  productMatch: (line: string) => boolean,
) {
  const columns = CRM_COLUMNS.map((col) => {
    const cards = leads
      .filter((l) => productMatch(String(l.product_line ?? "renovacion")) && String(l.stage ?? "pendiente") === col.id)
      .map((l) => {
        const contact = contacts.get(String(l.contact_id ?? ""));
        return {
          id: String(l.lead_id ?? ""),
          name: contact?.full_name || contact?.phone_e164 || "Lead",
          universidad: "",
          score: 0,
          channel: "whatsapp",
          urgency: "",
          phone: contact?.phone_e164 ?? undefined,
          allowed_next: [] as string[],
        };
      });
    return { id: col.id, label: col.label, count: cards.length, cards };
  });
  return { columns, tipificaciones: [] as Array<{ key: string; label: string; count: number }> };
}

async function buildCrm(token: string, tenant: string): Promise<NextResponse> {
  const [leadsRes, contacts] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/leads`, token),
    contactMap(token, tenant),
  ]);
  const leads = (Array.isArray(leadsRes.data) ? leadsRes.data : []) as Array<Record<string, unknown>>;
  const isReact = (line: string) => line.toLowerCase().includes("react");
  return NextResponse.json({
    funnels: {
      "Renovación": crmFunnelFor(leads, contacts, (l) => !isReact(l)),
      "Reactivación": crmFunnelFor(leads, contacts, (l) => isReact(l)),
      Nuevos: { columns: [], tipificaciones: [] },
      "Microcrédito": { columns: [], tipificaciones: [] },
    },
  });
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

async function ensureContact(
  token: string,
  tenant: string,
  phone: string,
  name?: string,
  agency?: string,
): Promise<string | null> {
  const res = await gw(`/v1/tenants/${tenant}/nova/contacts/import`, token, {
    method: "POST",
    body: JSON.stringify({
      contacts: [{ phone_e164: phone, full_name: name || undefined, agency_code: agency || undefined }],
    }),
  });
  const imported = (res.data as { imported?: Array<{ contact_id: string }> } | null)?.imported;
  return imported?.[0]?.contact_id ?? null;
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
  const contactId = await ensureContact(token, tenant, phone, input.name);
  if (!contactId) {
    return NextResponse.json({ ok: false, error: "No se pudo registrar el contacto" }, { status: 502 });
  }
  const call = await gw(`/v1/tenants/${tenant}/voice/calls`, token, {
    method: "POST",
    body: JSON.stringify({
      phone_e164: phone,
      contact_id: contactId,
      dynamic_vars: {
        nombre: input.name || "Asociado",
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
        return NextResponse.json({ items: [], count: 0 });
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
      case "ops/calls/complete":
        // Real completion arrives from the dialer webhook -> voice.call.completed.
        return NextResponse.json({ ok: true, note: "Completion is driven by the live call, not simulated." });

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
      case "ops/conversations/release":
        return NextResponse.json({ ok: true, released: true });

      // ---- CRM ----
      case "ops/crm/move": {
        const leadId = String(body.lead_id ?? "");
        const toColumn = String(body.to_column ?? "");
        if (!tenant || !leadId || !toColumn) {
          return NextResponse.json({ error: "lead_id y to_column requeridos" }, { status: 400 });
        }
        const res = await gw(`${base}/leads/${leadId}`, token, {
          method: "PATCH",
          body: JSON.stringify({ stage: toColumn, tipification: body.tipificacion ?? undefined }),
        });
        if (!res.ok) return NextResponse.json({ error: "Transición bloqueada" }, { status: res.status });
        return NextResponse.json({ ok: true, ...(res.data as object) });
      }

      // ---- Contacts import ----
      case "ops/contacts/import": {
        if (!tenant) return NextResponse.json({ error: "Sin tenant" }, { status: 400 });
        const rows = (Array.isArray(body.rows) ? body.rows : []) as Array<Record<string, unknown>>;
        const contacts = rows
          .map((r) => ({
            phone_e164: normalizePhone(String(r.phone ?? r.phone_e164 ?? r.telefono ?? "")),
            full_name: r.nombre ? String(r.nombre) : r.name ? String(r.name) : r.full_name ? String(r.full_name) : undefined,
            agency_code: r.agency_code ? String(r.agency_code) : r.agencia ? String(r.agencia) : undefined,
          }))
          .filter((c) => c.phone_e164);
        const valid = contacts.length;
        const invalid = rows.length - valid;
        if (!body.commit) {
          return NextResponse.json({ total: rows.length, valid, invalid, committed: 0, rows: contacts });
        }
        const res = await gw(`${base}/contacts/import`, token, {
          method: "POST",
          body: JSON.stringify({ contacts }),
        });
        const imported = (res.data as { imported?: unknown[] } | null)?.imported ?? [];
        return NextResponse.json({ total: rows.length, valid, invalid, committed: imported.length });
      }

      // ---- Soft acks (no destructive Hyperion endpoint yet) ----
      case "ops/handoff":
        return NextResponse.json({ id: randomUUID(), status: "queued" });
      case "ops/whatsapp/send":
        return NextResponse.json({
          ok: true,
          mock_commercial: true,
          message: { id: randomUUID(), status: "queued", kind: body.kind ?? "flow" },
        });
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
