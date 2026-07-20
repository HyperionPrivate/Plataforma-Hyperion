import {
  matchExactRoutePolicy,
  tenantIdSchema,
  type AccessPrincipal,
  type ProductGrant
} from "@hyperion/platform-contracts";

/**
 * Frozen N-1 authorization snapshot for the temporary bearer gateway.
 *
 * This file deliberately owns no provider package dependency. Product BFFs
 * remain authoritative for current routes; this immutable snapshot only keeps
 * already-issued legacy clients fail-closed while HYP-FED-004 is retired.
 */
export const LEGACY_PRODUCT_POLICY_SNAPSHOT_VERSION = 1 as const;

/** Fail-closed default for the multiproduct facade (DEBT-020 / 023 / 032). */
export function isLegacyGatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEGACY_GATEWAY_ENABLED?.trim().toLowerCase() === "true";
}

export const legacyGatewayTelemetry = {
  deprecatedRouteHits: 0,
  disabledRejects: 0
};

export function noteLegacyGatewayDeprecatedHit(): void {
  legacyGatewayTelemetry.deprecatedRouteHits += 1;
}

export function noteLegacyGatewayDisabledReject(): void {
  legacyGatewayTelemetry.disabledRejects += 1;
}

export type LegacyHttpMethod = "GET" | "HEAD" | "POST" | "PATCH" | "PUT";
export type LegacyCustomerProductId = "NOVA" | "LUMEN" | "PULSO_IRIS";

interface LegacyProductDefinition {
  productId: LegacyCustomerProductId;
  cellLabel: string;
  roleLabel: string;
  components: readonly string[];
  roles: readonly string[];
  capabilities: readonly string[];
  adminCapability: string;
}

interface LegacyTenantRoutePolicy {
  method: LegacyHttpMethod;
  path: string;
  productId: LegacyCustomerProductId;
  capability: string;
  roles?: readonly string[];
  resources?: readonly string[];
}

export interface LegacyProductRequestScope {
  productId: LegacyCustomerProductId;
  tenantId?: string;
}

export interface LegacyProductAuthorizationDenial {
  statusCode: 400 | 403 | 404;
  message: string;
}

const LEGACY_PRODUCTS: readonly LegacyProductDefinition[] = Object.freeze([
  Object.freeze({
    productId: "NOVA",
    cellLabel: "NOVA",
    roleLabel: "NOVA",
    components: Object.freeze(["nova", "voice", "liwa", "documents"]),
    roles: Object.freeze(["admin", "supervisor", "asesor"]),
    capabilities: Object.freeze(["nova:read", "nova:write", "nova:admin"]),
    adminCapability: "nova:admin"
  }),
  Object.freeze({
    productId: "LUMEN",
    cellLabel: "LUMEN",
    roleLabel: "LUMEN",
    components: Object.freeze(["lumen"]),
    roles: Object.freeze(["admin", "coordinator", "advisor", "auditor"]),
    capabilities: Object.freeze(["lumen:read", "lumen:write", "lumen:admin"]),
    adminCapability: "lumen:admin"
  }),
  Object.freeze({
    productId: "PULSO_IRIS",
    cellLabel: "PULSO",
    roleLabel: "PULSO",
    components: Object.freeze(["pulso-iris", "integrations"]),
    roles: Object.freeze(["admin", "coordinator", "advisor", "auditor"]),
    capabilities: Object.freeze(["pulso:read", "pulso:write", "pulso:admin"]),
    adminCapability: "pulso:admin"
  })
]);

const PRODUCT_BY_ID = new Map(LEGACY_PRODUCTS.map((product) => [product.productId, product]));
const PRODUCT_BY_COMPONENT = new Map(
  LEGACY_PRODUCTS.flatMap((product) => product.components.map((component) => [component, product] as const))
);

const UNSCOPED_PRODUCT_PATHS = new Map<string, LegacyCustomerProductId>([
  ["/v1/nova/health", "NOVA"],
  ["/v1/nova/catalog", "NOVA"],
  ["/v1/voice/health", "NOVA"],
  ["/v1/liwa/health", "NOVA"],
  ["/v1/documents/health", "NOVA"],
  ["/v1/lumen/health", "LUMEN"],
  ["/v1/lumen/catalog", "LUMEN"],
  ["/v1/pulso-iris/health", "PULSO_IRIS"],
  ["/v1/pulso-iris/catalog", "PULSO_IRIS"]
]);

