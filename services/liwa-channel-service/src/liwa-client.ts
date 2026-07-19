import { isRestrictedDeploymentEnvironment } from "@hyperion/nova-config";

export const DEFAULT_LIWA_BASE_URL = "https://chat.liwa.co/api";

export interface LiwaAccountMe {
  pageId: string;
  name: string;
  active: boolean;
  totalUsers?: string;
}

export interface LiwaNamedResource {
  id: string;
  name: string;
}

export type LiwaSendStatus = "sent" | "accepted_pending";

export interface LiwaSendResult {
  providerRef: string;
  status: LiwaSendStatus;
}

export interface LiwaClient {
  getAccountMe(): Promise<LiwaAccountMe>;
  listFlows(): Promise<LiwaNamedResource[]>;
  listTeams(): Promise<LiwaNamedResource[]>;
  ensureContact(phone: string, firstName?: string): Promise<{ contactId: string }>;
  sendFlow(contactId: string, flowId: string): Promise<LiwaSendResult>;
  sendText(contactId: string, text: string): Promise<LiwaSendResult>;
  listTags(): Promise<LiwaNamedResource[]>;
  ensureTag(name: string): Promise<string>;
  applyTag(contactId: string, tagId: string): Promise<void>;
  /** Agency handoff is tag-based on LIWA (no /handoff endpoint). */
  handoffToAgency(contactId: string, agencyTag: string, note?: string): Promise<void>;
}

/** AUD-016: LIWA often returns HTTP 200 + success without a delivery/message id. */
export function extractLiwaProviderMessageId(response: Record<string, unknown>): string | undefined {
  const nested = (response.data as Record<string, unknown> | undefined) ?? undefined;
  for (const key of ["message_id", "messageId", "wa_message_id", "provider_message_id", "provider_ref", "id"]) {
    const raw = nested?.[key] ?? response[key];
    if (raw !== undefined && raw !== null && String(raw).trim()) {
      const value = String(raw).trim();
      // Ignore fabricated-looking empty successes; keep real ids.
      if (value === "true" || value === "false") continue;
      return value;
    }
  }
  return undefined;
}

export function toLiwaSendResult(response: Record<string, unknown>): LiwaSendResult {
  const providerRef = extractLiwaProviderMessageId(response);
  if (providerRef) return { providerRef, status: "sent" };
  return { providerRef: "", status: "accepted_pending" };
}

/** Thrown when sendText is attempted outside the 24h WhatsApp session window. Cold outbound must use sendFlow. */
export class LiwaTextWindowError extends Error {
  readonly code = "LIWA_TEXT_WINDOW" as const;

  constructor(message = "WhatsApp text send requires an open 24h session; use sendFlow for cold outbound") {
    super(message);
    this.name = "LiwaTextWindowError";
  }
}

/** SSRF guard: only the configured LIWA_BASE_URL host is allowed. */
export function assertLiwaBaseUrlAllowed(baseUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const configured = env.LIWA_BASE_URL?.trim() || DEFAULT_LIWA_BASE_URL;
  if (!configured) {
    if (isRestrictedDeploymentEnvironment(env)) {
      throw new Error("LIWA_BASE_URL is required in restricted environments");
    }
    return;
  }

  let allowed: URL;
  let candidate: URL;
  try {
    allowed = new URL(configured);
    candidate = new URL(baseUrl);
  } catch {
    throw new Error("LIWA base URL must be a valid HTTP(S) URL");
  }

  if (allowed.protocol !== "http:" && allowed.protocol !== "https:") {
    throw new Error("LIWA base URL must use HTTP or HTTPS");
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    throw new Error("LIWA request URL must use HTTP or HTTPS");
  }
  if (allowed.host !== candidate.host) {
    throw new Error("LIWA request host is not allowed");
  }
}

function asNamedList(response: Record<string, unknown>): LiwaNamedResource[] {
  const rows = Array.isArray(response)
    ? response
    : ((response.items as unknown[]) ?? (response.data as unknown[]) ?? (response.tags as unknown[]) ?? []);
  return (rows as Record<string, unknown>[])
    .map((row) => ({
      id: String(row.id ?? row.tag_id ?? row.team_id ?? ""),
      name: String(row.name ?? row.tag_name ?? row.team_name ?? "")
    }))
    .filter((row) => row.id && row.name);
}

