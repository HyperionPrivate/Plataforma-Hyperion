import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server.js";
import {
  configuredCoopfuturoPublicOrigin,
  configuredCoopfuturoTenant,
  customerBoundPrincipal,
  isAllowedCoopfuturoMutationOrigin,
  isAllowedCoopfuturoRoute,
  isUnavailableCoopfuturoOperation,
  normalizeCustomerUpstreamStatus,
  selectBoundNovaTenant,
} from "./coopfuturo-route-policy.mjs";
import {
  translateCoopfuturoCookieHeader,
  translateNovaSetCookie,
} from "./coopfuturo-session-policy.mjs";

/**
 * Customer adapter that keeps the CoopFuturo NOVA UI contract (`/pilot-core/ops/*`)
 * intact while translating live calls to the provider-owned NOVA BFF. It never
 * accepts or forwards a browser credential: the isolated customer session is
 * carried only by host-only cookies.
 *
 * All reads are wired to real NOVA data (no bundled sample datasets). The
 * Laboratorio dispatch places a real voice call; the post-call WhatsApp is then
 * emitted automatically by nova-core when the call completes with positive intent.
 */

const LIWA_DEFAULT_FLOW = (
  process.env.COOPFUTURO_LIWA_FLOW_ID?.trim() ||
  process.env.LIWA_DEFAULT_FLOW_ID?.trim() ||
  "1784249919201"
);

type BffSession = {
  cookie: string;
  csrf: string;
  requestId: string;
};

function novaBffBaseUrl(): string {
  const raw = process.env.NOVA_BFF_URL?.trim();
  if (!raw) throw new Error("NOVA_BFF_URL is required");
  const parsed = new URL(raw);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NOVA_BFF_URL must be an HTTP(S) origin without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/$/, "");
}

function browserSession(req: NextRequest): BffSession {
  const cookie = translateCoopfuturoCookieHeader(req.headers.get("cookie") ?? "");
  return {
    cookie,
    csrf: req.headers.get("x-csrf-token") ?? "",
    requestId: req.headers.get("x-request-id") ?? randomUUID(),
  };
}

function isSameOriginMutation(req: NextRequest, publicOrigin: string): boolean {
  return isAllowedCoopfuturoMutationOrigin(
    req.method,
    req.headers.get("origin"),
    req.headers.get("sec-fetch-site"),
    publicOrigin,
  );
}

type GwResult = { ok: boolean; status: number; data: unknown };

function upstreamFailure(...results: GwResult[]): NextResponse | null {
  const failed = results.find((result) => !result.ok);
  if (!failed) return null;
  const status = normalizeCustomerUpstreamStatus(failed.status);
  const upstream =
    failed.data && typeof failed.data === "object"
      ? (failed.data as { error?: unknown; code?: unknown; hint?: unknown })
      : null;
  return NextResponse.json(
    {
      error:
        typeof upstream?.error === "string" && upstream.error.length <= 300
          ? upstream.error
          : "NOVA BFF no pudo completar la operación",
      ...(typeof upstream?.code === "string" && upstream.code.length <= 100
        ? { code: upstream.code }
        : {}),
      ...(typeof upstream?.hint === "string" && upstream.hint.length <= 300
        ? { hint: upstream.hint }
        : {}),
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function featureUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "Funcionalidad no disponible: NOVA aún no expone este contrato" },
    { status: 501, headers: { "Cache-Control": "no-store" } },
  );
}

function splitSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/u).map((cookie) => cookie.trim());
}

function responseSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies =
    typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : (() => {
          const combined = headers.get("set-cookie");
          return combined ? splitSetCookie(combined) : [];
        })();
  return cookies
    .map(translateNovaSetCookie)
    .filter((cookie): cookie is string => typeof cookie === "string");
}

type CustomerBinding = { tenantId: string; publicOrigin: string };

