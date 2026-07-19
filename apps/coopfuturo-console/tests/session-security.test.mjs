import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  configuredCoopfuturoPublicOrigin,
  configuredCoopfuturoTenant,
  customerBoundPrincipal,
  isAllowedCoopfuturoMutationOrigin,
  isAllowedCoopfuturoRoute,
  isUnavailableCoopfuturoOperation,
  normalizeCustomerUpstreamStatus,
  selectBoundNovaTenant,
} from "../src/server/coopfuturo-route-policy.mjs";
import {
  COOPFUTURO_CSRF_COOKIE,
  COOPFUTURO_SESSION_COOKIE,
  translateCoopfuturoCookieHeader,
  translateNovaSetCookie,
} from "../src/server/coopfuturo-session-policy.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(appRoot, "src");

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return /\.(?:ts|tsx|mjs)$/.test(entry.name) ? [target] : [];
    }),
  );
  return nested.flat();
}

async function readSources(files) {
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

test("browser code cannot receive or persist an access credential", async () => {
  const files = await sourceFiles(srcRoot);
  const allSource = await readSources(files);
  const browserAppSource = await readSources(
    files.filter(
      (file) =>
        !file.includes(`${path.sep}server${path.sep}`) &&
        !file.includes(`${path.sep}pilot-core${path.sep}`),
    ),
  );
  const envExample = await readFile(path.join(appRoot, ".env.example"), "utf8");
  const browserSource = await readSources([
    path.join(srcRoot, "lib", "auth.ts"),
    path.join(srcRoot, "app", "login", "page.tsx"),
    path.join(srcRoot, "services", "live", "index.ts"),
    path.join(srcRoot, "services", "ops-client.ts"),
  ]);

  assert.doesNotMatch(allSource, /access_token/i);
  assert.doesNotMatch(allSource, /(?:session|local)Storage/);
  assert.doesNotMatch(browserSource, /\bauthorization\b/i);
  assert.doesNotMatch(browserSource, /\bbearer\b/i);
  assert.doesNotMatch(browserSource, /location\.hash|URLSearchParams\([^)]*hash/i);
  assert.doesNotMatch(browserSource, /pegar\s+(?:un\s+)?token|token\s+manual/i);
  assert.doesNotMatch(`${allSource}\n${envExample}`, /response_type\s*=\s*token/i);
  assert.doesNotMatch(`${allSource}\n${envExample}`, /NEXT_PUBLIC_OIDC_AUTHORIZE_URL/);
  assert.doesNotMatch(browserAppSource, /\btenant(?:_id|Id)\s*:/);
});

test("browser requests use same-origin cookies and CSRF", async () => {
  const auth = await readFile(path.join(srcRoot, "lib", "auth.ts"), "utf8");
  const login = await readFile(path.join(srcRoot, "app", "login", "page.tsx"), "utf8");
  const clients = await readSources([
    path.join(srcRoot, "services", "live", "index.ts"),
    path.join(srcRoot, "services", "ops-client.ts"),
  ]);

  assert.match(auth, /return "\/pilot-core"/);
  assert.match(auth, /\/auth\/session/);
  assert.match(auth, /\/auth\/logout/);
  assert.match(auth, /credentials:\s*"include"/);
  assert.match(auth, /X-CSRF-Token/);
  assert.match(login, /credentials:\s*"include"/);
  assert.match(clients, /credentials:\s*"include"/);
  assert.match(clients, /csrf:\s*true/);
});

test("the Next route is thin and the server adapter targets only NOVA_BFF_URL", async () => {
  const route = await readFile(
    path.join(srcRoot, "app", "pilot-core", "[...slug]", "route.ts"),
    "utf8",
  );
  const adapter = await readFile(
    path.join(srcRoot, "server", "coopfuturo-nova-adapter.ts"),
    "utf8",
  );

  assert.ok(route.split(/\r?\n/).length < 30);
  assert.match(route, /handleCoopfuturoNovaRequest/);
  assert.match(adapter, /NOVA_BFF_URL/);
  assert.match(adapter, /auth\/login[\s\S]*\/v1\/auth\/login/);
  assert.match(adapter, /auth\/session[\s\S]*\/v1\/auth\/me/);
  assert.match(adapter, /auth\/logout[\s\S]*\/v1\/auth\/logout/);
  assert.match(adapter, /Cookie:\s*session\.cookie/);
  assert.match(adapter, /X-CSRF-Token/);
  assert.match(adapter, /sec-fetch-site/);
  assert.match(adapter, /Origen no permitido/);
  assert.match(adapter, /COOPFUTURO_PUBLIC_ORIGIN/);
  assert.match(adapter, /isAllowedCoopfuturoMutationOrigin/);
  assert.match(adapter, /Set-Cookie/);
  assert.match(adapter, /COOPFUTURO_TENANT_ID/);
  assert.match(adapter, /customerBoundPrincipal/);
  assert.doesNotMatch(adapter, /HYPERION_GATEWAY_URL/);
  assert.doesNotMatch(adapter, /Authorization\s*:/i);
  assert.doesNotMatch(adapter, /x-forwarded-host/i);
});

test("the customer adapter allowlist rejects foreign and unknown routes", () => {
  assert.equal(isAllowedCoopfuturoRoute("GET", ["auth", "session"]), true);
  assert.equal(isAllowedCoopfuturoRoute("POST", ["auth", "login"]), true);
  assert.equal(isAllowedCoopfuturoRoute("POST", ["auth", "logout"]), true);
  assert.equal(isAllowedCoopfuturoRoute("GET", ["ops", "dashboard"]), true);
  assert.equal(
    isAllowedCoopfuturoRoute("GET", ["ops", "conversations", "abc-123", "liwa-status"]),
    true,
  );
  assert.equal(isAllowedCoopfuturoRoute("POST", ["ops", "e2e", "renovacion"]), true);
  assert.equal(isAllowedCoopfuturoRoute("GET", ["ops", "core", "associate", "900123456"]), true);
  assert.equal(isAllowedCoopfuturoRoute("GET", ["ops", "not-real"]), false);
  assert.equal(isAllowedCoopfuturoRoute("GET", ["lumen", "encounters"]), false);
  assert.equal(isAllowedCoopfuturoRoute("GET", ["pulso-iris", "sites"]), false);
  assert.equal(isAllowedCoopfuturoRoute("DELETE", ["ops", "dashboard"]), false);
  assert.equal(isAllowedCoopfuturoRoute("GET", ["ops", "..", "dashboard"]), false);
});

test("the customer binding is a required server-side UUID", () => {
  const tenantA = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(configuredCoopfuturoTenant({}), { tenantId: null, reason: "missing" });
  assert.deepEqual(configuredCoopfuturoTenant({ COOPFUTURO_TENANT_ID: "coopfuturo" }), {
    tenantId: null,
    reason: "invalid",
  });
  assert.deepEqual(configuredCoopfuturoTenant({ COOPFUTURO_TENANT_ID: ` ${tenantA.toUpperCase()} ` }), {
    tenantId: tenantA,
    reason: null,
  });
});

test("the canonical public origin is server-only, full, and HTTPS outside loopback", () => {
  assert.deepEqual(configuredCoopfuturoPublicOrigin({}), { origin: null, reason: "missing" });
  assert.deepEqual(
    configuredCoopfuturoPublicOrigin({ COOPFUTURO_PUBLIC_ORIGIN: "coopfuturo.example.com" }),
    { origin: null, reason: "invalid" },
  );
  assert.deepEqual(
    configuredCoopfuturoPublicOrigin({ COOPFUTURO_PUBLIC_ORIGIN: "http://coopfuturo.example.com" }),
    { origin: null, reason: "insecure" },
  );
  assert.deepEqual(
    configuredCoopfuturoPublicOrigin({
      COOPFUTURO_PUBLIC_ORIGIN: "https://user:secret@coopfuturo.example.com",
    }),
    { origin: null, reason: "invalid" },
  );
  assert.deepEqual(
    configuredCoopfuturoPublicOrigin({
      COOPFUTURO_PUBLIC_ORIGIN: "https://coopfuturo.example.com/customer?tenant=one",
    }),
    { origin: null, reason: "invalid" },
  );
  assert.deepEqual(
    configuredCoopfuturoPublicOrigin({
      COOPFUTURO_PUBLIC_ORIGIN: " HTTPS://COOPFUTURO.EXAMPLE.COM:443/ ",
    }),
    { origin: "https://coopfuturo.example.com", reason: null },
  );
  assert.deepEqual(
    configuredCoopfuturoPublicOrigin({ COOPFUTURO_PUBLIC_ORIGIN: "http://127.0.0.1:3011" }),
    { origin: "http://127.0.0.1:3011", reason: null },
  );
});

test("every mutation requires an exact scheme-host-port Origin", () => {
  const expected = "https://coopfuturo.example.com:8443";
  assert.equal(isAllowedCoopfuturoMutationOrigin("GET", null, null, expected), true);
  assert.equal(isAllowedCoopfuturoMutationOrigin("POST", null, "same-origin", expected), false);
  assert.equal(
    isAllowedCoopfuturoMutationOrigin("POST", expected, "same-origin", expected),
    true,
  );
  assert.equal(
    isAllowedCoopfuturoMutationOrigin(
      "POST",
      "https://coopfuturo.example.com",
      "same-origin",
      expected,
    ),
    false,
  );
  assert.equal(
    isAllowedCoopfuturoMutationOrigin(
      "POST",
      "http://coopfuturo.example.com:8443",
      "same-origin",
      expected,
    ),
    false,
  );
  assert.equal(
    isAllowedCoopfuturoMutationOrigin("PUT", expected, "cross-site", expected),
    false,
  );
});

test("unbacked operations are explicit 501 candidates and upstream status is preserved", () => {
  for (const [method, route] of [
    ["GET", "ops/segmentation"],
    ["GET", "ops/documents"],
    ["GET", "ops/compliance/opt-outs"],
    ["GET", "ops/settings"],
    ["POST", "ops/orchestration/batch"],
    ["POST", "ops/handoff"],
    ["POST", "ops/compliance/opt-out"],
    ["POST", "ops/documents"],
    ["PUT", "ops/settings"],
  ]) {
    assert.equal(isUnavailableCoopfuturoOperation(method, route.split("/")), true, route);
  }
  assert.equal(isUnavailableCoopfuturoOperation("GET", ["ops", "dashboard"]), false);
  for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
    assert.equal(normalizeCustomerUpstreamStatus(status), status);
  }
  assert.equal(normalizeCustomerUpstreamStatus(200), 502);
  assert.equal(normalizeCustomerUpstreamStatus(302), 502);
  assert.equal(normalizeCustomerUpstreamStatus(undefined), 502);
});

