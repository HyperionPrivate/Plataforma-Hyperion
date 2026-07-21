import { randomUUID } from "node:crypto";

/**
 * Smoke E2E NOVA (real). Requiere servicios levantados y credenciales locales.
 * Flujo: bootstrap → import → eligibility → score → campaign → voice (si dialer) → reviews/dashboard.
 *
 * Uso:
 *   node scripts/autonomy/nova-smoke.e2e.mjs
 *
 * Variables:
 *   NOVA_SMOKE_BASE_URL (default http://localhost:8080)
 *   NOVA_SMOKE_EMAIL (operador NOVA admin/supervisor)
 *   NOVA_SMOKE_PASSWORD
 *   NOVA_SMOKE_TENANT_ID (UUID)
 */

const baseUrl = (process.env.NOVA_SMOKE_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const email = process.env.NOVA_SMOKE_EMAIL;
const password = process.env.NOVA_SMOKE_PASSWORD;
const tenantId = process.env.NOVA_SMOKE_TENANT_ID;

if (!email || !password || !tenantId) {
  console.error("NOVA_SMOKE_EMAIL, NOVA_SMOKE_PASSWORD and NOVA_SMOKE_TENANT_ID are required");
  process.exit(64);
}

let browserCookie = "";
let csrfToken = "";

async function authenticate() {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-requested-with": "nova-console"
    },
    body: JSON.stringify({ email, password }),
    redirect: "error"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`POST /v1/auth/login -> ${response.status}: ${JSON.stringify(payload)}`);
  }

  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("set-cookie")?.split(/,(?=\s*__Host-)/) ?? []);
  const session = cookiePair(setCookies, "__Host-hyperion-nova-session");
  const csrf = cookiePair(setCookies, "__Host-hyperion-nova-csrf");
  if (!session || !csrf) throw new Error("NOVA login did not issue the isolated session and CSRF cookies");
  browserCookie = `${session}; ${csrf}`;
  csrfToken = decodeURIComponent(csrf.slice(csrf.indexOf("=") + 1));
}

function cookiePair(setCookies, name) {
  const prefix = `${name}=`;
  const matching = setCookies.filter((cookie) => cookie.trimStart().startsWith(prefix));
  if (matching.length !== 1) return undefined;
  return matching[0].trim().split(";", 1)[0];
}

async function call(method, path, body, { allowStatuses = [] } = {}) {
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      cookie: browserCookie,
      ...(mutation ? { "x-csrf-token": csrfToken } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !allowStatuses.includes(response.status)) {
    throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return { status: response.status, data: payload.data ?? payload };
}

const phone = `+57300${String(Date.now()).slice(-7)}`;

console.log("0) isolated browser session");
await authenticate();

let forbiddenTenantId = randomUUID();
while (forbiddenTenantId === tenantId) forbiddenTenantId = randomUUID();
const forbidden = await call("GET", `/v1/tenants/${forbiddenTenantId}/nova/dashboard`, undefined, {
  allowStatuses: [403]
});
if (forbidden.status !== 403) throw new Error(`foreign tenant grant probe returned ${forbidden.status}, expected 403`);
const foreignRoute = await call("GET", `/v1/tenants/${tenantId}/lumen/encounters`, undefined, {
  allowStatuses: [404]
});
if (foreignRoute.status !== 404) throw new Error(`foreign product route returned ${foreignRoute.status}, expected 404`);

console.log("1) bootstrap");
await call("POST", `/v1/tenants/${tenantId}/nova/bootstrap`, { display_name: "Coopfuturo smoke" });

console.log("2) import");
const imported = await call("POST", `/v1/tenants/${tenantId}/nova/contacts/import`, {
  contacts: [{ phone_e164: phone, full_name: "Smoke Contact", agency_code: "BGA" }]
});
const contactId = imported.data.contacts?.[0]?.contact_id ?? imported.data[0]?.contact_id;
if (!contactId) throw new Error("import did not return contact_id");

console.log("3) eligibility + score");
await call("POST", `/v1/tenants/${tenantId}/nova/contacts/${contactId}/eligibility`, {});
await call("POST", `/v1/tenants/${tenantId}/nova/contacts/${contactId}/score`, { auto: true });

console.log("4) campaign enroll + start (emits voice.call.requested.v2 with contact_id)");
const campaign = await call("POST", `/v1/tenants/${tenantId}/nova/campaigns`, {
  name: `smoke-${Date.now()}`,
  channel: "voice",
  product_flow: "renovacion"
});
await call("POST", `/v1/tenants/${tenantId}/nova/campaigns/${campaign.data.campaign_id}/enroll`, {
  contact_ids: [contactId]
});
await call("POST", `/v1/tenants/${tenantId}/nova/campaigns/${campaign.data.campaign_id}/start`, {});

console.log("5) individual call authorization through NOVA Core");
const voiceCall = await call(
  "POST",
  `/v1/tenants/${tenantId}/nova/contacts/${contactId}/calls`,
  {
    product_flow: "renovacion"
  },
  { allowStatuses: [409] }
);

let correlatedContactId = null;
let callId = null;
if (voiceCall.status < 400) {
  correlatedContactId = voiceCall.data.contact_id;
  callId = voiceCall.data.call_id;
  if (correlatedContactId !== contactId) {
    throw new Error(`voice call missing contact correlation: expected ${contactId}, got ${correlatedContactId}`);
  }
  if (!callId) throw new Error("voice call did not return call_id");
} else {
  console.log("   (manual authorization blocked by the current compliance/frequency policy)");
}

console.log("6) reviews + analytics + dashboard");
const reviews = await call("GET", `/v1/tenants/${tenantId}/nova/reviews`);
const analytics = await call("GET", `/v1/tenants/${tenantId}/nova/analytics/daily`, undefined, {
  allowStatuses: [404]
});
const dashboard = await call("GET", `/v1/tenants/${tenantId}/nova/dashboard`);

console.log(
  JSON.stringify(
    {
      ok: true,
      phone,
      contactId,
      callId,
      correlatedContactId,
      reviewsCount: Array.isArray(reviews.data) ? reviews.data.length : (reviews.data?.items?.length ?? 0),
      analyticsStatus: analytics.status,
      dashboard: dashboard.data
    },
    null,
    2
  )
);