function customerBinding(): CustomerBinding | { error: string; status: 503 } {
  const configuredTenant = configuredCoopfuturoTenant(process.env);
  if (!configuredTenant.tenantId) {
    return {
        error:
          configuredTenant.reason === "missing"
            ? "COOPFUTURO_TENANT_ID es requerido"
            : "COOPFUTURO_TENANT_ID debe ser un UUID",
        status: 503,
      };
  }
  const configuredOrigin = configuredCoopfuturoPublicOrigin(process.env);
  if (!configuredOrigin.origin) {
    return {
      error:
        configuredOrigin.reason === "missing"
          ? "COOPFUTURO_PUBLIC_ORIGIN es requerido"
          : "COOPFUTURO_PUBLIC_ORIGIN debe ser un origen HTTPS válido",
      status: 503,
    };
  }
  return { tenantId: configuredTenant.tenantId, publicOrigin: configuredOrigin.origin };
}

function principalFromAuthResponse(
  path: "/v1/auth/login" | "/v1/auth/me" | "/v1/auth/logout",
  responseBody: string,
): unknown {
  if (path === "/v1/auth/logout") return undefined;
  try {
    const payload = JSON.parse(responseBody) as { data?: unknown };
    if (path === "/v1/auth/login") {
      return (payload.data as { principal?: unknown } | undefined)?.principal;
    }
    return payload.data;
  } catch {
    return undefined;
  }
}

async function proxyAuthRequest(
  req: NextRequest,
  path: "/v1/auth/login" | "/v1/auth/me" | "/v1/auth/logout",
  binding: CustomerBinding,
): Promise<NextResponse> {
  const session = browserSession(req);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  try {
    const upstream = await fetch(`${novaBffBaseUrl()}${path}`, {
      method: req.method,
      headers: {
        Accept: "application/json",
        "X-Requested-With": "nova-console",
        "X-Request-Id": session.requestId,
        ...(body ? { "Content-Type": req.headers.get("content-type") ?? "application/json" } : {}),
        ...(session.cookie ? { Cookie: session.cookie } : {}),
        ...(session.csrf ? { "X-CSRF-Token": session.csrf } : {}),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    let responseBody = await upstream.text();
    if (path !== "/v1/auth/logout" && upstream.ok) {
      const principal = principalFromAuthResponse(path, responseBody);
      if (!principal || typeof principal !== "object") {
        return NextResponse.json({ error: "NOVA BFF devolvió una sesión inválida" }, { status: 502 });
      }
      const boundedPrincipal = customerBoundPrincipal(principal, binding.tenantId);
      if (!boundedPrincipal) {
        return NextResponse.json({ error: "Grant NOVA requerido para este cliente" }, { status: 403 });
      }
      // Return only the non-secret principal. The browser never receives the
      // provider response shape that originally contained the Access credential.
      responseBody = JSON.stringify({ data: { principal: boundedPrincipal } });
    }
    const response = new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "X-Request-Id": upstream.headers.get("x-request-id") ?? session.requestId,
      },
    });
    for (const cookie of responseSetCookies(upstream.headers)) {
      response.headers.append("Set-Cookie", cookie);
    }
    return response;
  } catch {
    return NextResponse.json({ error: "NOVA BFF no disponible" }, { status: 502 });
  }
}