function tenantRoute(
  productId: LegacyCustomerProductId,
  method: LegacyHttpMethod,
  component: string,
  suffix: string,
  capability: string,
  roles?: readonly string[],
  resources?: readonly string[]
): LegacyTenantRoutePolicy {
  return Object.freeze({
    method,
    path: `/v1/tenants/:tenantId/${component}/${suffix}`,
    productId,
    capability,
    ...(roles ? { roles } : {}),
    ...(resources ? { resources } : {})
  });
}

const NOVA_SUPERVISION_ROLES = Object.freeze(["admin", "supervisor"]);
const NOVA_ADMIN_ROLE = Object.freeze(["admin"]);

const NOVA_TENANT_ROUTES: readonly LegacyTenantRoutePolicy[] = Object.freeze([
  tenantRoute("NOVA", "GET", "nova", "catalog", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "dashboard", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "contacts", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "campaigns", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "leads", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "handoffs", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "conversations", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "conversations/:id/messages", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "core/associates/:documentId", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "conversations/:conversationId/channel-status", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "reviews", "nova:read"),
  tenantRoute("NOVA", "GET", "nova", "analytics/daily", "nova:read"),
  tenantRoute("NOVA", "POST", "nova", "contacts/import", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "contacts/import/file", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "contacts/:contactId/score", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "contacts/:contactId/eligibility", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "campaigns", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "campaigns/:id/enroll", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "campaigns/:id/start", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "campaigns/:id/pause", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "campaigns/:id/cancel", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "PATCH", "nova", "leads/:id", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "handoffs/:id/claim", "nova:write"),
  tenantRoute("NOVA", "POST", "nova", "conversations/:id/claim", "nova:write"),
  tenantRoute("NOVA", "POST", "nova", "conversations/:id/release", "nova:write"),
  tenantRoute("NOVA", "POST", "nova", "conversations/:id/reply", "nova:write"),
  tenantRoute("NOVA", "POST", "nova", "outcomes", "nova:write"),
  tenantRoute("NOVA", "POST", "nova", "reviews", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "nova", "reviews/:reviewId/decide", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "GET", "nova", "compliance/settings", "nova:read", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "PUT", "nova", "compliance/settings", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "GET", "nova", "agent-configs", "nova:read", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "GET", "nova", "agent-configs/:productFlow", "nova:read", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "PUT", "nova", "agent-configs", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "PUT", "nova", "agent-configs/:productFlow", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "POST", "nova", "bootstrap", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "POST", "nova", "lab/liwa-event", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "GET", "nova", "outbox/dlq", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "POST", "nova", "outbox/dlq/:eventId/redrive", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "POST", "voice", "calls", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "voice", "campaigns", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "GET", "voice", "campaigns", "nova:read"),
  tenantRoute("NOVA", "GET", "voice", "campaigns/:campaignId/stats", "nova:read"),
  tenantRoute("NOVA", "POST", "voice", "campaigns/:campaignId/start", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "voice", "campaigns/:campaignId/pause", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "voice", "campaigns/:campaignId/stop", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "POST", "voice", "campaigns/:campaignId/cancel", "nova:write", NOVA_SUPERVISION_ROLES),
  tenantRoute("NOVA", "GET", "voice", "calls/reconciliation", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "POST", "voice", "calls/:callId/reconcile", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "GET", "voice", "outbox/dlq", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "POST", "voice", "outbox/dlq/:eventId/redrive", "nova:admin", NOVA_ADMIN_ROLE),
  tenantRoute("NOVA", "POST", "liwa", "send", "nova:write"),
  tenantRoute("NOVA", "POST", "liwa", "conversations/:id/reply", "nova:write"),
  tenantRoute("NOVA", "POST", "documents", "upload", "nova:write"),
  tenantRoute("NOVA", "GET", "documents", ":id", "nova:read")
]);

const LUMEN_TENANT_ROUTES: readonly LegacyTenantRoutePolicy[] = Object.freeze([
  tenantRoute("LUMEN", "GET", "lumen", "worklist", "lumen:read"),
  tenantRoute("LUMEN", "GET", "lumen", "encounters/:encounterId", "lumen:read"),
  tenantRoute("LUMEN", "POST", "lumen", "encounters/:encounterId/start", "lumen:write"),
  tenantRoute("LUMEN", "POST", "lumen", "encounters/:encounterId/transcriptions", "lumen:write"),
  tenantRoute("LUMEN", "POST", "lumen", "encounters/:encounterId/structure", "lumen:write"),
  tenantRoute("LUMEN", "PATCH", "lumen", "encounters/:encounterId/record", "lumen:write"),
  tenantRoute("LUMEN", "POST", "lumen", "encounters/:encounterId/approve", "lumen:write")
]);

