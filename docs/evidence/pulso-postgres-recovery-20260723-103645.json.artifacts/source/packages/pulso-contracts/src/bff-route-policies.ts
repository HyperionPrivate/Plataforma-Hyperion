import type { PulsoCapability, PulsoCellComponent, PulsoCellService, PulsoProductRole } from "./index.js";

export type PulsoBffTenantRouteMethod = "GET" | "POST" | "PATCH";

export interface PulsoBffTenantRoutePolicy {
  method: PulsoBffTenantRouteMethod;
  path: string;
  component: PulsoCellComponent;
  service: PulsoCellService;
  capability: PulsoCapability;
  roles?: readonly PulsoProductRole[];
  resources?: readonly string[];
}

const OPERATION_ROLES = ["admin", "coordinator", "advisor"] as const satisfies readonly PulsoProductRole[];
const COORDINATION_ROLES = ["admin", "coordinator"] as const satisfies readonly PulsoProductRole[];
const CONFIG_READ_ROLES = ["admin", "coordinator", "auditor"] as const satisfies readonly PulsoProductRole[];
const ADMIN_ROLE = ["admin"] as const satisfies readonly PulsoProductRole[];
const PULSO_CONFIG_RESOURCES = [
  "professionals",
  "professional-sites",
  "professional-appointment-types",
  "availability-rules",
  "payer-exclusions",
  "agenda-blocks"
] as const;

function pulsoTenantRoute(
  method: PulsoBffTenantRouteMethod,
  component: PulsoCellComponent,
  suffix: string,
  service: PulsoCellService,
  capability: PulsoCapability,
  roles?: readonly PulsoProductRole[],
  resources?: readonly string[]
): PulsoBffTenantRoutePolicy {
  return {
    method,
    path: `/v1/tenants/:tenantId/${component}/${suffix}`,
    component,
    service,
    capability,
    ...(roles ? { roles } : {}),
    ...(resources ? { resources } : {})
  };
}

function pulsoCoreRoute(
  method: PulsoBffTenantRouteMethod,
  suffix: string,
  capability: PulsoCapability,
  roles?: readonly PulsoProductRole[],
  resources?: readonly string[]
): PulsoBffTenantRoutePolicy {
  return pulsoTenantRoute(method, "pulso-iris", suffix, "core", capability, roles, resources);
}

function pulsoIntegrationRoute(
  method: PulsoBffTenantRouteMethod,
  suffix: string,
  capability: PulsoCapability,
  roles: readonly PulsoProductRole[]
): PulsoBffTenantRoutePolicy {
  return pulsoTenantRoute(method, "integrations", suffix, "integration", capability, roles);
}

/** Provider-owned exact customer route allowlist shared with the N-1 facade. */
export const PULSO_BFF_TENANT_ROUTE_POLICIES: readonly PulsoBffTenantRoutePolicy[] = Object.freeze([
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
  pulsoCoreRoute("POST", "appointment-holds", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("POST", "appointment-holds/:holdId/cancel", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("POST", "appointments", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("POST", "appointments/:appointmentId/manual-verify", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("POST", "appointments/:appointmentId/reject", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("POST", "appointments/:appointmentId/cancel", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("POST", "appointments/:appointmentId/reschedule", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "appointments/:appointmentId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("POST", "patients", "pulso:admin", ADMIN_ROLE),
  pulsoCoreRoute("POST", "conversations", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("POST", "conversations/:conversationId/messages", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("PATCH", "conversations/:conversationId", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("POST", "handoffs", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("PATCH", "handoffs/:handoffId", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("POST", "rpa/actions", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "rpa/actions/:actionId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("POST", "campaigns", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "campaigns/:campaignId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("POST", "waitlist", "pulso:write", OPERATION_ROLES),
  pulsoCoreRoute("GET", "config/agenda-settings", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("PATCH", "config/agenda-settings", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/professional-sites", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/professional-sites", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/professional-sites/:relationId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/professional-appointment-types", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/professional-appointment-types", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/professional-appointment-types/:relationId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/import/:resource/template", "pulso:read", CONFIG_READ_ROLES, PULSO_CONFIG_RESOURCES),
  pulsoCoreRoute("POST", "config/import/:resource/preview", "pulso:write", COORDINATION_ROLES, PULSO_CONFIG_RESOURCES),
  pulsoCoreRoute("POST", "config/import/:resource/apply", "pulso:write", COORDINATION_ROLES, PULSO_CONFIG_RESOURCES),
  pulsoCoreRoute("GET", "config/export/:resource", "pulso:read", CONFIG_READ_ROLES, PULSO_CONFIG_RESOURCES),
  pulsoCoreRoute("GET", "config/sites", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/sites", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/sites/:siteId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/professionals", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/professionals", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/professionals/:professionalId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/payers", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/payers", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/payers/:payerId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/appointment-types", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/appointment-types", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/appointment-types/:appointmentTypeId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/availability-rules", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/availability-rules", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/availability-rules/:ruleId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/agenda-blocks", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/agenda-blocks", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/agenda-blocks/:blockId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/holidays", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/holidays", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/holidays/:holidayId", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("GET", "config/payer-exclusions", "pulso:read", CONFIG_READ_ROLES),
  pulsoCoreRoute("POST", "config/payer-exclusions", "pulso:write", COORDINATION_ROLES),
  pulsoCoreRoute("PATCH", "config/payer-exclusions/:exclusionId", "pulso:write", COORDINATION_ROLES),
  pulsoIntegrationRoute("GET", "whatsapp/status", "pulso:read", COORDINATION_ROLES),
  pulsoIntegrationRoute("POST", "whatsapp/connect", "pulso:admin", ADMIN_ROLE),
  pulsoIntegrationRoute("GET", "whatsapp/qr", "pulso:admin", ADMIN_ROLE),
  pulsoIntegrationRoute("POST", "whatsapp/disconnect", "pulso:admin", ADMIN_ROLE),
  pulsoTenantRoute("GET", "pulso-iris", "sofia/readiness", "integration", "pulso:read", COORDINATION_ROLES)
]);