test("the live adapter neither soft-acks missing features nor masks upstream failures", async () => {
  const adapter = await readFile(
    path.join(srcRoot, "server", "coopfuturo-nova-adapter.ts"),
    "utf8",
  );
  assert.match(adapter, /isUnavailableCoopfuturoOperation\(method, slugParts\)/);
  assert.match(adapter, /status:\s*501/);
  assert.match(adapter, /function upstreamFailure/);
  assert.match(adapter, /normalizeCustomerUpstreamStatus\(me\.status\)/);
  assert.doesNotMatch(adapter, /Soft acks/);
  assert.doesNotMatch(adapter, /points:\s*\[\],\s*waves:\s*\[\]/);
  assert.doesNotMatch(adapter, /sent_or_queued:\s*0/);
  assert.doesNotMatch(adapter, /status:\s*"received"/);
  assert.doesNotMatch(adapter, /activeCount:\s*0,\s*conversations:\s*\[\]/);
  assert.match(adapter, /skip_voice === true && body\.skip_whatsapp === true/);
  assert.match(adapter, /Debe ejecutarse al menos un paso live/);
  assert.match(adapter, /dry_run:\s*true/);
});

test("tenant selection accepts only the configured opaque NOVA grant", () => {
  const tenantA = "11111111-1111-4111-8111-111111111111";
  const tenantB = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(
    selectBoundNovaTenant(
      [
      { active: true, productId: "LUMEN", tenantId: tenantB },
      { active: true, productId: "NOVA", tenantId: tenantA },
      { active: true, productId: "NOVA", tenantId: tenantB },
      ],
      tenantA,
    ),
    { tenantId: tenantA, reason: null },
  );
  assert.deepEqual(
    selectBoundNovaTenant([{ active: true, productId: "NOVA", tenantId: tenantB }], tenantA),
    { tenantId: null, reason: "missing" },
  );
  assert.deepEqual(
    selectBoundNovaTenant([{ active: false, productId: "NOVA", tenantId: tenantA }], tenantA),
    { tenantId: null, reason: "missing" },
  );
  assert.deepEqual(
    selectBoundNovaTenant([{ active: true, productId: "NOVA", tenantId: "coopfuturo" }], tenantA),
    { tenantId: null, reason: "missing" },
  );
  assert.deepEqual(
    selectBoundNovaTenant([{ active: true, productId: "NOVA", tenantId: tenantA }], "coopfuturo"),
    { tenantId: null, reason: "unconfigured" },
  );
});

