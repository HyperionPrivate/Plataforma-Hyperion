/** Mutations against pilot-core `/ops` (works alongside mock reads). */
const base = (process.env.NEXT_PUBLIC_PILOT_CORE_URL ?? "http://127.0.0.1:8201").replace(
  /\/$/,
  "",
);

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pilot-core ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pilot-core ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`pilot-core ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
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

export async function optOut(phone: string) {
  return postJson<{ ok: boolean; phone: string }>("/ops/compliance/opt-out", { phone });
}

export async function sendWhatsApp(input: {
  phone: string;
  text: string;
  template?: string;
}) {
  return postJson<{
    ok: boolean;
    mock_commercial: boolean;
    message: Record<string, unknown>;
  }>("/ops/whatsapp/send", input);
}

export async function moveCrmLead(input: {
  lead_id: string;
  to_column: string;
  tipificacion?: string;
  funnel?: string;
}) {
  return postJson<Record<string, unknown>>("/ops/crm/move", input);
}

export async function claimConversation(input: {
  conversation_id: string;
  advisor?: string;
}) {
  return postJson<Record<string, unknown>>("/ops/conversations/claim", input);
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

export async function listDocuments() {
  return getJson<{ items: Record<string, unknown>[]; total: number }>("/ops/documents");
}

export async function fetchReport(reportId: string) {
  return getJson<{ ok: boolean; format: string; report: Record<string, unknown> }>(
    `/ops/reports/${reportId}`,
  );
}

export async function fetchSettings() {
  return getJson<{
    channels: Record<string, boolean>;
    dialer: { base_url?: string; default_phone_number_id?: string };
    agent_config: Record<string, unknown>;
  }>("/ops/settings");
}

export async function saveSettings(input: {
  channels?: Record<string, boolean | unknown>;
  dialer?: { base_url?: string; default_phone_number_id?: string };
  agent_config?: Record<string, unknown>;
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
