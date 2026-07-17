import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import dashboardSample from "@/data/dashboard.json";
import campaignsSample from "@/data/campaigns.json";
import crmSample from "@/data/crm.json";
import handoffSample from "@/data/handoff.json";

/**
 * Backend-for-frontend that keeps the CoopFuturo (PULSO) UI contract
 * (`/pilot-core/ops/*`) intact while translating the live calls to the Hyperion
 * api-gateway. Running server-side avoids CORS and never exposes internal URLs.
 *
 * The conversations surface (chat espejo) is wired to the real NOVA backend so
 * the LIWA webhook end-to-end works. Overview screens fall back to the bundled
 * reference dataset until each one is ported to its NOVA endpoint.
 */

export const dynamic = "force-dynamic";

const GATEWAY = (process.env.HYPERION_GATEWAY_URL ?? "http://api-gateway:8080").replace(/\/$/, "");
const TENANT_ENV = (process.env.COOPFUTURO_TENANT_ID ?? "").trim();

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

type NovaContact = {
  contact_id: string;
  phone_e164: string | null;
  full_name: string | null;
  agency_code: string | null;
};

async function buildConversations(token: string, tenant: string) {
  const base = `/v1/tenants/${tenant}/nova`;
  const [listRes, contactsRes] = await Promise.all([
    gw(`${base}/conversations`, token),
    gw(`${base}/contacts?limit=200`, token),
  ]);

  if (!listRes.ok) {
    return NextResponse.json({ activeCount: 0, conversations: [], pii_masked: false });
  }

  const rows = (Array.isArray(listRes.data) ? listRes.data : []) as NovaConversation[];
  const contactItems = ((contactsRes.data as { items?: NovaContact[] } | null)?.items ?? []) as NovaContact[];
  const contactById = new Map(contactItems.map((c) => [c.contact_id, c]));

  const enriched = await Promise.all(
    rows.slice(0, 60).map(async (row) => {
      const msgRes = await gw(`${base}/conversations/${row.conversation_id}/messages`, token);
      const messages = (Array.isArray(msgRes.data) ? msgRes.data : []) as NovaMessage[];
      const contact = contactById.get(row.contact_id);
      const name = contact?.full_name || contact?.phone_e164 || "Asociado";
      const uiMessages = messages.map((m) => ({
        id: m.message_id,
        role: m.direction === "inbound" ? "user" : "bot",
        source: m.direction === "outbound" ? "advisor" : undefined,
        text: m.body,
        at: hhmm(m.created_at),
      }));
      const last = messages[messages.length - 1];
      const status = row.status ?? "open";
      return {
        id: row.conversation_id,
        name,
        topic: (row.channel ?? "whatsapp") === "voz" ? "Voz" : "WhatsApp",
        snippet: last?.body ?? "Sin mensajes todavía",
        channel: (row.channel ?? "whatsapp") === "voz" ? "voz" : "whatsapp",
        sentiment: "neutral",
        time: hhmm(row.last_message_at),
        tags: status === "claimed" ? ["En atención"] : ["Abierta"],
        botActive: status === "open",
        botPaused: status !== "open",
        claimedBy: row.claimed_by ?? undefined,
        messages: uiMessages,
      };
    }),
  );

  const activeCount = rows.filter((r) => (r.status ?? "open") !== "closed").length;
  return NextResponse.json({ activeCount, conversations: enriched, pii_masked: false });
}

async function handle(req: NextRequest, slugParts: string[]): Promise<NextResponse> {
  const slug = slugParts.join("/");
  const token = bearer(req);
  const method = req.method.toUpperCase();

  // --- Auth (email/password) ---------------------------------------------
  if (slug === "auth/login" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const res = await gw("/v1/auth/login", "", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) {
      return NextResponse.json({ error: "Credenciales inválidas" }, { status: res.status || 401 });
    }
    return NextResponse.json(res.data);
  }

  const tenant = await resolveTenant(token);

  // --- Reads --------------------------------------------------------------
  if (method === "GET") {
    switch (slug) {
      case "ops/conversations":
        if (!tenant) return NextResponse.json({ activeCount: 0, conversations: [] });
        return buildConversations(token, tenant);
      case "ops/dashboard":
        return NextResponse.json(dashboardSample);
      case "ops/campaigns":
        return NextResponse.json(campaignsSample);
      case "ops/crm":
        return NextResponse.json(crmSample);
      case "ops/handoff":
        return NextResponse.json(handoffSample);
      case "ops/segmentation":
        return NextResponse.json({
          points: [],
          waves: [],
          retries: [],
          heatmap: { days: [], hours: [], values: [] },
        });
      case "ops/whatsapp/flows":
        return NextResponse.json({ ok: true, items: [], default_flow_id: "" });
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
          whatsapp: { mode: "live" },
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

  // --- Mutations ----------------------------------------------------------
  if (method === "POST" || method === "PUT") {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const base = `/v1/tenants/${tenant}/nova`;

    switch (slug) {
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
      case "ops/contacts/import": {
        if (!tenant) return NextResponse.json({ error: "Sin tenant" }, { status: 400 });
        const res = await gw(`${base}/contacts/import`, token, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return NextResponse.json(res.data ?? { ok: res.ok });
      }
      case "ops/webhooks/liwa/simulate": {
        if (!tenant) return NextResponse.json({ error: "Sin tenant" }, { status: 400 });
        const res = await gw(`${base}/lab/liwa-event`, token, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return NextResponse.json(res.data ?? { ok: res.ok });
      }
      case "ops/handoff":
        return NextResponse.json({ id: randomUUID(), status: "queued" });
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
