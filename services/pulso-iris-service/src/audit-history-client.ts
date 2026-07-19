import { auditEntityTypeSchema, auditEventViewListSchema, type AuditEventView } from "@hyperion/audit-contracts";
import { tenantIdSchema } from "@hyperion/platform-contracts";
import { createInternalAuthorizationHeaders } from "@hyperion/service-runtime";

export type AuditHistoryReader = (tenantId: string, entityType: string, entityId: string) => Promise<AuditEventView[]>;

export class AuditHistoryUnavailableError extends Error {
  constructor(
    message: string,
    readonly statusCode: 502 | 503
  ) {
    super(message);
    this.name = "AuditHistoryUnavailableError";
  }
}

export function createAuditHistoryClient(options: {
  auditServiceUrl: string;
  credential: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): AuditHistoryReader {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.auditServiceUrl.replace(/\/$/, "");
  return async (tenantId, entityType, entityId) => {
    if (!options.credential) throw new AuditHistoryUnavailableError("Audit query credential is not configured", 503);
    const parsedTenant = tenantIdSchema.safeParse(tenantId);
    const parsedType = auditEntityTypeSchema.safeParse(entityType);
    if (!parsedTenant.success || !parsedType.success || !entityId.trim() || entityId.length > 160) {
      throw new TypeError("Invalid Audit history scope");
    }
    const url = `${baseUrl}/internal/v1/tenants/${encodeURIComponent(parsedTenant.data)}/audit/entities/${encodeURIComponent(parsedType.data)}/${encodeURIComponent(entityId)}/events`;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: createInternalAuthorizationHeaders("pulso-iris-service", options.credential),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 3_000)
      });
      if (!response.ok) throw new Error(`Audit returned HTTP ${response.status}`);
      const payload = (await response.json()) as { data?: unknown };
      return auditEventViewListSchema.parse(payload.data);
    } catch (error) {
      if (error instanceof AuditHistoryUnavailableError) throw error;
      throw new AuditHistoryUnavailableError("Audit history is unavailable", 502);
    }
  };
}