export class HttpLiwaClient implements LiwaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    assertLiwaBaseUrlAllowed(this.baseUrl, this.env);
  }

  async getAccountMe(): Promise<LiwaAccountMe> {
    const response = await this.request("GET", "/accounts/me");
    return {
      pageId: String(response.page_id ?? response.id ?? ""),
      name: String(response.name ?? ""),
      active: Boolean(response.active ?? true),
      totalUsers: response.total_users !== undefined ? String(response.total_users) : undefined
    };
  }

  async listFlows(): Promise<LiwaNamedResource[]> {
    return asNamedList(await this.request("GET", "/accounts/flows"));
  }

  async listTeams(): Promise<LiwaNamedResource[]> {
    return asNamedList(await this.request("GET", "/accounts/teams"));
  }

  async ensureContact(phone: string, firstName?: string): Promise<{ contactId: string }> {
    const body: Record<string, unknown> = { phone };
    if (firstName?.trim()) body.first_name = firstName.trim();
    const response = await this.request("POST", "/contacts", body);
    const nested = (response.data as Record<string, unknown> | undefined) ?? undefined;
    const contactId = String(
      nested?.id ?? nested?.contact_id ?? response.id ?? response.contact_id ?? response.contactId ?? ""
    );
    if (!contactId) throw new Error("LIWA ensureContact did not return a contact id");
    return { contactId };
  }

  async sendFlow(contactId: string, flowId: string): Promise<LiwaSendResult> {
    const response = await this.request(
      "POST",
      `/contacts/${encodeURIComponent(contactId)}/send/${encodeURIComponent(flowId)}`,
      {}
    );
    return toLiwaSendResult(response);
  }

  /**
   * Human inbox reply within the WhatsApp 24h session window (Ops Conversaciones).
   * Cold outbound must use sendFlow — callers enforce mode=flow for first touch.
   * Set LIWA_BLOCK_TEXT=1 only to force the soft guard (tests / emergency).
   * LIWA_FORCE_TEXT=1 keeps the previous "always allow" override.
   */
  async sendText(contactId: string, text: string): Promise<LiwaSendResult> {
    const block = this.env.LIWA_BLOCK_TEXT?.trim() === "1";
    const force = Boolean(this.env.LIWA_FORCE_TEXT?.trim());
    if (block && !force) {
      throw new LiwaTextWindowError();
    }
    const response = await this.request("POST", `/contacts/${encodeURIComponent(contactId)}/send/text`, { text });
    return toLiwaSendResult(response);
  }

  async listTags(): Promise<LiwaNamedResource[]> {
    return asNamedList(await this.request("GET", "/accounts/tags"));
  }

  async ensureTag(name: string): Promise<string> {
    const existing = (await this.listTags()).find((tag) => tag.name.toUpperCase() === name.toUpperCase());
    if (existing) return existing.id;

    const response = await this.request("POST", "/accounts/tags", { name });
    const createdId = String(response.id ?? response.tag_id ?? "");
    if (createdId) return createdId;

    const refreshed = (await this.listTags()).find((tag) => tag.name.toUpperCase() === name.toUpperCase());
    if (refreshed) return refreshed.id;
    throw new Error(`LIWA ensureTag did not return an id for ${name}`);
  }

  async applyTag(contactId: string, tagId: string): Promise<void> {
    await this.request("POST", `/contacts/${encodeURIComponent(contactId)}/tags/${encodeURIComponent(tagId)}`);
  }

  async handoffToAgency(contactId: string, agencyTag: string, _note?: string): Promise<void> {
    const tagId = await this.ensureTag(agencyTag);
    await this.applyTag(contactId, tagId);
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    assertLiwaBaseUrlAllowed(this.baseUrl, this.env);
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      "X-ACCESS-TOKEN": this.apiToken
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      throw new Error(`LIWA request ${method} ${path} failed with status ${response.status}`);
    }
    if (response.status === 204) return {};
    const parsed = await response.json().catch(() => ({}));
    return (Array.isArray(parsed) ? { items: parsed } : parsed) as Record<string, unknown>;
  }
}

/** Fails every operation — used when LIWA credentials are absent outside restricted envs. */
export class UnconfiguredLiwaClient implements LiwaClient {
  private fail(): never {
    throw new Error("LIWA is not configured. Set LIWA_API_TOKEN (or LIWA_ACCESS_TOKEN)");
  }
  getAccountMe(): Promise<LiwaAccountMe> {
    return this.fail();
  }
  listFlows(): Promise<LiwaNamedResource[]> {
    return this.fail();
  }
  listTeams(): Promise<LiwaNamedResource[]> {
    return this.fail();
  }
  ensureContact(): Promise<{ contactId: string }> {
    return this.fail();
  }
  sendFlow(): Promise<LiwaSendResult> {
    return this.fail();
  }
  sendText(): Promise<LiwaSendResult> {
    return this.fail();
  }
  listTags(): Promise<LiwaNamedResource[]> {
    return this.fail();
  }
  ensureTag(): Promise<string> {
    return this.fail();
  }
  applyTag(): Promise<void> {
    return this.fail();
  }
  handoffToAgency(): Promise<void> {
    return this.fail();
  }
}

export function createLiwaClient(env: NodeJS.ProcessEnv = process.env): LiwaClient {
  const baseUrl = env.LIWA_BASE_URL?.trim() || DEFAULT_LIWA_BASE_URL;
  const token = env.LIWA_API_TOKEN?.trim() || env.LIWA_ACCESS_TOKEN?.trim();
  if (!token) {
    if (isRestrictedDeploymentEnvironment(env)) {
      throw new Error("LIWA_API_TOKEN or LIWA_ACCESS_TOKEN is required for liwa-channel-service");
    }
    return new UnconfiguredLiwaClient();
  }
  return new HttpLiwaClient(baseUrl, token, env);
}
