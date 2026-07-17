/**
 * Smoke E2E NOVA (real). Requiere servicios levantados y credenciales locales.
 * Flujo: bootstrap → import → eligibility → score → campaign → voice (si dialer) → reviews/dashboard.
 *
 * Uso:
 *   node scripts/autonomy/nova-smoke.e2e.mjs
 *
 * Variables:
 *   NOVA_SMOKE_BASE_URL (default http://localhost:8080)
 *   NOVA_SMOKE_TOKEN (Bearer de operador admin/coordinator)
 *   NOVA_SMOKE_TENANT_ID (UUID)
 *   NOVA_SMOKE_REQUIRE_VOICE=1  (falla si placeCall al dialer no está disponible)
 */

const baseUrl = (process.env.NOVA_SMOKE_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.NOVA_SMOKE_TOKEN;
const tenantId = process.env.NOVA_SMOKE_TENANT_ID;
const requireVoice = process.env.NOVA_SMOKE_REQUIRE_VOICE === "1";

if (!token || !tenantId) {
  console.error("NOVA_SMOKE_TOKEN and NOVA_SMOKE_TENANT_ID are required");
  process.exit(64);
}

async function call(method, path, body, { allowStatuses = [] } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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

console.log("4) campaign enroll + start (emits voice.call.requested with contact_id)");
const campaign = await call("POST", `/v1/tenants/${tenantId}/nova/campaigns`, {
  name: `smoke-${Date.now()}`,
  channel: "voice",
  product_flow: "renovacion"
});
await call("POST", `/v1/tenants/${tenantId}/nova/campaigns/${campaign.data.campaign_id}/enroll`, {
  contact_ids: [contactId]
});
await call("POST", `/v1/tenants/${tenantId}/nova/campaigns/${campaign.data.campaign_id}/start`, {});

console.log("5) individual voice call with contact_id correlation");
const voiceCall = await call(
  "POST",
  `/v1/tenants/${tenantId}/voice/calls`,
  {
    phone_e164: phone,
    contact_id: contactId,
    campaign_id: campaign.data.campaign_id
  },
  { allowStatuses: requireVoice ? [] : [502, 503] }
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
} else if (requireVoice) {
  throw new Error(`voice required but dialer unavailable: ${voiceCall.status}`);
} else {
  console.log("   (dialer unavailable — skipped placeCall; campaign start still correlated via outbox)");
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