async function gw(path: string, session: BffSession, init?: RequestInit): Promise<GwResult> {
  try {
    const res = await fetch(`${novaBffBaseUrl()}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "X-Requested-With": "nova-console",
        "X-Request-Id": session.requestId,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
        ...(session.cookie ? { Cookie: session.cookie } : {}),
        ...(session.csrf ? { "X-CSRF-Token": session.csrf } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
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

async function resolveTenant(
  session: BffSession,
  binding: CustomerBinding,
): Promise<{ tenantId: string } | { error: string; status: number }> {
  const me = await gw("/v1/auth/me", session);
  if (!me.ok) {
    return {
      error: me.status === 401 ? "Sesión inválida o expirada" : "No fue posible validar la sesión NOVA",
      status: normalizeCustomerUpstreamStatus(me.status),
    };
  }
  const grants = (me.data as {
    grants?: Array<{ tenantId?: unknown; productId?: unknown; active?: unknown }>;
  } | null)?.grants;
  const selection = selectBoundNovaTenant(grants, binding.tenantId);
  return selection.tenantId
    ? { tenantId: selection.tenantId }
    : {
        error:
          "Grant NOVA requerido para este cliente",
        status: 403,
      };
}

async function resolveOperatorId(
  token: BffSession,
): Promise<{ operatorId: string | null; result: GwResult }> {
  const me = await gw("/v1/auth/me", token);
  const id = (me.data as { operator?: { id?: string } } | null)?.operator?.id;
  return { operatorId: typeof id === "string" && id ? id : null, result: me };
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

async function contactMap(
  token: BffSession,
  tenant: string,
): Promise<{ contacts: Map<string, NovaContact>; result: GwResult }> {
  const res = await gw(`/v1/tenants/${tenant}/nova/contacts?limit=200`, token);
  const items = ((res.data as { items?: NovaContact[] } | null)?.items ?? []) as NovaContact[];
  return { contacts: new Map(items.map((c) => [c.contact_id, c])), result: res };
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

async function buildConversations(token: BffSession, tenant: string): Promise<NextResponse> {
  const base = `/v1/tenants/${tenant}/nova`;
  const [listRes, contactsResult] = await Promise.all([
    gw(`${base}/conversations`, token),
    contactMap(token, tenant),
  ]);
  const readFailure = upstreamFailure(listRes, contactsResult.result);
  if (readFailure) return readFailure;

  const rows = (Array.isArray(listRes.data) ? listRes.data : []) as NovaConversation[];
  const messageResults = await Promise.all(
    rows.slice(0, 60).map(async (row) => ({
      row,
      result: await gw(`${base}/conversations/${row.conversation_id}/messages`, token),
    })),
  );
  const messageFailure = upstreamFailure(...messageResults.map(({ result }) => result));
  if (messageFailure) return messageFailure;
  const contacts = contactsResult.contacts;
  const enriched = (
    messageResults
      .map(({ row, result: msgRes }) => {
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
      })
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

async function buildDashboard(token: BffSession, tenant: string): Promise<NextResponse> {
  const [dashRes, analyticsRes, leadsRes, convRes, contactsResult] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/dashboard`, token),
    gw(`/v1/tenants/${tenant}/nova/analytics/daily`, token),
    gw(`/v1/tenants/${tenant}/nova/leads`, token),
    gw(`/v1/tenants/${tenant}/nova/conversations`, token),
    contactMap(token, tenant),
  ]);
  const failure = upstreamFailure(
    dashRes,
    analyticsRes,
    leadsRes,
    convRes,
    contactsResult.result,
  );
  if (failure) return failure;

  const d = (dashRes.data as Record<string, number> | null) ?? {};
  const analytics = (Array.isArray(analyticsRes.data) ? analyticsRes.data : []) as AnalyticsDay[];
  const leads = (Array.isArray(leadsRes.data) ? leadsRes.data : []) as Array<Record<string, unknown>>;
  const conversations = (Array.isArray(convRes.data) ? convRes.data : []) as Array<Record<string, unknown>>;
  const contacts = contactsResult.contacts;

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

async function buildCampaigns(token: BffSession, tenant: string): Promise<NextResponse> {
  const base = `/v1/tenants/${tenant}/nova`;
  const [campaignsRes, analyticsRes, complianceRes] = await Promise.all([
    gw(`${base}/campaigns`, token),
    gw(`${base}/analytics/daily`, token),
    gw(`${base}/compliance/settings`, token),
  ]);
  const failure = upstreamFailure(campaignsRes, analyticsRes, complianceRes);
  if (failure) return failure;

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

async function buildCrm(token: BffSession, tenant: string): Promise<NextResponse> {
  const [leadsRes, contactsResult] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/leads`, token),
    contactMap(token, tenant),
  ]);
  const failure = upstreamFailure(leadsRes, contactsResult.result);
  if (failure) return failure;
  const leads = (Array.isArray(leadsRes.data) ? leadsRes.data : []) as Array<Record<string, unknown>>;
  const contacts = contactsResult.contacts;
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

async function buildWhatsAppPending(token: BffSession, tenant: string): Promise<NextResponse> {
  const [reviewsRes, contactsResult, convRes] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/reviews`, token),
    contactMap(token, tenant),
    gw(`/v1/tenants/${tenant}/nova/conversations`, token),
  ]);
  const failure = upstreamFailure(reviewsRes, contactsResult.result, convRes);
  if (failure) return failure;
  const reviews = (Array.isArray(reviewsRes.data) ? reviewsRes.data : []) as Array<Record<string, unknown>>;
  const conversations = (Array.isArray(convRes.data) ? convRes.data : []) as Array<Record<string, unknown>>;
  const contacts = contactsResult.contacts;
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