test("the browser principal contains only the bound customer grant", () => {
  const tenantA = "11111111-1111-4111-8111-111111111111";
  const tenantB = "22222222-2222-4222-8222-222222222222";
  const operator = { id: "33333333-3333-4333-8333-333333333333" };
  const grantA = {
    active: true,
    productId: "NOVA",
    tenantId: tenantA,
    capabilities: ["nova:read"],
  };
  const principal = {
    operator,
    grants: [
      grantA,
      { active: true, productId: "NOVA", tenantId: tenantB, capabilities: ["nova:read"] },
      { active: true, productId: "LUMEN", tenantId: tenantA, capabilities: ["lumen:read"] },
    ],
  };
  assert.deepEqual(customerBoundPrincipal(principal, tenantA), {
    operator,
    grants: [grantA],
  });
  assert.equal(customerBoundPrincipal(principal, "44444444-4444-4444-8444-444444444444"), null);
});

test("customer cookies are translated server-side and generic NOVA cookies are ignored", () => {
  const translated = translateCoopfuturoCookieHeader(
    `${COOPFUTURO_SESSION_COOKIE}=signed.jwt.value; ` +
      `${COOPFUTURO_CSRF_COOKIE}=csrf_value; ` +
      "__Host-hyperion-nova-session=foreign.jwt.value; unrelated=value",
  );
  assert.equal(
    translated,
    "__Host-hyperion-nova-session=signed.jwt.value; __Host-hyperion-nova-csrf=csrf_value",
  );
  assert.equal(translateCoopfuturoCookieHeader("__Host-hyperion-nova-session=foreign"), "");
  assert.equal(
    translateCoopfuturoCookieHeader(
      `${COOPFUTURO_SESSION_COOKIE}=first; ${COOPFUTURO_SESSION_COOKIE}=second`,
    ),
    "",
  );
});

