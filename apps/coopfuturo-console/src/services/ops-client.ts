/** Mutations against pilot-core `/ops` (works alongside mock reads). */
import { pilotCoreBaseUrl, redirectToLogin, sessionHeaders } from "@/lib/auth";

const base = pilotCoreBaseUrl();

function assertOk(path: string, res: Response, text: string): void {
  if (res.status === 401) {
    redirectToLogin("expired");
    throw new Error("Sesión expirada. Vuelve a iniciar sesión.");
  }
  if (!res.ok) {
    throw new Error(`pilot-core ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    credentials: "include",
    headers: sessionHeaders(
      { Accept: "application/json", "Content-Type": "application/json" },
      { csrf: true },
    ),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assertOk(path, res, text);
  return (text ? JSON.parse(text) : {}) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "GET",
    credentials: "include",
    headers: sessionHeaders({ Accept: "application/json" }),
  });
  const text = await res.text();
  assertOk(path, res, text);
  return (text ? JSON.parse(text) : {}) as T;
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    credentials: "include",
    headers: sessionHeaders(
      { Accept: "application/json", "Content-Type": "application/json" },
      { csrf: true },
    ),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assertOk(path, res, text);
  return (text ? JSON.parse(text) : {}) as T;
}

export type CreatedCampaign = {
  id: string;
  name: string;
  segment: string;
  channels: string[];
  total: number;
  status: string;
};

export async function createCampaign(input: {
  name: string;
  segment?: string;
  channels?: string[];
  total?: number;
}) {
  return postJson<CreatedCampaign>("/ops/campaigns", {
    name: input.name,
    segment: input.segment ?? "Renovacion",
    channels: input.channels ?? ["voz"],
    total: input.total ?? 0,
  });
}

export async function importContacts(rows: Record<string, unknown>[], commit = false) {
  return postJson<{
    total?: number;
    valid?: number;
    invalid?: number;
    committed?: number;
    rows?: unknown[];
  }>("/ops/contacts/import", { rows, commit });
}

export async function dispatchCall(input: {
  phone: string;
  first_name?: string;
  flow?: "A" | "B";
  campaign_id?: string;
}) {
  return postJson<{
    ok: boolean;
    mock_commercial: boolean;
    dispatch: Record<string, unknown>;
  }>("/ops/calls/dispatch", input);
}

export async function createHandoff(input: {
  name: string;
  segment?: string;
  motivo?: string;
  phone?: string;
  agency_tag?: string;
  conversation_id?: string;
  idempotency_key?: string;
  priority?: string;
}) {
  return postJson<Record<string, unknown>>("/ops/handoff", input);
}

export async function orchestrationAttempt(input: {
  phone: string;
  first_name?: string;
  flow?: "A" | "B";
  campaign_id?: string;
}) {
  return postJson<{
    ok: boolean;
    mock_commercial?: boolean;
    dispatch?: Record<string, unknown>;
  }>("/ops/orchestration/attempt", input);
}

export async function completeCall(input: {
  phone: string;
  first_name?: string;
  intent?: string;
  flow?: "A" | "B";
  skip_whatsapp?: boolean;
  conversation_id?: string;
  dispatch_id?: string;
}) {
  return postJson<{
    ok: boolean;
    intent: string;
    flow?: string;
    wants_whatsapp: boolean;
    whatsapp_sent: boolean;
    whatsapp?: Record<string, unknown>;
    crm?: Record<string, unknown>;
    product?: Record<string, unknown>;
  }>("/ops/calls/complete", input);
}

export async function fetchWhatsAppPending(scope: "pending" | "review" = "pending") {
  const q = scope === "review" ? "?scope=review" : "";
  return getJson<{
    items: Record<string, unknown>[];
    count: number;
    scope?: string;
    pii_masked?: boolean;
  }>(`/ops/whatsapp/pending${q}`);
}

export async function sendWhatsAppPending(input: {
  id?: string;
  review_id?: string;
  conversation_id?: string;
  phone?: string;
  flow_id?: string;
}) {
  return postJson<{
    ok: boolean;
    conversation_id?: string;
    phone?: string;
    whatsapp?: Record<string, unknown>;
  }>("/ops/whatsapp/pending/send", input);
}

export async function skipWhatsAppPending(input: {
  id?: string;
  review_id?: string;
  conversation_id?: string;
  phone?: string;
}) {
  return postJson<{ ok: boolean; conversation_id?: string; status: string }>(
    "/ops/whatsapp/pending/skip",
    input,
  );
}

export async function optOut(phone: string) {
  return postJson<{ ok: boolean; phone: string }>("/ops/compliance/opt-out", { phone });
}

export async function sendWhatsApp(input: {
  phone: string;
  text?: string;
  template?: string;
  kind?: "flow" | "text";
  flow_id?: string;
  first_name?: string;
}) {
  return postJson<{
    ok: boolean;
    mock_commercial: boolean;
    message: Record<string, unknown>;
    compliance?: Record<string, unknown>;
  }>("/ops/whatsapp/send", input);
}

export async function fetchWhatsAppFlows() {
  return getJson<{
    ok?: boolean;
    items: { id: string; name: string }[];
    default_flow_id?: string;
    mode?: string;
  }>("/ops/whatsapp/flows");
}

export async function moveCrmLead(input: {
  lead_id: string;
  to_column: string;
  tipificacion?: string;
  funnel?: string;
}) {
  return postJson<Record<string, unknown>>("/ops/crm/move", input);
}

export type LiwaConversationStatus = {
  ok: boolean;
  conversation_id: string;
  phone?: string;
  live_chat: boolean;
  handoff_detected: boolean;
  tags: string[];
  handoff_tags?: string[];
  agency_hint?: string | null;
  contact_id?: string;
  mode?: "bot" | "live_chat" | "mock" | string;
  inbox_url?: string;
  synced?: boolean;
  actions?: string[];
  error?: string;
};

export async function fetchConversationLiwaStatus(conversationId: string) {
  return getJson<LiwaConversationStatus>(
    `/ops/conversations/${encodeURIComponent(conversationId)}/liwa-status`,
  );
}

export async function claimConversation(input: {
  conversation_id: string;
  advisor?: string;
}) {
  return postJson<Record<string, unknown>>("/ops/conversations/claim", input);
}

export async function releaseConversation(input: { conversation_id: string }) {
  return postJson<{ ok: boolean; released: boolean }>(
    "/ops/conversations/release",
    input,
  );
}

export async function sendConversationMessage(input: {
  conversation_id: string;
  text: string;
  role?: "advisor" | "bot" | "user";
}) {
  return postJson<{
    ok: boolean;
    message: Record<string, unknown>;
    delivery?: string;
    channel_acked?: boolean;
    liwa?: Record<string, unknown>;
  }>("/ops/conversations/messages", input);
}

export async function listOptOuts() {
  return getJson<{ items: string[]; total: number }>("/ops/compliance/opt-outs");
}

export async function simulateLiwaEvent(input: {
  event: string;
  phone: string;
  first_name?: string;
  name?: string;
  ciudad?: string;
  text?: string;
  score?: number;
}) {
  return postJson<{
    ok: boolean;
    event?: string;
    actions?: string[];
    crm?: Record<string, unknown>;
    conversation_id?: string;
    error?: string;
  }>("/ops/laboratorio/liwa-event", input);
}

export async function registerDocument(input: {
  filename: string;
  content_type?: string;
  size_bytes?: number;
  contact_phone?: string;
  kind?: string;
}) {
  return postJson<{
    id: string;
    status: string;
    errors: string[];
    filename: string;
  }>("/ops/documents", input);
}

export async function uploadDocument(input: {
  file: File;
  contact_phone?: string;
  kind?: string;
}) {
  const form = new FormData();
  form.append("file", input.file);
  if (input.contact_phone) form.append("contact_phone", input.contact_phone);
  form.append("kind", input.kind ?? "orden_matricula");
  const res = await fetch(`${base}/ops/documents/upload`, {
    method: "POST",
    credentials: "include",
    headers: sessionHeaders({ Accept: "application/json" }, { csrf: true }),
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pilot-core /ops/documents/upload → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<{
    id: string;
    status: string;
    errors: string[];
    filename: string;
    storage?: string;
  }>;
}

export async function listDocuments() {
  return getJson<{ items: Record<string, unknown>[]; total: number }>("/ops/documents");
}

export async function runE2ERenovacion(input: {
  phone: string;
  first_name?: string;
  flow?: "A" | "B";
  skip_voice?: boolean;
  skip_whatsapp?: boolean;
  flow_id?: string;
  agency_tag?: string;
}) {
  const flow = input.flow ?? "A";
  const path = flow === "B" ? "/ops/e2e/reactivacion" : "/ops/e2e/renovacion";
  return postJson<{
    ok: boolean;
    phone: string;
    flow?: string;
    product?: Record<string, unknown>;
    steps: Record<string, unknown>;
  }>(path, input);
}

export async function runE2ECampaign(input: {
  phone: string;
  first_name?: string;
  flow?: "A" | "B";
  skip_voice?: boolean;
  skip_whatsapp?: boolean;
  flow_id?: string;
  agency_tag?: string;
}) {
  return postJson<{
    ok: boolean;
    phone: string;
    flow?: string;
    product?: Record<string, unknown>;
    steps: Record<string, unknown>;
  }>("/ops/e2e/campaign", input);
}

export async function fetchAuthStatus() {
  return getJson<{
    ok: boolean;
    app_env: string;
    auth_disabled: boolean;
    oidc_configured: boolean;
    ready_for_production_auth: boolean;
  }>("/ops/auth/status");
}

export async function fetchReport(reportId: string) {
  return getJson<{ ok: boolean; format: string; report: Record<string, unknown> }>(
    `/ops/reports/${reportId}`,
  );
}

export type OpsUiSettings = {
  pii_masking?: boolean;
  /** Meta diaria de contactos (voz+WA). 0 = sin meta configurada. */
  meta_contactos_hoy?: number;
};

export async function fetchSettings() {
  return getJson<{
    channels: Record<string, boolean>;
    dialer: { base_url?: string; default_phone_number_id?: string };
    agent_config: Record<string, unknown>;
    ui?: OpsUiSettings;
    whatsapp?: {
      mode?: string;
      provider?: string;
      base_url?: string;
      default_flow_id?: string;
      flow_id_b?: string;
      default_kind?: string;
    };
  }>("/ops/settings");
}

export async function saveSettings(input: {
  channels?: Record<string, boolean | unknown>;
  dialer?: { base_url?: string; default_phone_number_id?: string };
  agent_config?: Record<string, unknown>;
  ui?: OpsUiSettings;
}) {
  return putJson<Record<string, unknown>>("/ops/settings", input);
}

export async function orchestrationBatch(input: {
  campaign_id?: string;
  flow?: "A" | "B";
  limit?: number;
}) {
  return postJson<{
    ok: boolean;
    total: number;
    sent_or_queued: number;
    blocked: number;
    results: Record<string, unknown>[];
  }>("/ops/orchestration/batch", input);
}

export async function lookupAssociate(documentId: string) {
  return getJson<Record<string, unknown>>(`/ops/core/associate/${encodeURIComponent(documentId)}`);
}