const PULSO_OPERATION_ROLES = Object.freeze(["admin", "coordinator", "advisor"]);
const PULSO_COORDINATION_ROLES = Object.freeze(["admin", "coordinator"]);
const PULSO_CONFIG_READ_ROLES = Object.freeze(["admin", "coordinator", "auditor"]);
const PULSO_ADMIN_ROLE = Object.freeze(["admin"]);
const PULSO_CONFIG_RESOURCES = Object.freeze([
  "professionals",
  "professional-sites",
  "professional-appointment-types",
  "availability-rules",
  "payer-exclusions",
  "agenda-blocks"
]);

function pulsoCoreRoute(
  method: LegacyHttpMethod,
  suffix: string,
  capability: string,
  roles?: readonly string[],
  resources?: readonly string[]
): LegacyTenantRoutePolicy {
  return tenantRoute("PULSO_IRIS", method, "pulso-iris", suffix, capability, roles, resources);
}

const PULSO_TENANT_ROUTES: readonly LegacyTenantRoutePolicy[] = Object.freeze([
  pulsoCoreRoute("GET", "overview", "pulso:read"),
  pulsoCoreRoute("GET", "conversations", "pulso:read"),
  pulsoCoreRoute("GET", "appointments", "pulso:read"),
  pulsoCoreRoute("GET", "handoffs", "pulso:read"),
  pulsoCoreRoute("GET", "rpa/actions", "pulso:read"),
  pulsoCoreRoute("GET", "dashboard/live", "pulso:read"),
  pulsoCoreRoute("GET", "agenda/week", "pulso:read"),
  pulsoCoreRoute("GET", "conversations/:conversationId/timeline", "pulso:read"),
  pulsoCoreRoute("GET", "conversations/inbox", "pulso:read"),
  pulsoCoreRoute("GET", "rpa/status", "pulso:read"),
  pulsoCoreRoute("GET", "campaigns", "pulso:read"),
  pulsoCoreRoute("GET", "bi/monthly", "pulso:read"),
  pulsoCoreRoute("GET", "appointment-holds", "pulso:read"),
  pulsoCoreRoute("GET", "appointments/queue", "pulso:read"),
  pulsoCoreRoute("GET", "appointments/:appointmentId/history", "pulso:read"),
  pulsoCoreRoute("GET", "appointments/:appointmentId/audit", "pulso:read"),
  pulsoCoreRoute("GET", "availability/slots", "pulso:read"),
  pulsoCoreRoute("POST", "appointment-holds", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("POST", "appointment-holds/:holdId/cancel", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("POST", "appointments", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("POST", "appointments/:appointmentId/manual-verify", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("POST", "appointments/:appointmentId/reject", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("POST", "appointments/:appointmentId/cancel", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("POST", "appointments/:appointmentId/reschedule", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "appointments/:appointmentId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("POST", "patients", "pulso:admin", PULSO_ADMIN_ROLE),
  pulsoCoreRoute("POST", "conversations", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("POST", "conversations/:conversationId/messages", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("PATCH", "conversations/:conversationId", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("POST", "handoffs", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("PATCH", "handoffs/:handoffId", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("POST", "rpa/actions", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "rpa/actions/:actionId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("POST", "campaigns", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "campaigns/:campaignId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("POST", "waitlist", "pulso:write", PULSO_OPERATION_ROLES),
  pulsoCoreRoute("GET", "config/agenda-settings", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("PATCH", "config/agenda-settings", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/professional-sites", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/professional-sites", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/professional-sites/:relationId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/professional-appointment-types", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/professional-appointment-types", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/professional-appointment-types/:relationId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute(
    "GET",
    "config/import/:resource/template",
    "pulso:read",
    PULSO_CONFIG_READ_ROLES,
    PULSO_CONFIG_RESOURCES
  ),
  pulsoCoreRoute(
    "POST",
    "config/import/:resource/preview",
    "pulso:write",
    PULSO_COORDINATION_ROLES,
    PULSO_CONFIG_RESOURCES
  ),
  pulsoCoreRoute(
    "POST",
    "config/import/:resource/apply",
    "pulso:write",
    PULSO_COORDINATION_ROLES,
    PULSO_CONFIG_RESOURCES
  ),
  pulsoCoreRoute("GET", "config/export/:resource", "pulso:read", PULSO_CONFIG_READ_ROLES, PULSO_CONFIG_RESOURCES),
  pulsoCoreRoute("GET", "config/sites", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/sites", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/sites/:siteId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/professionals", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/professionals", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/professionals/:professionalId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/payers", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/payers", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/payers/:payerId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/appointment-types", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/appointment-types", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/appointment-types/:appointmentTypeId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/availability-rules", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/availability-rules", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/availability-rules/:ruleId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/agenda-blocks", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/agenda-blocks", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/agenda-blocks/:blockId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/holidays", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/holidays", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/holidays/:holidayId", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/payer-exclusions", "pulso:read", PULSO_CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/payer-exclusions", "pulso:write", PULSO_COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/payer-exclusions/:exclusionId", "pulso:write", PULSO_COORDINATION_ROLES),
  tenantRoute("PULSO_IRIS", "GET", "integrations", "whatsapp/status", "pulso:read", PULSO_COORDINATION_ROLES),
  tenantRoute("PULSO_IRIS", "POST", "integrations", "whatsapp/connect", "pulso:admin", PULSO_ADMIN_ROLE),
  tenantRoute("PULSO_IRIS", "GET", "integrations", "whatsapp/qr", "pulso:admin", PULSO_ADMIN_ROLE),
  tenantRoute("PULSO_IRIS", "POST", "integrations", "whatsapp/disconnect", "pulso:admin", PULSO_ADMIN_ROLE),
  pulsoCoreRoute("GET", "sofia/readiness", "pulso:read", PULSO_COORDINATION_ROLES)
]);

export const LEGACY_TENANT_ROUTE_POLICIES: readonly LegacyTenantRoutePolicy[] = Object.freeze([
  ...NOVA_TENANT_ROUTES,
  ...LUMEN_TENANT_ROUTES,
  ...PULSO_TENANT_ROUTES
]);

export function readLegacyProductRequestScope(path: string): LegacyProductRequestScope | undefined {
  const tenantMatch = path.match(/^\/v1\/tenants\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (tenantMatch) {
    const product = PRODUCT_BY_COMPONENT.get(tenantMatch[2] ?? "");
    if (!product) return undefined;
    return { productId: product.productId, tenantId: decodeURIComponent(tenantMatch[1] ?? "") };
  }

  const productId = UNSCOPED_PRODUCT_PATHS.get(path);
  return productId ? { productId } : undefined;
}

export function isLegacyCustomerProductId(productId: string): productId is LegacyCustomerProductId {
  return PRODUCT_BY_ID.has(productId as LegacyCustomerProductId);
}

export function authorizeLegacyProductRequest(
  method: LegacyHttpMethod,
  path: string,
  principal: AccessPrincipal
): LegacyProductAuthorizationDenial | undefined {
  const scope = readLegacyProductRequestScope(path);
  if (!scope) return undefined;

  if (!scope.tenantId) {
    const hasProductGrant = principal.grants.some((grant) => grant.active && grant.productId === scope.productId);
    return hasProductGrant ? undefined : { statusCode: 403, message: `${scope.productId} grant required` };
  }

  const tenantId = tenantIdSchema.safeParse(scope.tenantId);
  if (!tenantId.success) return { statusCode: 400, message: "tenantId must be a UUID" };

  const product = PRODUCT_BY_ID.get(scope.productId)!;
  const policy = LEGACY_TENANT_ROUTE_POLICIES.find(
    (candidate) =>
      candidate.productId === scope.productId && matchExactRoutePolicy(candidate, method, path) !== undefined
  );
  if (!policy) return { statusCode: 404, message: `Route is not part of the ${product.cellLabel} cell` };

  const grant = findValidSnapshotGrant(principal, tenantId.data, product);
  if (!grant) return { statusCode: 403, message: `${scope.productId} grant required for this tenant` };

  if (!grant.capabilities.includes(product.adminCapability) && !grant.capabilities.includes(policy.capability)) {
    return { statusCode: 403, message: `${policy.capability} capability required` };
  }
  if (policy.roles && !policy.roles.some((role) => grant.roles.includes(role))) {
    return { statusCode: 403, message: `${product.roleLabel} role is not allowed for this operation` };
  }
  return undefined;
}

function findValidSnapshotGrant(
  principal: AccessPrincipal,
  tenantId: string,
  product: LegacyProductDefinition
): ProductGrant | undefined {
  return principal.grants.find(
    (grant) =>
      grant.active &&
      grant.tenantId === tenantId &&
      grant.productId === product.productId &&
      grant.roles.length > 0 &&
      grant.capabilities.length > 0 &&
      grant.roles.every((role) => product.roles.includes(role)) &&
      grant.capabilities.every((capability) => product.capabilities.includes(capability))
  );
}
