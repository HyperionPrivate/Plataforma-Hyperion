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
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async lookupAssociate(documentId: string): Promise<CoreAssociate | null> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/associates/${encodeURIComponent(documentId)}`;
    const response = await this.fetchImpl(url, { method: "GET", headers: { accept: "application/json" } });
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
      headers: { "content-type": "application/json", accept: "application/json" },
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

export function createCoreAdapter(env: NodeJS.ProcessEnv = process.env): CoreAdapter {
  const mode = env.CORE_MODE?.trim() || "contract";
  const baseUrl = env.CORE_BASE_URL?.trim();
  if (mode === "live" && baseUrl) {
    return new HttpCoreAdapter(baseUrl);
  }
  return new ContractTestAdapter();
}
