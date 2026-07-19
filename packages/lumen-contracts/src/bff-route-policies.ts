import type { LumenCapability } from "./index.js";

export interface LumenBffTenantRoutePolicy {
  method: "GET" | "POST" | "PATCH";
  path: string;
  upstream: "lumen";
  capability: LumenCapability;
}

export const LUMEN_BFF_PUBLIC_ROUTE_POLICIES = Object.freeze({
  productHealth: { method: "GET", path: "/v1/lumen/health" },
  login: { method: "POST", path: "/v1/auth/login" },
  me: { method: "GET", path: "/v1/auth/me" },
  session: { method: "GET", path: "/v1/auth/session" },
  logout: { method: "POST", path: "/v1/auth/logout" },
  tenants: { method: "GET", path: "/v1/tenants" }
} as const);

/** Provider-owned exact customer route allowlist shared with the N-1 facade. */
export const LUMEN_BFF_TENANT_ROUTE_POLICIES: readonly LumenBffTenantRoutePolicy[] = Object.freeze([
  {
    method: "GET",
    path: "/v1/tenants/:tenantId/lumen/worklist",
    upstream: "lumen",
    capability: "lumen:read"
  },
  {
    method: "GET",
    path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId",
    upstream: "lumen",
    capability: "lumen:read"
  },
  {
    method: "POST",
    path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/start",
    upstream: "lumen",
    capability: "lumen:write"
  },
  {
    method: "POST",
    path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/transcriptions",
    upstream: "lumen",
    capability: "lumen:write"
  },
  {
    method: "POST",
    path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/structure",
    upstream: "lumen",
    capability: "lumen:write"
  },
  {
    method: "PATCH",
    path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/record",
    upstream: "lumen",
    capability: "lumen:write"
  },
  {
    method: "POST",
    path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/approve",
    upstream: "lumen",
    capability: "lumen:write"
  }
]);

export const LUMEN_BFF_EXACT_ROUTE_POLICIES = Object.freeze({
  productHealth: { ...LUMEN_BFF_PUBLIC_ROUTE_POLICIES.productHealth, upstream: "lumen" as const },
  tenantRoutes: LUMEN_BFF_TENANT_ROUTE_POLICIES
});
