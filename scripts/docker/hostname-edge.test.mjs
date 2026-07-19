import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const edgeRoot = path.join(repositoryRoot, "infra/docker/hostname-edge");

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function locationBlock(template, location) {
  const escaped = location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = template.match(new RegExp(`location = ${escaped} \\{([\\s\\S]*?)(?=\\n  location |\\n})`));
  assert(match, `missing location = ${location}`);
  return match[1];
}

function serverBlock(template, hostVariable) {
  const marker = "server_name ${" + hostVariable + "};";
  const markerIndex = template.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing server for ${hostVariable}`);
  const start = template.lastIndexOf("server {", markerIndex);
  const end = template.indexOf("\nserver {", markerIndex);
  assert.notEqual(start, -1, `missing server start for ${hostVariable}`);
  return template.slice(start, end === -1 ? undefined : end);
}

test("los cinco hostnames apuntan sólo a superficies de su celda", async () => {
  const template = await source("infra/docker/hostname-edge/default.conf.template");
  const expected = [
    ["PLATFORM_ADMIN_HOST", "PLATFORM_ADMIN_CONSOLE_UPSTREAM", "PLATFORM_ADMIN_BFF_UPSTREAM"],
    ["NOVA_HOST", "NOVA_CONSOLE_UPSTREAM", "NOVA_BFF_UPSTREAM"],
    ["LUMEN_HOST", "LUMEN_CONSOLE_UPSTREAM", "LUMEN_BFF_UPSTREAM"],
    ["PULSO_HOST", "PULSO_CONSOLE_UPSTREAM", "PULSO_BFF_UPSTREAM"]
  ];

  for (const [host, consoleUpstream, bffUpstream] of expected) {
    assert.match(template, new RegExp(`server_name \\$\\{${host}\\};`));
    assert.match(template, new RegExp(`set \\$cell_console "\\$\\{${consoleUpstream}\\}";`));
    assert.match(template, new RegExp(`set \\$cell_bff "\\$\\{${bffUpstream}\\}";`));
  }

  assert.match(template, /server_name \$\{COOPFUTURO_HOST};/);
  assert.match(template, /set \$coopfuturo_console "\$\{COOPFUTURO_CONSOLE_UPSTREAM}";/);
  assert.equal((template.match(/server_name \$\{[A-Z_]+_HOST};/g) ?? []).length, 5);
  assert.match(template, /listen 8080 default_server;[\s\S]*?return 404 '\{"error":"unknown hostname"}';/);
  assert.doesNotMatch(template, /api-gateway/i);
  assert.match(template, /location = \/api \{\s*return 404;/g);
  assert.equal((template.match(/include \/etc\/nginx\/snippets\/browser-bff-proxy\.conf;/g) ?? []).length, 4);

  const browserProxy = await source("infra/docker/hostname-edge/snippets/browser-bff-proxy.conf");
  assert.match(browserProxy, /rewrite \^\/api\(\/\.\*\)\$ \$1 break;/);
  assert.match(browserProxy, /proxy_pass \$cell_bff;/);
  assert.match(browserProxy, /proxy_set_header Authorization "";/);
  assert.doesNotMatch(browserProxy, /proxy_set_header Cookie "";/);
  for (const header of [
    "X-Hyperion-Caller",
    "X-Hyperion-Operator-Assertion",
    "X-Operator-Id",
    "X-Operator-Role",
    "X-Tenant-Id",
    "X-Product-Id",
    "X-Hyperion-Tenant",
    "X-Hyperion-Tenant-Id",
    "X-Hyperion-Product",
    "X-Hyperion-Product-Id"
  ]) {
    assert.match(browserProxy, new RegExp(`proxy_set_header ${header} "";`));
  }
});

test("cada host cierra sus rutas UI ajenas antes de tocar una consola", async () => {
  const template = await source("infra/docker/hostname-edge/default.conf.template");
  assert.match(template, /location ~ \^\/\(\?:operators\|tenants\|grants\|catalog/);
  assert.match(template, /location ~ \^\/lumen/);
  assert.match(template, /location ~ \^\/\(\?:operacion\|conversaciones\|agenda\|rpa\|campanas\|bi\|configuracion/);
  assert.equal((template.match(/location \/ \{\s*return 404;/g) ?? []).length, 5);

  const consoleProxy = await source("infra/docker/hostname-edge/snippets/console-proxy.conf");
  assert.match(consoleProxy, /proxy_pass_request_headers off;/);
  assert.match(consoleProxy, /proxy_pass \$cell_console;/);
  assert.doesNotMatch(consoleProxy, /Cookie|Authorization/i);
});

test("Coopfuturo llega sólo a su Next server con sesión aislada y cabeceras selectivas", async () => {
  const template = await source("infra/docker/hostname-edge/default.conf.template");
  const coopfuturo = serverBlock(template, "COOPFUTURO_HOST");

  assert.match(coopfuturo, /client_max_body_size 21m;/);
  assert.match(coopfuturo, /location = \/healthz/);
  assert.match(coopfuturo, /"cell":"nova","surface":"coopfuturo-console"/);
  assert.match(coopfuturo, /location = \/ \{/);
  assert.match(coopfuturo, /location = \/favicon\.ico/);
  assert.match(coopfuturo, /location \/_next\/static\//);
  assert.match(coopfuturo, /location = \/_next\/image/);
  assert.match(coopfuturo, /location ~ \^\/\(\?:login\|dashboard\|campanas/);
  assert.match(coopfuturo, /revision-post-llamada\|segmentacion/);
  assert.match(coopfuturo, /location = \/pilot-core \{\s*return 404;/);
  assert.match(coopfuturo, /location \/pilot-core\//);
  assert.match(coopfuturo, /location ~\* \\.map\$/);
  assert.match(coopfuturo, /location ~ \(\?:\^\|\/\)\\\./);
  assert.match(coopfuturo, /location = \/_next\/webpack-hmr/);
  assert.equal((coopfuturo.match(/include \/etc\/nginx\/snippets\/coopfuturo-next-proxy\.conf;/g) ?? []).length, 6);
  assert.match(coopfuturo, /location \/ \{\s*return 404;/);
  assert.doesNotMatch(coopfuturo, /cell_bff|browser-bff-proxy|nova-bff|api-gateway/i);

  const proxy = await source("infra/docker/hostname-edge/snippets/coopfuturo-next-proxy.conf");
  assert.match(proxy, /proxy_pass \$coopfuturo_console;/);
  assert.match(proxy, /proxy_pass_request_headers off;/);
  for (const [header, value] of [
    ["Cookie", "$http_cookie"],
    ["Origin", "$http_origin"],
    ["Sec-Fetch-Site", "$http_sec_fetch_site"],
    ["Content-Type", "$http_content_type"],
    ["X-CSRF-Token", "$http_x_csrf_token"],
    ["RSC", "$http_rsc"],
    ["Next-Router-State-Tree", "$http_next_router_state_tree"]
  ]) {
    assert.match(proxy, new RegExp(`proxy_set_header ${header} \\${value};`));
  }
  for (const header of [
    "Authorization",
    "Proxy-Authorization",
    "X-Hyperion-Caller",
    "X-Hyperion-Operator-Assertion",
    "X-Operator-Id",
    "X-Operator-Role",
    "X-Tenant-Id",
    "X-Product-Id",
    "X-Hyperion-Tenant",
    "X-Hyperion-Tenant-Id",
    "X-Hyperion-Product",
    "X-Hyperion-Product-Id"
  ]) {
    assert.match(proxy, new RegExp(`proxy_set_header ${header} "";`));
  }
  assert.doesNotMatch(proxy, /proxy_hide_header Set-Cookie/);

  const dockerfile = await source("infra/docker/hostname-edge/Dockerfile");
  assert.match(dockerfile, /COOPFUTURO_HOST=coopfuturo\.hyperion\.test/);
  assert.match(dockerfile, /COOPFUTURO_CONSOLE_UPSTREAM=http:\/\/coopfuturo-console:3000/);
  assert.match(dockerfile, /NGINX_ENVSUBST_FILTER='[^']*COOPFUTURO_HOST[^']*COOPFUTURO_CONSOLE_UPSTREAM/);
});

test("NOVA publica sólo los tres callbacks POST canónicos sin query ni aliases", async () => {
  const template = await source("infra/docker/hostname-edge/default.conf.template");
  const expectedRoutes = ["/v1/liwa/webhooks", "/v1/voice/webhooks/dialer", "/v1/voice/webhooks/elevenlabs"];
  const allowlisted = [...template.matchAll(/"POST:(\/v1\/[^"]+)" 1;/g)].map((match) => match[1]);
  assert.deepEqual(allowlisted, expectedRoutes);

  for (const route of expectedRoutes) {
    const block = locationBlock(template, route);
    assert.match(block, /if \(\$nova_provider_request_allowed = 0\) \{\s*return 404;/);
    assert.match(block, /include \/etc\/nginx\/snippets\/provider-proxy-base\.conf;/);
  }

  const liwa = locationBlock(template, expectedRoutes[0]);
  assert.match(liwa, /X-Liwa-Webhook-Secret/);
  assert.doesNotMatch(liwa, /Dialer|Elevenlabs/i);

  const dialer = locationBlock(template, expectedRoutes[1]);
  assert.match(dialer, /X-Dialer-Signature/);
  assert.doesNotMatch(dialer, /Liwa|Elevenlabs/i);

  const elevenlabs = locationBlock(template, expectedRoutes[2]);
  assert.match(elevenlabs, /X-Elevenlabs-Signature/);
  assert.doesNotMatch(elevenlabs, /Liwa|Dialer/i);

  assert.match(template, /location ~ \^\/api\/v1\/\(\?:liwa\|voice\)\/webhooks/);
  assert.match(template, /location \^~ \/v1\/ \{\s*return 404;/);
  const novaServer = serverBlock(template, "NOVA_HOST");
  assert.doesNotMatch(novaServer, /location[^\n]*(?:simulate|pilot-core|ops\/webhooks\/liwa)/i);

  const providerProxy = await source("infra/docker/hostname-edge/snippets/provider-proxy-base.conf");
  assert.match(providerProxy, /proxy_pass_request_headers off;/);
  for (const header of ["Cookie", "Authorization", "Proxy-Authorization"]) {
    assert.match(providerProxy, new RegExp(`proxy_set_header ${header} "";`));
  }
  assert.match(providerProxy, /proxy_hide_header Set-Cookie;/);
  assert.match(providerProxy, /proxy_pass \$cell_bff;/);
  assert.match(providerProxy, /proxy_set_header X-Forwarded-For "";/);
  assert.match(providerProxy, /proxy_set_header X-Hyperion-Provider-Edge-Token \$nova_provider_edge_token;/);
  assert.match(providerProxy, /proxy_set_header X-Hyperion-Provider-Client-Ip \$remote_addr;/);

  assert.match(template, /set_real_ip_from \$\{EDGE_TRUSTED_PROXY_CIDR\};/);
  assert.match(template, /real_ip_header X-Forwarded-For;/);
  assert.match(template, /real_ip_recursive on;/);
  assert.match(template, /set \$nova_provider_edge_token "\$\{NOVA_PROVIDER_EDGE_TOKEN\}";/);
});

test("el Compose local liga loopback y no incorpora api-gateway", async (t) => {
  try {
    await execFileAsync("docker", ["compose", "version"], { cwd: repositoryRoot });
  } catch {
    t.skip("docker compose unavailable");
    return;
  }

  const { stdout } = await execFileAsync(
    "docker",
    ["compose", "-f", "infra/docker-compose.hostname-edge.yml", "config", "--format", "json"],
    {
      cwd: repositoryRoot,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NOVA_PROVIDER_EDGE_TOKEN: "hostname-edge-test-token-00000001" }
    }
  );
  const model = JSON.parse(stdout);
  assert.deepEqual(Object.keys(model.services), ["hostname-edge"]);
  assert.equal(model.services["hostname-edge"].ports[0].host_ip, "127.0.0.1");
  assert.equal(model.services["hostname-edge"].ports[0].target, 8080);
  assert.equal(model.services["hostname-edge"].networks["cell-ingress"], null);
  assert.equal(
    model.services["hostname-edge"].environment.NOVA_PROVIDER_EDGE_TOKEN,
    "hostname-edge-test-token-00000001"
  );
  assert.equal(model.services["hostname-edge"].environment.EDGE_TRUSTED_PROXY_CIDR, "127.0.0.1/32");
  assert.equal(model.services["hostname-edge"].environment.COOPFUTURO_HOST, "coopfuturo.hyperion.test");
  assert.equal(
    model.services["hostname-edge"].environment.COOPFUTURO_CONSOLE_UPSTREAM,
    "http://coopfuturo-console:3000"
  );
  assert.equal(model.networks["cell-ingress"].external, true);
  assert.doesNotMatch(stdout, /api-gateway/i);
});

async function edgeRequest(port, host, requestPath, options = {}) {
  const { request } = await import("node:http");
  const body = options.body ?? "";
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: options.method ?? "GET",
        headers: {
          Host: host,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
          ...(options.headers ?? {})
        }
      },
      async (response) => {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      }
    );
    outgoing.once("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

test(
  "el contenedor enruta por hostname y aplica la frontera real de callbacks",
  { skip: process.env.RUN_HOSTNAME_EDGE_INTEGRATION !== "1", timeout: 180_000 },
  async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const imageName = `hyperion-hostname-edge-test:${suffix}`;
    const containerName = `hyperion-hostname-edge-test-${suffix}`;
    const mockContainerName = `hyperion-hostname-edge-mock-${suffix}`;
    const networkName = `hyperion-hostname-edge-test-${suffix}`;
    const providerEdgeToken = "hostname-edge-integration-token-0001";
    let containerStarted = false;
    let mockStarted = false;
    let networkCreated = false;

    try {
      await execFileAsync("docker", ["build", "--quiet", "--tag", imageName, edgeRoot], {
        cwd: repositoryRoot,
        maxBuffer: 8 * 1024 * 1024
      });

      await execFileAsync("docker", ["network", "create", "--label", "com.hyperion.test=hostname-edge", networkName], {
        cwd: repositoryRoot
      });
      networkCreated = true;

      const mockScript = `
const http = require("node:http");
const upstreams = new Map([
  [9001, "platform-console"], [9002, "platform-bff"],
  [9003, "nova-console"], [9004, "nova-bff"],
  [9005, "lumen-console"], [9006, "lumen-bff"],
  [9007, "pulso-console"], [9008, "pulso-bff"],
  [9009, "coopfuturo-console"]
]);
for (const [port, upstream] of upstreams) {
  http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    response.writeHead(200, { "content-type": "application/json", "set-cookie": "edge-leak=forbidden" });
    response.end(JSON.stringify({ upstream, method: request.method, url: request.url, headers: request.headers, body }));
  }).listen(port, "0.0.0.0");
}
`;
      await execFileAsync(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          mockContainerName,
          "--network",
          networkName,
          "--network-alias",
          "mock",
          "node:22-bookworm-slim",
          "node",
          "-e",
          mockScript
        ],
        { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 }
      );
      mockStarted = true;

      const env = {
        PLATFORM_ADMIN_HOST: "admin.hyperion.test",
        NOVA_HOST: "nova.hyperion.test",
        COOPFUTURO_HOST: "coopfuturo.hyperion.test",
        LUMEN_HOST: "lumen.hyperion.test",
        PULSO_HOST: "pulso.hyperion.test",
        PLATFORM_ADMIN_CONSOLE_UPSTREAM: "http://mock:9001",
        PLATFORM_ADMIN_BFF_UPSTREAM: "http://mock:9002",
        NOVA_CONSOLE_UPSTREAM: "http://mock:9003",
        NOVA_BFF_UPSTREAM: "http://mock:9004",
        COOPFUTURO_CONSOLE_UPSTREAM: "http://mock:9009",
        LUMEN_CONSOLE_UPSTREAM: "http://mock:9005",
        LUMEN_BFF_UPSTREAM: "http://mock:9006",
        PULSO_CONSOLE_UPSTREAM: "http://mock:9007",
        PULSO_BFF_UPSTREAM: "http://mock:9008",
        EDGE_FORWARDED_PROTO: "https",
        EDGE_TRUSTED_PROXY_CIDR: "127.0.0.1/32",
        NOVA_PROVIDER_EDGE_TOKEN: providerEdgeToken
      };
      const runArgs = [
        "run",
        "--detach",
        "--rm",
        "--name",
        containerName,
        "--network",
        networkName,
        "--publish",
        "127.0.0.1::8080"
      ];
      for (const [key, value] of Object.entries(env)) runArgs.push("--env", `${key}=${value}`);
      runArgs.push(imageName);
      await execFileAsync("docker", runArgs, { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 });
      containerStarted = true;

      const { stdout: portOutput } = await execFileAsync("docker", ["port", containerName, "8080/tcp"], {
        cwd: repositoryRoot
      });
      const portMatch = portOutput.trim().match(/:(\d+)$/);
      assert(portMatch, `unexpected docker port output: ${portOutput}`);
      const edgePort = Number(portMatch[1]);

      let ready = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          const response = await edgeRequest(edgePort, "nova.hyperion.test", "/healthz");
          if (response.status === 200) {
            ready = true;
            break;
          }
        } catch {
          // Container startup is intentionally polled.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) {
        const { stdout: logs, stderr } = await execFileAsync("docker", ["logs", containerName], {
          cwd: repositoryRoot
        });
        assert.fail(`hostname edge did not become ready\n${logs}\n${stderr}`);
      }

      const hostToUpstream = new Map([
        ["admin.hyperion.test", "platform-console"],
        ["nova.hyperion.test", "nova-console"],
        ["coopfuturo.hyperion.test", "coopfuturo-console"],
        ["lumen.hyperion.test", "lumen-console"],
        ["pulso.hyperion.test", "pulso-console"]
      ]);
      for (const [host, upstream] of hostToUpstream) {
        const response = await edgeRequest(edgePort, host, "/");
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).upstream, upstream);
      }

      for (const route of [
        "/login?next=%2Fdashboard",
        "/dashboard",
        "/campanas/nueva",
        "/configuracion",
        "/conversaciones?id=conversation-1",
        "/crm",
        "/handoff",
        "/importar",
        "/laboratorio",
        "/reportes",
        "/revision-post-llamada",
        "/segmentacion",
        "/favicon.ico",
        "/_next/static/chunks/app.js",
        "/_next/image?url=%2Ffavicon.ico&w=64&q=75"
      ]) {
        const response = await edgeRequest(edgePort, "coopfuturo.hyperion.test", route);
        assert.equal(response.status, 200, `Coopfuturo ${route} must reach Next`);
        assert.equal(JSON.parse(response.body).upstream, "coopfuturo-console");
      }

      const coopBody = '{"channels":{"voz_enabled":true}}';
      const coopResponse = await edgeRequest(edgePort, "coopfuturo.hyperion.test", "/pilot-core/ops/settings", {
        method: "PUT",
        body: coopBody,
        headers: {
          "content-type": "application/json",
          Cookie: "__Host-hyperion-coopfuturo-session=customer-session; __Host-hyperion-coopfuturo-csrf=customer-csrf",
          Origin: "https://coopfuturo.hyperion.test",
          "Sec-Fetch-Site": "same-origin",
          "X-CSRF-Token": "customer-csrf",
          Authorization: "Bearer browser-token",
          "Proxy-Authorization": "Basic forbidden",
          "X-Hyperion-Caller": "api-gateway",
          "X-Hyperion-Operator-Assertion": "forged-assertion",
          "X-Operator-Id": "forged-operator",
          "X-Operator-Role": "admin",
          "X-Tenant-Id": "forged-tenant",
          "X-Product-Id": "PULSO",
          "X-Hyperion-Tenant": "forged-tenant-alias",
          "X-Hyperion-Tenant-Id": "forged-tenant-id",
          "X-Hyperion-Product": "PULSO",
          "X-Hyperion-Product-Id": "PULSO"
        }
      });
      assert.equal(coopResponse.status, 200);
      assert.notEqual(coopResponse.headers["set-cookie"], undefined, "Next auth cookies must reach the browser");
      const coopRequest = JSON.parse(coopResponse.body);
      assert.equal(coopRequest.upstream, "coopfuturo-console");
      assert.equal(coopRequest.method, "PUT");
      assert.equal(coopRequest.url, "/pilot-core/ops/settings");
      assert.equal(coopRequest.body, coopBody);
      assert.equal(
        coopRequest.headers.cookie,
        "__Host-hyperion-coopfuturo-session=customer-session; __Host-hyperion-coopfuturo-csrf=customer-csrf"
      );
      assert.equal(coopRequest.headers.origin, "https://coopfuturo.hyperion.test");
      assert.equal(coopRequest.headers["sec-fetch-site"], "same-origin");
      assert.equal(coopRequest.headers["x-csrf-token"], "customer-csrf");
      assert.equal(coopRequest.headers["content-type"], "application/json");
      for (const header of [
        "authorization",
        "proxy-authorization",
        "x-hyperion-caller",
        "x-hyperion-operator-assertion",
        "x-operator-id",
        "x-operator-role",
        "x-tenant-id",
        "x-product-id",
        "x-hyperion-tenant",
        "x-hyperion-tenant-id",
        "x-hyperion-product",
        "x-hyperion-product-id"
      ]) {
        assert.equal(coopRequest.headers[header], undefined, `${header} must be stripped from Coopfuturo`);
      }

      const apiResponse = await edgeRequest(edgePort, "admin.hyperion.test", "/api/v1/platform/catalog?status=active", {
        headers: {
          Cookie: "__Host-session=opaque",
          "X-CSRF-Token": "csrf-token",
          "X-Requested-With": "platform-admin-console",
          Authorization: "Bearer browser-token",
          "X-Hyperion-Caller": "api-gateway",
          "X-Hyperion-Operator-Assertion": "forged-assertion",
          "X-Operator-Id": "forged-operator",
          "X-Operator-Role": "platform-manager",
          "X-Tenant-Id": "forged-tenant",
          "X-Product-Id": "PULSO",
          "X-Hyperion-Tenant": "forged-tenant-alias",
          "X-Hyperion-Tenant-Id": "forged-tenant-id",
          "X-Hyperion-Product": "PULSO",
          "X-Hyperion-Product-Id": "PULSO"
        }
      });
      assert.equal(apiResponse.status, 200);
      const platformRequest = JSON.parse(apiResponse.body);
      assert.equal(platformRequest.upstream, "platform-bff");
      assert.equal(platformRequest.url, "/v1/platform/catalog?status=active");
      assert.equal(platformRequest.headers.cookie, "__Host-session=opaque");
      assert.equal(platformRequest.headers["x-csrf-token"], "csrf-token");
      assert.equal(platformRequest.headers["x-requested-with"], "platform-admin-console");
      assert.equal(platformRequest.headers.authorization, undefined);
      for (const header of [
        "x-hyperion-caller",
        "x-hyperion-operator-assertion",
        "x-operator-id",
        "x-operator-role",
        "x-tenant-id",
        "x-product-id",
        "x-hyperion-tenant",
        "x-hyperion-tenant-id",
        "x-hyperion-product",
        "x-hyperion-product-id"
      ]) {
        assert.equal(platformRequest.headers[header], undefined, `${header} must be stripped`);
      }

      const foreignRoutes = [
        ["nova.hyperion.test", "/lumen/dictado"],
        ["lumen.hyperion.test", "/operacion"],
        ["pulso.hyperion.test", "/operators"],
        ["admin.hyperion.test", "/agenda"],
        ["coopfuturo.hyperion.test", "/operators"],
        ["coopfuturo.hyperion.test", "/lumen/dictado"],
        ["coopfuturo.hyperion.test", "/operacion"],
        ["coopfuturo.hyperion.test", "/api/v1/auth/me"],
        ["coopfuturo.hyperion.test", "/v1/auth/me"],
        ["coopfuturo.hyperion.test", "/dev/kit"],
        ["coopfuturo.hyperion.test", "/_next/webpack-hmr"],
        ["coopfuturo.hyperion.test", "/_next/static/chunks/app.js.map"],
        ["coopfuturo.hyperion.test", "/.env"],
        ["coopfuturo.hyperion.test", "/file.svg"],
        ["coopfuturo.hyperion.test", "/pilot-core"]
      ];
      for (const [host, route] of foreignRoutes) {
        const response = await edgeRequest(edgePort, host, route);
        assert.equal(response.status, 404, `${host}${route} must be closed`);
      }
      assert.equal((await edgeRequest(edgePort, "unknown.hyperion.test", "/")).status, 404);

      const rawBody = '{  "event": "message", "text": "á" }\n';
      const liwaResponse = await edgeRequest(edgePort, "nova.hyperion.test", "/v1/liwa/webhooks", {
        method: "POST",
        body: rawBody,
        headers: {
          "content-type": "application/json",
          "x-liwa-webhook-secret": "liwa-signature",
          "x-dialer-signature": "must-not-cross",
          "x-hyperion-provider-edge-token": "forged-edge-token",
          "x-hyperion-provider-client-ip": "203.0.113.250",
          "x-forwarded-for": "203.0.113.251",
          Cookie: "provider-cookie=forbidden",
          Authorization: "Bearer provider-token",
          "Proxy-Authorization": "Basic forbidden"
        }
      });
      assert.equal(liwaResponse.status, 200);
      assert.equal(liwaResponse.headers["set-cookie"], undefined);
      const liwaRequest = JSON.parse(liwaResponse.body);
      assert.equal(liwaRequest.upstream, "nova-bff");
      assert.equal(liwaRequest.body, rawBody);
      assert.equal(liwaRequest.headers["x-liwa-webhook-secret"], "liwa-signature");
      assert.equal(liwaRequest.headers["x-dialer-signature"], undefined);
      assert.equal(liwaRequest.headers.cookie, undefined);
      assert.equal(liwaRequest.headers.authorization, undefined);
      assert.equal(liwaRequest.headers["proxy-authorization"], undefined);
      assert.equal(liwaRequest.headers["x-forwarded-proto"], "https");
      assert.equal(liwaRequest.headers["x-forwarded-for"], undefined);
      assert.equal(liwaRequest.headers["x-hyperion-provider-edge-token"], providerEdgeToken);
      assert.notEqual(isIP(liwaRequest.headers["x-hyperion-provider-client-ip"]), 0);
      assert.notEqual(liwaRequest.headers["x-hyperion-provider-client-ip"], "203.0.113.250");
      assert.notEqual(liwaRequest.headers["x-hyperion-provider-client-ip"], "203.0.113.251");

      for (const [route, header, value] of [
        ["/v1/voice/webhooks/dialer", "x-dialer-signature", "dialer-signature"],
        ["/v1/voice/webhooks/elevenlabs", "x-elevenlabs-signature", "elevenlabs-signature"]
      ]) {
        const response = await edgeRequest(edgePort, "nova.hyperion.test", route, {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json", [header]: value }
        });
        assert.equal(response.status, 200);
        const providerRequest = JSON.parse(response.body);
        assert.equal(providerRequest.upstream, "nova-bff");
        assert.equal(providerRequest.headers[header], value);
      }

      for (const [method, route] of [
        ["GET", "/v1/liwa/webhooks"],
        ["POST", "/v1/liwa/webhooks?secret=forbidden"],
        ["POST", "/v1/liwa/webhooks/simulate"],
        ["POST", "/api/v1/liwa/webhooks"],
        ["POST", "/pilot-core/ops/webhooks/liwa"]
      ]) {
        const response = await edgeRequest(edgePort, "nova.hyperion.test", route, {
          method,
          body: method === "POST" ? "{}" : ""
        });
        assert.equal(response.status, 404, `${method} ${route} must be closed`);
      }
      assert.equal(
        (await edgeRequest(edgePort, "pulso.hyperion.test", "/v1/liwa/webhooks", { method: "POST", body: "{}" }))
          .status,
        404
      );
    } finally {
      if (containerStarted) {
        await execFileAsync("docker", ["stop", "--time", "0", containerName], { cwd: repositoryRoot }).catch(() => {});
      }
      if (mockStarted) {
        await execFileAsync("docker", ["stop", "--time", "0", mockContainerName], { cwd: repositoryRoot }).catch(
          () => {}
        );
      }
      if (networkCreated) {
        await execFileAsync("docker", ["network", "rm", networkName], { cwd: repositoryRoot }).catch(() => {});
      }
      await execFileAsync("docker", ["image", "rm", imageName], { cwd: repositoryRoot }).catch(() => {});
    }
  }
);
