import { randomUUID } from "node:crypto";
import { isRestrictedDeploymentEnvironment } from "@hyperion/config";

export interface DialerCampaignInput {
  name: string;
  agentId: string;
  targetCalls?: number;
  idempotencyKey?: string;
}

export interface DialerContactInput {
  phoneE164: string;
  externalRef?: string;
}

export interface DialerCallInput {
  phoneE164: string;
  dynamicVars?: Record<string, string>;
  idempotencyKey?: string;
}

export interface DialerCallRow {
  id: string;
  status: string;
  phone?: string;
  campaign_id?: string;
  conversation_id?: string | null;
  amd_label?: string | null;
  disposition?: string | null;
  result_code?: string | null;
}

export interface DialerAdapter {
  createCampaign(input: DialerCampaignInput): Promise<{ campaignRef: string }>;
  loadContacts(campaignRef: string, contacts: DialerContactInput[]): Promise<{ loaded: number }>;
  start(campaignRef: string): Promise<void>;
  pause(campaignRef: string): Promise<void>;
  stop(campaignRef: string): Promise<void>;
  cancel(campaignRef: string): Promise<void>;
  placeCall(input: DialerCallInput): Promise<{ callRef: string; conversationId?: string; status: string }>;
  getCampaign(campaignRef: string): Promise<Record<string, unknown>>;
  listCalls(query?: { campaignId?: string; status?: string; limit?: number }): Promise<DialerCallRow[]>;
  listReconciliation(): Promise<DialerCallRow[]>;
  reconcileCall(
    callId: string,
    resolution: "confirmed_initiated" | "confirmed_not_created" | "abandoned",
    extras?: { conversationId?: string; note?: string }
  ): Promise<void>;
}

/** SSRF guard: only the configured DIALER_BASE_URL host is allowed. */
export function assertDialerBaseUrlAllowed(baseUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const configured = env.DIALER_BASE_URL?.trim();
  if (!configured) {
    if (isRestrictedDeploymentEnvironment(env)) {
      throw new Error("DIALER_BASE_URL is required in restricted environments");
    }
    return;
  }

  let allowed: URL;
  let candidate: URL;
  try {
    allowed = new URL(configured);
    candidate = new URL(baseUrl);
  } catch {
    throw new Error("Dialer base URL must be a valid HTTP(S) URL");
  }

  if (allowed.protocol !== "http:" && allowed.protocol !== "https:") {
    throw new Error("Dialer base URL must use HTTP or HTTPS");
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    throw new Error("Dialer request URL must use HTTP or HTTPS");
  }
  if (allowed.host !== candidate.host) {
    throw new Error("Dialer request host is not allowed");
  }
}

