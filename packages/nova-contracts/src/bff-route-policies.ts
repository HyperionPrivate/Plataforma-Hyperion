import type { NovaCapability, NovaCellComponent, NovaProductRole } from "./index.js";

export type NovaBffTenantRouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface NovaBffTenantRoutePolicy {
  method: NovaBffTenantRouteMethod;
  path: string;
  component: NovaCellComponent;
  capability: NovaCapability;
  roles?: readonly NovaProductRole[];
}

function novaTenantRoute(
  method: NovaBffTenantRouteMethod,
  component: NovaCellComponent,
  suffix: string,
  capability: NovaCapability,
  roles?: readonly NovaProductRole[]
): NovaBffTenantRoutePolicy {
  return {
    method,
    path: `/v1/tenants/:tenantId/${component}/${suffix}`,
    component,
    capability,
    ...(roles ? { roles } : {})
  };
}

/**
 * Provider-owned customer route allowlist. The NOVA BFF and the temporary
 * legacy gateway compatibility facade must both consume this exact value.
 */
export const NOVA_BFF_TENANT_ROUTE_POLICIES: readonly NovaBffTenantRoutePolicy[] = Object.freeze([
  novaTenantRoute("GET", "nova", "catalog", "nova:read"),
  novaTenantRoute("GET", "nova", "dashboard", "nova:read"),
  novaTenantRoute("GET", "nova", "contacts", "nova:read"),
  novaTenantRoute("GET", "nova", "campaigns", "nova:read"),
  novaTenantRoute("GET", "nova", "leads", "nova:read"),
  novaTenantRoute("GET", "nova", "handoffs", "nova:read"),
  novaTenantRoute("GET", "nova", "conversations", "nova:read"),
  novaTenantRoute("GET", "nova", "conversations/:id/messages", "nova:read"),
  novaTenantRoute("GET", "nova", "core/associates/:documentId", "nova:read"),
  novaTenantRoute("GET", "nova", "conversations/:conversationId/channel-status", "nova:read"),
  novaTenantRoute("GET", "nova", "reviews", "nova:read"),
  novaTenantRoute("GET", "nova", "analytics/daily", "nova:read"),
  novaTenantRoute("POST", "nova", "contacts/import", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "contacts/import/file", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "contacts/:contactId/score", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "contacts/:contactId/eligibility", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "contacts/:contactId/calls", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "campaigns", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "campaigns/:id/enroll", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "campaigns/:id/start", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "campaigns/:id/pause", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "campaigns/:id/cancel", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("PATCH", "nova", "leads/:id", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "handoffs/:id/claim", "nova:write"),
  novaTenantRoute("POST", "nova", "conversations/:id/claim", "nova:write"),
  novaTenantRoute("POST", "nova", "conversations/:id/release", "nova:write"),
  novaTenantRoute("POST", "nova", "conversations/:id/reply", "nova:write"),
  novaTenantRoute("POST", "nova", "outcomes", "nova:write"),
  novaTenantRoute("POST", "nova", "reviews", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("POST", "nova", "reviews/:reviewId/decide", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("GET", "nova", "compliance/settings", "nova:read", ["admin", "supervisor"]),
  novaTenantRoute("PUT", "nova", "compliance/settings", "nova:admin", ["admin"]),
  novaTenantRoute("GET", "nova", "agent-configs", "nova:read", ["admin", "supervisor"]),
  novaTenantRoute("GET", "nova", "agent-configs/:productFlow", "nova:read", ["admin", "supervisor"]),
  novaTenantRoute("PUT", "nova", "agent-configs", "nova:admin", ["admin"]),
  novaTenantRoute("PUT", "nova", "agent-configs/:productFlow", "nova:admin", ["admin"]),
  novaTenantRoute("POST", "nova", "bootstrap", "nova:admin", ["admin"]),
  novaTenantRoute("POST", "nova", "lab/liwa-event", "nova:write", ["admin", "supervisor"]),
  novaTenantRoute("GET", "nova", "outbox/dlq", "nova:admin", ["admin"]),
  novaTenantRoute("GET", "nova", "operations/readiness", "nova:admin", ["admin"]),
  novaTenantRoute("POST", "nova", "outbox/dlq/:eventId/redrive", "nova:admin", ["admin"]),
  novaTenantRoute("GET", "voice", "campaigns", "nova:read"),
  novaTenantRoute("GET", "voice", "campaigns/:campaignId/stats", "nova:read"),
  novaTenantRoute("GET", "voice", "calls/reconciliation", "nova:admin", ["admin"]),
  novaTenantRoute("GET", "voice", "operations/readiness", "nova:admin", ["admin"]),
  novaTenantRoute("POST", "voice", "calls/:callId/reconcile", "nova:admin", ["admin"]),
  novaTenantRoute("GET", "voice", "outbox/dlq", "nova:admin", ["admin"]),
  novaTenantRoute("POST", "voice", "outbox/dlq/:eventId/redrive", "nova:admin", ["admin"]),
  novaTenantRoute("POST", "liwa", "send", "nova:write"),
  novaTenantRoute("POST", "liwa", "conversations/:id/reply", "nova:write"),
  novaTenantRoute("POST", "documents", "upload", "nova:write"),
  novaTenantRoute("GET", "documents", ":id", "nova:read")
]);
