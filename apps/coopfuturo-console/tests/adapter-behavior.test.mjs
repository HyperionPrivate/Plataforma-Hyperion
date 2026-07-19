import assert from "node:assert/strict";
import test, { after } from "node:test";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ID = "22222222-2222-4222-8222-222222222222";
const PUBLIC_ORIGIN = "https://coopfuturo.example.com:8443";
const originalFetch = globalThis.fetch;
const originalEnvironment = {
  COOPFUTURO_TENANT_ID: process.env.COOPFUTURO_TENANT_ID,
  COOPFUTURO_PUBLIC_ORIGIN: process.env.COOPFUTURO_PUBLIC_ORIGIN,
  NOVA_BFF_URL: process.env.NOVA_BFF_URL,
};

process.env.COOPFUTURO_TENANT_ID = TENANT_ID;
process.env.COOPFUTURO_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
process.env.NOVA_BFF_URL = "http://nova-bff.test";

const { handleCoopfuturoNovaRequest } = await import(
  "../src/server/coopfuturo-nova-adapter.ts"
);

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function envelope(data, status = 200) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulData(url) {
  const parsed = new URL(url);
  if (parsed.pathname === "/v1/auth/me") {
    return {
      operator: { id: OPERATOR_ID },
      grants: [{ active: true, productId: "NOVA", tenantId: TENANT_ID }],
    };
  }
  if (parsed.pathname.endsWith("/dashboard")) return {};
  if (parsed.pathname.endsWith("/contacts")) return { items: [] };
  return [];
}

function customerRequest(slugParts, method = "GET", body) {
  const headers = {
    Cookie: "__Host-hyperion-coopfuturo-session=opaque-session",
    ...(method === "GET"
      ? {}
      : {
          Origin: PUBLIC_ORIGIN,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "X-CSRF-Token": "opaque-csrf",
        }),
  };
  return new Request(`${PUBLIC_ORIGIN}/pilot-core/${slugParts.join("/")}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function invokeWithFailure({
  slugParts,
  failurePath,
  status,
  method = "GET",
  body,
  reject = false,
}) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes(failurePath)) {
      if (reject) throw new Error("simulated transport failure");
      return envelope({ error: `upstream ${status}` }, status);
    }
    return envelope(successfulData(url));
  };
  const response = await handleCoopfuturoNovaRequest(
    customerRequest(slugParts, method, body),
    slugParts,
  );
  return { response, calls };
}

test("aggregate, dynamic, and mutation routes preserve upstream failures", async (t) => {
  const cases = [
    {
      name: "dashboard 401",
      slugParts: ["ops", "dashboard"],
      failurePath: "/nova/dashboard",
      status: 401,
    },
    {
      name: "campaign analytics 403",
      slugParts: ["ops", "campaigns"],
      failurePath: "/nova/analytics/daily",
      status: 403,
    },
    {
      name: "conversation list 429",
      slugParts: ["ops", "conversations"],
      failurePath: "/nova/conversations",
      status: 429,
    },
    {
      name: "CRM contacts 500",
      slugParts: ["ops", "crm"],
      failurePath: "/nova/contacts?limit=200",
      status: 500,
    },
    {
      name: "handoff queue 503",
      slugParts: ["ops", "handoff"],
      failurePath: "/nova/handoffs",
      status: 503,
    },
    {
      name: "pending reviews 401",
      slugParts: ["ops", "whatsapp", "pending"],
      failurePath: "/nova/reviews",
      status: 401,
    },
    {
      name: "report leads 403",
      slugParts: ["ops", "reports", "semanal"],
      failurePath: "/nova/leads",
      status: 403,
    },
    {
      name: "conversation channel status 429",
      slugParts: ["ops", "conversations", "abc-123", "liwa-status"],
      failurePath: "/channel-status",
      status: 429,
    },
    {
      name: "LIWA lab 500",
      slugParts: ["ops", "laboratorio", "liwa-event"],
      failurePath: "/nova/lab/liwa-event",
      status: 500,
      method: "POST",
      body: { event: "test" },
    },
    {
      name: "dashboard transport failure",
      slugParts: ["ops", "dashboard"],
      failurePath: "/nova/analytics/daily",
      status: 502,
      reject: true,
    },
    {
      name: "session validation 429",
      slugParts: ["ops", "dashboard"],
      failurePath: "/v1/auth/me",
      status: 429,
    },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const { response, calls } = await invokeWithFailure(current);
      assert.equal(response.status, current.status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const payload = await response.json();
      assert.equal(typeof payload.error, "string");
      assert.equal("items" in payload, false);
      assert.equal("conversations" in payload, false);
      const meCall = calls.find((call) => call.url.endsWith("/v1/auth/me"));
      assert(meCall);
      assert.match(
        String(meCall.init?.headers?.Cookie ?? ""),
        /__Host-hyperion-nova-session=opaque-session/,
      );
      assert.doesNotMatch(
        String(meCall.init?.headers?.Cookie ?? ""),
        /__Host-hyperion-coopfuturo-session/,
      );
    });
  }
});

test("unbacked operations return 501 after customer authorization", async () => {
  globalThis.fetch = async (input) => envelope(successfulData(String(input)));
  const routes = [
    ["GET", ["ops", "segmentation"]],
    ["GET", ["ops", "documents"]],
    ["POST", ["ops", "handoff"]],
    ["PUT", ["ops", "settings"]],
  ];
  for (const [method, slugParts] of routes) {
    const response = await handleCoopfuturoNovaRequest(
      customerRequest(slugParts, method, method === "GET" ? undefined : {}),
      slugParts,
    );
    assert.equal(response.status, 501, `${method} ${slugParts.join("/")}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("mutations cannot use a missing Origin or a forged forwarded host", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async (input) => {
    fetchCalls += 1;
    return envelope(successfulData(String(input)));
  };
  const missingOrigin = new Request(`${PUBLIC_ORIGIN}/pilot-core/ops/handoff`, {
    method: "POST",
    headers: { Cookie: "__Host-hyperion-coopfuturo-session=opaque-session" },
    body: "{}",
  });
  const forgedForwardedHost = new Request(`${PUBLIC_ORIGIN}/pilot-core/ops/handoff`, {
    method: "POST",
    headers: {
      Cookie: "__Host-hyperion-coopfuturo-session=opaque-session",
      Origin: "https://attacker.example",
      "X-Forwarded-Host": "coopfuturo.example.com:8443",
    },
    body: "{}",
  });

  assert.equal(
    (await handleCoopfuturoNovaRequest(missingOrigin, ["ops", "handoff"])).status,
    403,
  );
  assert.equal(
    (await handleCoopfuturoNovaRequest(forgedForwardedHost, ["ops", "handoff"])).status,
    403,
  );
  assert.equal(fetchCalls, 0);
});

test("an E2E request cannot report success when every live step is skipped", async () => {
  globalThis.fetch = async (input) => envelope(successfulData(String(input)));
  const slugParts = ["ops", "e2e", "renovacion"];
  const response = await handleCoopfuturoNovaRequest(
    customerRequest(slugParts, "POST", {
      phone: "+573001112233",
      skip_voice: true,
      skip_whatsapp: true,
    }),
    slugParts,
  );
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "Debe ejecutarse al menos un paso live");
});