async function buildReport(token: BffSession, tenant: string, reportId: string): Promise<NextResponse> {
  const [dash, analyticsRes, leadsRes, handoffsRes, convRes] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/dashboard`, token),
    gw(`/v1/tenants/${tenant}/nova/analytics/daily`, token),
    gw(`/v1/tenants/${tenant}/nova/leads`, token),
    gw(`/v1/tenants/${tenant}/nova/handoffs`, token),
    gw(`/v1/tenants/${tenant}/nova/conversations`, token),
  ]);
  const failure = upstreamFailure(dash, analyticsRes, leadsRes, handoffsRes, convRes);
  if (failure) return failure;
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

async function buildHandoff(token: BffSession, tenant: string): Promise<NextResponse> {
  const [res, contactsResult] = await Promise.all([
    gw(`/v1/tenants/${tenant}/nova/handoffs`, token),
    contactMap(token, tenant),
  ]);
  const failure = upstreamFailure(res, contactsResult.result);
  if (failure) return failure;
  const rows = (Array.isArray(res.data) ? res.data : []) as Array<Record<string, unknown>>;
  const contacts = contactsResult.contacts;
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
  token: BffSession,
  tenant: string,
  phone: string,
): Promise<{ contact: NovaContact | null; result: GwResult }> {
  const res = await gw(
    `/v1/tenants/${tenant}/nova/contacts?limit=5&q=${encodeURIComponent(phone)}`,
    token,
  );
  if (!res.ok) return { contact: null, result: res };
  const items = ((res.data as { items?: NovaContact[] } | null)?.items ?? []) as NovaContact[];
  const exact = items.find((c) => c.phone_e164 === phone);
  return { contact: exact ?? items[0] ?? null, result: res };
}

async function ensureContact(
  token: BffSession,
  tenant: string,
  phone: string,
  name?: string,
  agency?: string,
): Promise<{ contactId: string | null; detail?: string; status?: number }> {
  const res = await gw(`/v1/tenants/${tenant}/nova/contacts/import`, token, {
    method: "POST",
    body: JSON.stringify({
      contacts: [{ phone_e164: phone, full_name: name || undefined, agency_code: agency || undefined }],
    }),
  });
  if (!res.ok) {
    return {
      contactId: null,
      detail: (res.data as { error?: string } | null)?.error ?? `import HTTP ${res.status}`,
      status: normalizeCustomerUpstreamStatus(res.status),
    };
  }
  const importData = res.data as {
    imported?: Array<{ contact_id: string }> | number;
    contact_ids?: string[];
  } | null;
  const fromImport = Array.isArray(importData?.imported)
    ? importData.imported[0]?.contact_id
    : importData?.contact_ids?.[0];
  if (fromImport) return { contactId: fromImport };

  // A successful idempotent import may refer to a contact that already exists.
  const existing = await findContactByPhone(token, tenant, phone);
  if (!existing.result.ok) {
    return {
      contactId: null,
      detail: (existing.result.data as { error?: string } | null)?.error ?? "contact lookup failed",
      status: normalizeCustomerUpstreamStatus(existing.result.status),
    };
  }
  if (existing.contact?.contact_id) return { contactId: existing.contact.contact_id };

  return { contactId: null, detail: "import sin contact_id", status: 502 };
}

async function dispatchCall(
  token: BffSession,
  tenant: string,
  input: { phone: string; name?: string; flow?: string; agency?: string },
): Promise<NextResponse> {
  const phone = normalizePhone(input.phone);
  if (!tenant || !phone) {
    return NextResponse.json({ ok: false, error: "Teléfono/tenant inválido" }, { status: 400 });
  }
  if (!token) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }
  const ensured = await ensureContact(token, tenant, phone, input.name, input.agency);
  if (!ensured.contactId) {
    const detail = ensured.detail ?? "sin detalle";
    return NextResponse.json(
      {
        ok: false,
        error: `No se pudo registrar el contacto (${detail})`,
      },
      { status: ensured.status ?? 502 },
    );
  }
  const contactId = ensured.contactId;
  const contactLookup = await findContactByPhone(token, tenant, phone);
  const contactFailure = upstreamFailure(contactLookup.result);
  if (contactFailure) return contactFailure;
  const contact = contactLookup.contact;
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
    return NextResponse.json(
      { ok: false, error: `Dialer: ${detail}` },
      { status: normalizeCustomerUpstreamStatus(call.status) },
    );
  }
  const data = (call.data as Record<string, unknown>) ?? {};
  return NextResponse.json({
    ok: true,
    mock_commercial: false,
    dispatch: { id: data.call_id ?? contactId, ...data },
  });
}

async function sendWhatsAppLive(
  token: BffSession,
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
    body.agency_tag ? String(body.agency_tag) : undefined,
  );
  if (!ensured.contactId) {
    return NextResponse.json(
      { ok: false, error: ensured.detail ?? "No se pudo registrar el contacto" },
      { status: ensured.status ?? 502 },
    );
  }

  const payload: Record<string, unknown> = {
    contact_ref: phone,
    contact_id: ensured.contactId,
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

async function readCustomerStep(response: NextResponse): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...payload, status: response.status, ok: response.ok && payload.ok !== false };
}

async function runCustomerE2E(
  session: BffSession,
  tenant: string,
  body: Record<string, unknown>,
  routeFlow: "A" | "B",
): Promise<NextResponse> {
  const phone = normalizePhone(String(body.phone ?? ""));
  if (!phone) return NextResponse.json({ error: "phone requerido" }, { status: 400 });
  if (body.skip_voice === true && body.skip_whatsapp === true) {
    return NextResponse.json(
      { error: "Debe ejecutarse al menos un paso live" },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  }
  const flow = body.flow === "B" ? "B" : routeFlow;
  const steps: Record<string, unknown> = {};
  let ok = true;
  let failedStatus: number | null = null;

  if (body.skip_voice === true) {
    steps.voice = { ok: true, skipped: true };
  } else {
    const voice = await readCustomerStep(
      await dispatchCall(session, tenant, {
        phone,
        name: body.first_name ? String(body.first_name) : undefined,
        flow,
        agency: body.agency_tag ? String(body.agency_tag) : undefined,
      }),
    );
    steps.voice = voice;
    ok = ok && voice.ok === true;
    if (voice.ok !== true && failedStatus === null) {
      failedStatus = normalizeCustomerUpstreamStatus(Number(voice.status));
    }
  }

  if (body.skip_whatsapp === true) {
    steps.whatsapp = { ok: true, skipped: true };
  } else {
    const whatsapp = await readCustomerStep(
      await sendWhatsAppLive(session, tenant, {
        phone,
        first_name: body.first_name,
        agency_tag: body.agency_tag,
        kind: "flow",
        flow_id: body.flow_id,
      }),
    );
    steps.whatsapp = whatsapp;
    ok = ok && whatsapp.ok === true;
    if (whatsapp.ok !== true && failedStatus === null) {
      failedStatus = normalizeCustomerUpstreamStatus(Number(whatsapp.status));
    }
  }

  return NextResponse.json(
    {
      ok,
      phone,
      flow,
      product: { product_flow: flow === "B" ? "reactivacion" : "renovacion" },
      steps,
    },
    { status: ok ? 200 : (failedStatus ?? 502) },
  );
}

async function uploadDocument(
  req: NextRequest,
  session: BffSession,
  tenant: string,
): Promise<NextResponse> {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "Archivo requerido" }, { status: 400 });
  }
  if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type)) {
    return NextResponse.json({ error: "Tipo de archivo no permitido" }, { status: 400 });
  }
  if (file.size <= 0 || file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "El archivo debe pesar entre 1 byte y 20 MB" }, { status: 400 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await gw(`/v1/tenants/${tenant}/documents/upload`, session, {
    method: "POST",
    body: JSON.stringify({
      content_base64: bytes.toString("base64"),
      content_type: file.type,
      contact_ref: form?.get("contact_phone") || undefined,
    }),
  });
  if (!result.ok) {
    return NextResponse.json(
      (result.data as object | null) ?? { error: "No se pudo registrar el documento" },
      { status: result.status || 502 },
    );
  }
  const document = (result.data as Record<string, unknown> | null) ?? {};
  return NextResponse.json(
    {
      id: document.document_id,
      status: document.status,
      errors: [],
      filename: file.name,
      storage: document.storage_key,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function handleCoopfuturoNovaRequest(
  req: NextRequest,
  slugParts: string[],
): Promise<NextResponse> {
  const slug = slugParts.join("/");
  const method = req.method.toUpperCase();

  if (!isAllowedCoopfuturoRoute(method, slugParts)) {
    return NextResponse.json({ error: "Ruta fuera de la celda NOVA Coopfuturo" }, { status: 404 });
  }

  const binding = customerBinding();
  if ("error" in binding) {
    return NextResponse.json({ error: binding.error }, { status: binding.status });
  }
  if (!isSameOriginMutation(req, binding.publicOrigin)) {
    return NextResponse.json(
      { error: "Origen no permitido" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (slug === "auth/login" && method === "POST") {
    return proxyAuthRequest(req, "/v1/auth/login", binding);
  }
  if (slug === "auth/session" && method === "GET") {
    return proxyAuthRequest(req, "/v1/auth/me", binding);
  }
  if (slug === "auth/logout" && method === "POST") {
    return proxyAuthRequest(req, "/v1/auth/logout", binding);
  }

  const token = browserSession(req);
  const tenantResolution = await resolveTenant(token, binding);
  if ("error" in tenantResolution) {
    return NextResponse.json(
      { error: tenantResolution.error },
      { status: tenantResolution.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const tenant = tenantResolution.tenantId;

  if (isUnavailableCoopfuturoOperation(method, slugParts)) {
    return featureUnavailable();
  }

  if (method === "GET") {
    // Per-conversation LIWA status: ops/conversations/:id/liwa-status
    if (slugParts[0] === "ops" && slugParts[1] === "conversations" && slugParts[3] === "liwa-status") {
      const conversationId = slugParts[2];
      if (!conversationId) return NextResponse.json({ error: "conversationId requerido" }, { status: 400 });
      const res = await gw(`/v1/tenants/${tenant}/nova/conversations/${conversationId}/channel-status`, token);
      const failure = upstreamFailure(res);
      return failure ?? NextResponse.json((res.data as object | null) ?? {});
    }

    if (slugParts[0] === "ops" && slugParts[1] === "reports" && slugParts[2]) {
      return buildReport(token, tenant, slugParts[2]);
    }

    if (
      slugParts[0] === "ops" &&
      slugParts[1] === "core" &&
      slugParts[2] === "associate" &&
      slugParts[3]
    ) {
      const result = await gw(
        `/v1/tenants/${tenant}/nova/core/associates/${encodeURIComponent(slugParts[3])}`,
        token,
      );
      const failure = upstreamFailure(result);
      if (failure) return failure;
      return NextResponse.json(
        (result.data as object | null) ?? {},
        { status: result.status },
      );
    }

    switch (slug) {
      case "ops/conversations":
        return buildConversations(token, tenant);
      case "ops/dashboard":
        return buildDashboard(token, tenant);
      case "ops/campaigns":
        return buildCampaigns(token, tenant);
      case "ops/crm":
        return buildCrm(token, tenant);
      case "ops/handoff":
        return buildHandoff(token, tenant);
      case "ops/whatsapp/pending":
        return buildWhatsAppPending(token, tenant);
      default:
        return NextResponse.json({ error: "Ruta NOVA Coopfuturo no implementada" }, { status: 404 });
    }
  }

  if (method === "POST" || method === "PUT") {
    if (slug === "ops/documents/upload" && method === "POST") {
      return uploadDocument(req, token, tenant);
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const base = `/v1/tenants/${tenant}/nova`;

    switch (slug) {
      case "ops/campaigns": {
        const channels = Array.isArray(body.channels) ? body.channels.map(String) : [];
        const channel =
          channels.includes("voz") && channels.includes("whatsapp")
            ? "mixed"
            : channels.includes("whatsapp")
              ? "whatsapp"
              : "voice";
        const segment = String(body.segment ?? "").toLocaleLowerCase("es-CO");
        const result = await gw(`${base}/campaigns`, token, {
          method: "POST",
          body: JSON.stringify({
            name: String(body.name ?? ""),
            channel,
            product_flow: segment.includes("react") ? "reactivacion" : "renovacion",
          }),
        });
        if (!result.ok) {
          return NextResponse.json(
            (result.data as object | null) ?? { error: "No se pudo crear la campaña" },
            { status: result.status || 502 },
          );
        }
        const campaign = (result.data as Record<string, unknown> | null) ?? {};
        return NextResponse.json(
          {
            id: campaign.campaign_id,
            name: campaign.name,
            segment: campaign.product_flow,
            channels,
            total: Number(body.total ?? 0),
            status: campaign.status,
          },
          { status: 201 },
        );
      }
      // ---- Laboratorio: dispatch a real voice call (drives auto post-call WA) ----
      case "ops/orchestration/attempt":
      case "ops/calls/dispatch":
        return dispatchCall(token, tenant, {
          phone: String(body.phone ?? ""),
          name: body.first_name ? String(body.first_name) : undefined,
          flow: body.flow ? String(body.flow) : "A",
        });
      case "ops/calls/complete": {
        // Demo seed for Revisión post-llamada: create pending_review (skip live dialer completion).
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
        const decision = slug.endsWith("/skip") ? "skip" : "approve";
        let reviewId = String(body.review_id ?? body.id ?? "").trim();
        if (!reviewId) {
          const phone = normalizePhone(String(body.phone ?? ""));
          const pending = await buildWhatsAppPending(token, tenant);
          if (!pending.ok) return pending;
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
        const operator = await resolveOperatorId(token);
        const operatorFailure = upstreamFailure(operator.result);
        if (operatorFailure) return operatorFailure;
        const operatorId = operator.operatorId;
        if (!operatorId) {
          return NextResponse.json({ error: "Sesión sin operador válido" }, { status: 502 });
        }
        const res = await gw(`${base}/reviews/${reviewId}/decide`, token, {
          method: "POST",
          body: JSON.stringify({
            decision,
            operator_id: operatorId,
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

      case "ops/e2e/renovacion":
        return runCustomerE2E(token, tenant, body, "A");
      case "ops/e2e/reactivacion":
        return runCustomerE2E(token, tenant, body, "B");
      case "ops/e2e/campaign":
        return runCustomerE2E(token, tenant, body, body.flow === "B" ? "B" : "A");

      // ---- LIWA lab simulate ----
      case "ops/laboratorio/liwa-event":
      case "ops/webhooks/liwa/simulate": {
        const res = await gw(`${base}/lab/liwa-event`, token, { method: "POST", body: JSON.stringify(body) });
        const failure = upstreamFailure(res);
        return failure ?? NextResponse.json((res.data as object | null) ?? {});
      }

      // ---- Conversations ----
      case "ops/conversations/messages": {
        const conversationId = String(body.conversation_id ?? "");
        const text = String(body.text ?? "").trim();
        if (!conversationId || !text) {
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
        if (!conversationId) {
          return NextResponse.json({ error: "No fue posible tomar el control" }, { status: 400 });
        }
        const operator = await resolveOperatorId(token);
        const operatorFailure = upstreamFailure(operator.result);
        if (operatorFailure) return operatorFailure;
        if (!operator.operatorId) {
          return NextResponse.json({ error: "Sesión sin operador válido" }, { status: 502 });
        }
        const res = await gw(`${base}/conversations/${conversationId}/claim`, token, {
          method: "POST",
          body: JSON.stringify({ operator_id: operator.operatorId }),
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
            dry_run: true,
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
        const imported = (res.data as { imported?: unknown[] | number } | null)?.imported;
        const committed = Array.isArray(imported) ? imported.length : Number(imported ?? 0);
        return NextResponse.json({ total: rows.length, valid, invalid, committed });
      }

      case "ops/whatsapp/send":
        return sendWhatsAppLive(token, tenant, body);
      default:
        return NextResponse.json({ error: "Ruta NOVA Coopfuturo no implementada" }, { status: 404 });
    }
  }

  return NextResponse.json({ error: "Método no soportado" }, { status: 405 });
}