test("upstream Set-Cookie is namespaced without weakening its security attributes", () => {
  assert.equal(
    translateNovaSetCookie(
      "__Host-hyperion-nova-session=jwt; Path=/; Max-Age=300; Secure; SameSite=Strict; HttpOnly",
    ),
    `${COOPFUTURO_SESSION_COOKIE}=jwt; Path=/; Max-Age=300; Secure; SameSite=Strict; HttpOnly`,
  );
  assert.equal(
    translateNovaSetCookie(
      "__Host-hyperion-nova-csrf=csrf; Path=/; Max-Age=300; Secure; SameSite=Strict",
    ),
    `${COOPFUTURO_CSRF_COOKIE}=csrf; Path=/; Max-Age=300; Secure; SameSite=Strict`,
  );
  assert.equal(
    translateNovaSetCookie("__Host-hyperion-nova-session=jwt; Path=/; Secure; SameSite=Strict"),
    undefined,
  );
  assert.equal(
    translateNovaSetCookie(
      "__Host-hyperion-nova-session=jwt; Path=/; SameSite=Strict; HttpOnly",
    ),
    undefined,
  );
  assert.equal(
    translateNovaSetCookie(
      "__Host-hyperion-nova-session=jwt; Path=/; Secure; SameSite=Lax; HttpOnly",
    ),
    undefined,
  );
  assert.equal(
    translateNovaSetCookie(
      "__Host-hyperion-nova-session=jwt; Path=/; Domain=example.com; Secure; SameSite=Strict; HttpOnly",
    ),
    undefined,
  );
  assert.equal(
    translateNovaSetCookie("unrelated=value; Path=/; Secure; SameSite=Strict; HttpOnly"),
    undefined,
  );
});

test("browser CSRF lookup uses only the Coopfuturo namespace", async () => {
  const auth = await readFile(path.join(srcRoot, "lib", "auth.ts"), "utf8");
  assert.match(auth, /__Host-hyperion-coopfuturo-csrf/);
  assert.doesNotMatch(auth, /__Host-hyperion-nova-csrf/);
});

test("standalone and coexistence Compose wire the opaque binding server-side", async () => {
  const repositoryRoot = path.resolve(appRoot, "../..");
  const [standalone, coexistence, standaloneEnvironment] = await Promise.all([
    readFile(path.join(repositoryRoot, "infra", "docker-compose.nova.yml"), "utf8"),
    readFile(path.join(repositoryRoot, "infra", "docker-compose.yml"), "utf8"),
    readFile(path.join(repositoryRoot, "infra", "nova.env.example"), "utf8"),
  ]);
  for (const compose of [standalone, coexistence]) {
    const customerService = compose.slice(compose.indexOf("  coopfuturo-console:"));
    assert.match(customerService, /COOPFUTURO_TENANT_ID:\s*\$\{COOPFUTURO_TENANT_ID:-\}/);
    assert.match(
      customerService,
      /COOPFUTURO_PUBLIC_ORIGIN:\s*\$\{COOPFUTURO_PUBLIC_ORIGIN:-\}/,
    );
    assert.doesNotMatch(customerService.slice(0, 1_500), /COOPFUTURO_TENANT_ID:\s*[a-z][a-z0-9_-]+/i);
  }
  assert.match(standaloneEnvironment, /^COOPFUTURO_TENANT_ID=$/m);
  assert.doesNotMatch(standaloneEnvironment, /^COOPFUTURO_TENANT_ID=[a-f0-9-]+$/im);
  assert.match(
    standaloneEnvironment,
    /^COOPFUTURO_PUBLIC_ORIGIN=https:\/\/coopfuturo\.example\.com$/m,
  );
});
