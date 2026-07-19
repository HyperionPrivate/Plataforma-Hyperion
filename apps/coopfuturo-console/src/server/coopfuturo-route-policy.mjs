const EXACT_ROUTES = new Set([
  "GET auth/session",
  "POST auth/login",
  "POST auth/logout",
  "GET ops/dashboard",
  "GET ops/campaigns",
  "POST ops/campaigns",
  "GET ops/conversations",
  "GET ops/crm",
  "GET ops/handoff",
  "GET ops/segmentation",
  "GET ops/whatsapp/flows",
  "GET ops/whatsapp/pending",
  "POST ops/whatsapp/pending/send",
  "POST ops/whatsapp/pending/skip",
  "GET ops/whatsapp/status",
  "POST ops/whatsapp/send",
  "GET ops/compliance/opt-outs",
  "POST ops/compliance/opt-out",
  "GET ops/documents",
  "POST ops/documents",
  "POST ops/documents/upload",
  "GET ops/settings",
  "PUT ops/settings",
  "GET ops/auth/status",
  "POST ops/contacts/import",
  "POST ops/calls/dispatch",
  "POST ops/calls/complete",
  "POST ops/orchestration/attempt",
  "POST ops/orchestration/batch",
  "POST ops/laboratorio/liwa-event",
  "POST ops/webhooks/liwa/simulate",
  "POST ops/e2e/renovacion",
  "POST ops/e2e/reactivacion",
  "POST ops/e2e/campaign",
  "POST ops/conversations/messages",
  "POST ops/conversations/claim",
  "POST ops/conversations/release",
  "POST ops/crm/move",
  "POST ops/handoff",
]);

const DYNAMIC_ROUTES = [
  /^GET ops\/reports\/[A-Za-z0-9_-]+$/,
  /^GET ops\/conversations\/[A-Za-z0-9_-]+\/liwa-status$/,
  /^GET ops\/core\/associate\/[A-Za-z0-9_-]+$/,
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UNAVAILABLE_OPERATIONS = new Set([
  "GET ops/segmentation",
  "GET ops/whatsapp/flows",
  "GET ops/whatsapp/status",
  "GET ops/compliance/opt-outs",
  "POST ops/compliance/opt-out",
  "GET ops/documents",
  "POST ops/documents",
  "GET ops/settings",
  "PUT ops/settings",
  "GET ops/auth/status",
  "POST ops/orchestration/batch",
  "POST ops/handoff",
]);

export function configuredCoopfuturoTenant(environment) {
  const raw = environment?.COOPFUTURO_TENANT_ID;
  const tenantId = typeof raw === "string" ? raw.trim() : "";
  if (!tenantId) return { tenantId: null, reason: "missing" };
  if (!UUID_PATTERN.test(tenantId)) return { tenantId: null, reason: "invalid" };
  return { tenantId: tenantId.toLowerCase(), reason: null };
}

export function configuredCoopfuturoPublicOrigin(environment) {
  const raw = environment?.COOPFUTURO_PUBLIC_ORIGIN;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { origin: null, reason: "missing" };
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return { origin: null, reason: "invalid" };
    }
    const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !isLoopback) {
      return { origin: null, reason: "insecure" };
    }
    return { origin: parsed.origin, reason: null };
  } catch {
    return { origin: null, reason: "invalid" };
  }
}

export function isAllowedCoopfuturoMutationOrigin(method, originHeader, secFetchSite, publicOrigin) {
  const normalizedMethod = String(method).toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") return true;
  if (secFetchSite === "cross-site") return false;
  if (typeof originHeader !== "string" || !originHeader.trim()) return false;
  if (typeof publicOrigin !== "string" || !publicOrigin) return false;
  try {
    const requestOrigin = new URL(originHeader.trim());
    if (
      requestOrigin.username ||
      requestOrigin.password ||
      requestOrigin.pathname !== "/" ||
      requestOrigin.search ||
      requestOrigin.hash
    ) {
      return false;
    }
    return requestOrigin.origin === publicOrigin;
  } catch {
    return false;
  }
}

export function isUnavailableCoopfuturoOperation(method, slugParts) {
  if (!Array.isArray(slugParts)) return false;
  return UNAVAILABLE_OPERATIONS.has(`${String(method).toUpperCase()} ${slugParts.join("/")}`);
}

export function normalizeCustomerUpstreamStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

export function selectBoundNovaTenant(grants, configuredTenantId) {
  if (typeof configuredTenantId !== "string" || !UUID_PATTERN.test(configuredTenantId)) {
    return { tenantId: null, reason: "unconfigured" };
  }
  if (!Array.isArray(grants)) return { tenantId: null, reason: "missing" };
  const ids = [
    ...new Set(
      grants
        .filter((grant) => grant?.active === true && grant?.productId === "NOVA")
        .map((grant) => grant.tenantId)
        .filter((tenantId) => typeof tenantId === "string" && UUID_PATTERN.test(tenantId)),
      ),
  ];
  return ids.includes(configuredTenantId)
    ? { tenantId: configuredTenantId, reason: null }
    : { tenantId: null, reason: "missing" };
}

export function customerBoundPrincipal(principal, configuredTenantId) {
  if (!principal || typeof principal !== "object") return null;
  const grants = principal.grants;
  const selection = selectBoundNovaTenant(grants, configuredTenantId);
  if (!selection.tenantId) return null;
  const customerGrant = grants.find(
    (grant) =>
      grant?.active === true &&
      grant?.productId === "NOVA" &&
      grant?.tenantId === configuredTenantId,
  );
  return customerGrant ? { ...principal, grants: [customerGrant] } : null;
}

/**
 * Customer-facing policy. Unknown methods and paths are denied before a session
 * lookup or upstream request, so another product can never tunnel through it.
 */
export function isAllowedCoopfuturoRoute(method, slugParts) {
  const normalizedMethod = String(method).toUpperCase();
  if (!Array.isArray(slugParts) || slugParts.length === 0) return false;
  if (
    slugParts.some(
      (part) =>
        typeof part !== "string" ||
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(part),
    )
  ) {
    return false;
  }
  const route = `${normalizedMethod} ${slugParts.join("/")}`;
  return EXACT_ROUTES.has(route) || DYNAMIC_ROUTES.some((pattern) => pattern.test(route));
}