export class HttpDialerAdapter implements DialerAdapter {
  private jwt: string | undefined;
  private jwtExpiresAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly credentials: {
      username: string;
      password: string;
      demoApiKey: string;
    },
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    assertDialerBaseUrlAllowed(this.baseUrl);
  }

  async createCampaign(input: DialerCampaignInput): Promise<{ campaignRef: string }> {
    const response = await this.requestJson(
      "POST",
      "/api/campaigns/",
      {
        name: input.name,
        agent_id: input.agentId,
        target_calls: input.targetCalls ?? 0
      },
      { idempotencyKey: input.idempotencyKey }
    );
    return { campaignRef: String(response.id ?? response.campaign_id) };
  }

  async loadContacts(campaignRef: string, contacts: DialerContactInput[]): Promise<{ loaded: number }> {
    assertDialerBaseUrlAllowed(this.baseUrl);
    const csv = ["phone", ...contacts.map((c) => c.phoneE164)].join("\n");
    const form = new FormData();
    form.append("file", new Blob([csv], { type: "text/csv" }), "contacts.csv");

    const token = await this.ensureJwt();
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/campaigns/${encodeURIComponent(campaignRef)}/contacts`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "Idempotency-Key": randomUUID()
      },
      body: form
    });
    if (!response.ok) {
      throw new Error(`Dialer contact upload failed with status ${response.status}`);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { loaded: Number(body.loaded ?? body.count ?? contacts.length) };
  }

  async start(campaignRef: string): Promise<void> {
    await this.requestJson("POST", `/api/campaigns/${encodeURIComponent(campaignRef)}/start`, {});
  }

  async pause(campaignRef: string): Promise<void> {
    await this.requestJson("POST", `/api/campaigns/${encodeURIComponent(campaignRef)}/pause`, {});
  }

  async stop(campaignRef: string): Promise<void> {
    await this.requestJson("POST", `/api/campaigns/${encodeURIComponent(campaignRef)}/stop`, {});
  }

  async cancel(campaignRef: string): Promise<void> {
    await this.requestJson("POST", `/api/campaigns/${encodeURIComponent(campaignRef)}/cancel`, {});
  }

  async placeCall(input: DialerCallInput): Promise<{ callRef: string; conversationId?: string; status: string }> {
    assertDialerBaseUrlAllowed(this.baseUrl);
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/demo/call`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Demo-Api-Key": this.credentials.demoApiKey,
        "Idempotency-Key": input.idempotencyKey ?? randomUUID()
      },
      body: JSON.stringify({
        phone: input.phoneE164,
        caller_acknowledged: true,
        dynamic_vars: input.dynamicVars ?? {}
      })
    });
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error(
          "Dialer rate limit (429): límite de llamadas demo por hora. Espera o sube DEMO_RATE_LIMIT_PER_HOUR_IP."
        );
      }
      throw new Error(`Dialer demo call failed with status ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    return {
      callRef: String(body.call_id ?? body.id),
      conversationId: body.conversation_id ? String(body.conversation_id) : undefined,
      status: String(body.status ?? "initiated")
    };
  }

  async getCampaign(campaignRef: string): Promise<Record<string, unknown>> {
    return this.requestJson("GET", `/api/campaigns/${encodeURIComponent(campaignRef)}`);
  }

  async listCalls(query: { campaignId?: string; status?: string; limit?: number } = {}): Promise<DialerCallRow[]> {
    const params = new URLSearchParams();
    if (query.campaignId) params.set("campaign_id", query.campaignId);
    if (query.status) params.set("status", query.status);
    params.set("limit", String(query.limit ?? 100));
    const body = await this.requestJson("GET", `/api/calls/?${params.toString()}`);
    const rows = Array.isArray(body) ? body : ((body.items as unknown[]) ?? (body.calls as unknown[]) ?? []);
    return rows as DialerCallRow[];
  }

  async listReconciliation(): Promise<DialerCallRow[]> {
    const body = await this.requestJson("GET", "/api/calls/reconciliation");
    const rows = Array.isArray(body)
      ? body
      : ((body.items as unknown[]) ?? (body.needs_reconciliation as unknown[]) ?? []);
    return rows as DialerCallRow[];
  }

  async reconcileCall(
    callId: string,
    resolution: "confirmed_initiated" | "confirmed_not_created" | "abandoned",
    extras?: { conversationId?: string; note?: string }
  ): Promise<void> {
    await this.requestJson("POST", `/api/calls/${encodeURIComponent(callId)}/reconcile`, {
      resolution,
      conversation_id: extras?.conversationId,
      note: extras?.note
    });
  }

  private async ensureJwt(): Promise<string> {
    if (this.jwt && Date.now() < this.jwtExpiresAt - 60_000) {
      return this.jwt;
    }
    assertDialerBaseUrlAllowed(this.baseUrl);
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/auth/login`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: this.credentials.username,
        password: this.credentials.password
      })
    });
    if (!response.ok) {
      throw new Error(`Dialer login failed with status ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const token = String(body.access_token ?? body.token ?? "");
    if (!token) throw new Error("Dialer login did not return a JWT");
    this.jwt = token;
    this.jwtExpiresAt = Date.now() + 8 * 60 * 60 * 1000;
    return token;
  }

  private async requestJson(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ): Promise<Record<string, unknown>> {
    assertDialerBaseUrlAllowed(this.baseUrl);
    const token = await this.ensureJwt();
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      throw new Error(`Dialer request ${method} ${path} failed with status ${response.status}`);
    }
    if (response.status === 204) return {};
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }
}

/** Fails every operation — used only when dialer credentials are absent outside restricted envs. */
export class UnconfiguredDialerAdapter implements DialerAdapter {
  private fail(): never {
    throw new Error(
      "Dialer is not configured. Set DIALER_BASE_URL, DIALER_ADMIN_USER, DIALER_ADMIN_PASSWORD and DIALER_DEMO_API_KEY"
    );
  }
  createCampaign(): Promise<{ campaignRef: string }> {
    return this.fail();
  }
  loadContacts(): Promise<{ loaded: number }> {
    return this.fail();
  }
  start(): Promise<void> {
    return this.fail();
  }
  pause(): Promise<void> {
    return this.fail();
  }
  stop(): Promise<void> {
    return this.fail();
  }
  cancel(): Promise<void> {
    return this.fail();
  }
  placeCall(): Promise<{ callRef: string; conversationId?: string; status: string }> {
    return this.fail();
  }
  getCampaign(): Promise<Record<string, unknown>> {
    return this.fail();
  }
  listCalls(): Promise<DialerCallRow[]> {
    return this.fail();
  }
  listReconciliation(): Promise<DialerCallRow[]> {
    return this.fail();
  }
  reconcileCall(): Promise<void> {
    return this.fail();
  }
}

export function createDialerAdapter(env: NodeJS.ProcessEnv = process.env): DialerAdapter {
  const baseUrl = env.DIALER_BASE_URL?.trim();
  const username = env.DIALER_ADMIN_USER?.trim() || env.VOICE_DIALER_USERNAME?.trim();
  const password = env.DIALER_ADMIN_PASSWORD?.trim() || env.VOICE_DIALER_PASSWORD?.trim();
  const demoApiKey = env.DIALER_DEMO_API_KEY?.trim() || env.VOICE_TO_DIALER_TOKEN?.trim();

  if (!baseUrl || !username || !password || !demoApiKey) {
    if (isRestrictedDeploymentEnvironment(env)) {
      throw new Error(
        "DIALER_BASE_URL, DIALER_ADMIN_USER, DIALER_ADMIN_PASSWORD and DIALER_DEMO_API_KEY are required for voice-channel"
      );
    }
    return new UnconfiguredDialerAdapter();
  }

  return new HttpDialerAdapter(baseUrl, { username, password, demoApiKey });
}
