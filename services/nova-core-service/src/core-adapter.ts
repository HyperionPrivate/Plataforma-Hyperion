export interface CoreAssociate {
  document_id: string;
  associate_id: string;
  full_name: string;
  agency_code?: string;
  status: string;
}

export interface CoreOutcomeInput {
  documentId: string;
  contactId: string;
  outcome: "approved" | "rejected" | "pending";
  amount?: number;
  note?: string;
}

export interface CoreAdapter {
  lookupAssociate(documentId: string): Promise<CoreAssociate | null>;
  recordOutcome(input: CoreOutcomeInput): Promise<{ externalRef: string }>;
}

export class HttpCoreAdapter implements CoreAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async lookupAssociate(documentId: string): Promise<CoreAssociate | null> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/associates/${encodeURIComponent(documentId)}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
      redirect: "error"
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Core lookup failed with status ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    return {
      document_id: String(body.document_id ?? documentId),
      associate_id: String(body.associate_id ?? body.id ?? ""),
      full_name: String(body.full_name ?? body.name ?? ""),
      agency_code: body.agency_code ? String(body.agency_code) : undefined,
      status: String(body.status ?? "unknown")
    };
  }

  async recordOutcome(input: CoreOutcomeInput): Promise<{ externalRef: string }> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/outcomes`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      body: JSON.stringify({
        document_id: input.documentId,
        contact_id: input.contactId,
        outcome: input.outcome,
        amount: input.amount,
        note: input.note
      })
    });
    if (!response.ok) {
      throw new Error(`Core recordOutcome failed with status ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    return { externalRef: String(body.external_ref ?? body.id ?? `core-${Date.now()}`) };
  }

  private headers(additional: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/json",
      authorization: `Bearer ${this.apiToken}`,
      ...additional
    };
  }
}

export class ContractTestAdapter implements CoreAdapter {
  async lookupAssociate(documentId: string): Promise<CoreAssociate | null> {
    if (documentId === "00000000-0000-0000-0000-000000000000") return null;
    return {
      document_id: documentId,
      associate_id: "assoc-contract-test",
      full_name: "Asociado Contract Test",
      agency_code: "TEST_AGENCY",
      status: "active"
    };
  }

  async recordOutcome(input: CoreOutcomeInput): Promise<{ externalRef: string }> {
    return { externalRef: `core-test-${input.documentId.slice(0, 8)}` };
  }
}

export class UnconfiguredCoreAdapter implements CoreAdapter {
  private fail(): never {
    throw new Error("Core adapter is not configured; set CORE_MODE=live and CORE_BASE_URL");
  }
  lookupAssociate(): Promise<CoreAssociate | null> {
    return this.fail();
  }
  recordOutcome(): Promise<{ externalRef: string }> {
    return this.fail();
  }
}

export function createCoreAdapter(env: NodeJS.ProcessEnv = process.env): CoreAdapter {
  const mode = env.CORE_MODE?.trim() || "disabled";
  const baseUrl = env.CORE_BASE_URL?.trim();
  const apiToken = env.CORE_API_TOKEN?.trim();
  if (mode === "live") {
    if (!baseUrl) throw new Error("CORE_BASE_URL is required when CORE_MODE=live");
    if (!apiToken) throw new Error("CORE_API_TOKEN is required when CORE_MODE=live");
    const url = validateCoreBaseUrl(baseUrl, isRestrictedDeploymentEnvironment(env));
    return new HttpCoreAdapter(url, apiToken);
  }
  if (mode === "contract") {
    if (isRestrictedDeploymentEnvironment(env)) {
      throw new Error("CORE_MODE=contract is forbidden in restricted environments");
    }
    return new ContractTestAdapter();
  }
  if (mode !== "disabled") throw new Error("CORE_MODE must be live, contract or disabled");
  if (isRestrictedDeploymentEnvironment(env)) {
    throw new Error("CORE_MODE=live and CORE_BASE_URL are required in restricted environments");
  }
  return new UnconfiguredCoreAdapter();
}

function validateCoreBaseUrl(value: string, restricted: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CORE_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("CORE_BASE_URL must be an absolute HTTP(S) URL without credentials, query or fragment");
  }
  if (restricted && url.protocol !== "https:") {
    throw new Error("CORE_BASE_URL must use HTTPS in restricted environments");
  }
  return url.toString().replace(/\/$/, "");
}
import { isRestrictedDeploymentEnvironment } from "@hyperion/nova-config";
