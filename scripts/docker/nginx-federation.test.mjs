import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerEnvironment = Object.fromEntries(
  [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "ComSpec",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "DOCKER_CONFIG",
    "DOCKER_CLI_PLUGIN_EXTRA_DIRS",
    "TEMP",
    "TMP"
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
);

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("nginx de cada consola expone sólo /api same-origin hacia su BFF", async () => {
  const template = await source("infra/docker/console.nginx.conf.template");
  assert.match(template, /location \^~ \/api\//);
  assert.match(template, /rewrite \^\/api\(\/\.\*\)\$ \$1 break;/);
  assert.match(template, /proxy_pass \$cell_bff;/);
  assert.match(template, /location = \/api \{\s*return 404;/s);
  assert.match(template, /location ~ \$\{CONSOLE_ROUTE_PATTERN\}/);
  assert.match(template, /location \/ \{\s*try_files \$uri =404;/s);
  assert.doesNotMatch(template, /api-gateway/i);
  const logFormat = template.slice(template.indexOf("log_format cell_json"), template.indexOf("server {"));
  assert.match(logFormat, /"uri":"\$uri"/);
  assert.doesNotMatch(logFormat, /\$request_uri|\$args/);
});

test("cada imagen de consola elimina los assets heredados antes de copiar su bundle", async () => {
  const dockerfiles = [
    ["infra/docker/cells/nova.Dockerfile", "nova-console-build", "apps/nova-console", "nova"],
    ["infra/docker/cells/lumen.Dockerfile", "lumen-console-build", "apps/lumen-console", "lumen"],
    ["infra/docker/cells/pulso.Dockerfile", "pulso-console-build", "apps/pulso-console", "pulso"],
    [
      "infra/docker/cells/platform.Dockerfile",
      "platform-admin-console-build",
      "apps/platform-admin-console",
      "platform-admin"
    ]
  ];

  for (const [relativePath, buildStage, deployable, metafilePrefix] of dockerfiles) {
    const dockerfile = await source(relativePath);
    const root = "USER root";
    const cleanup = "RUN find /usr/share/nginx/html -mindepth 1 -maxdepth 1 -exec rm -rf -- '{}' +";
    const runtime = "USER 101";
    const copy = `COPY --from=${buildStage} /app/${deployable}/dist /usr/share/nginx/html`;
    const rootIndex = dockerfile.indexOf(root, dockerfile.indexOf("FROM nginxinc/nginx-unprivileged"));
    const cleanupIndex = dockerfile.indexOf(cleanup);
    const runtimeIndex = dockerfile.indexOf(runtime, cleanupIndex);
    const copyIndex = dockerfile.indexOf(copy);

    assert.notEqual(rootIndex, -1, `${relativePath} must elevate only for the build-time purge`);
    assert.notEqual(cleanupIndex, -1, `${relativePath} must purge the base image document root`);
    assert.notEqual(runtimeIndex, -1, `${relativePath} must restore the unprivileged runtime user`);
    assert.notEqual(copyIndex, -1, `${relativePath} must copy the declared console bundle`);
    assert(
      rootIndex < cleanupIndex && cleanupIndex < runtimeIndex && runtimeIndex < copyIndex,
      `${relativePath} must purge as root and restore UID 101 before copying the bundle`
    );
    const evidencePath = `${deployable}/dist/${metafilePrefix}-bundle-metafile.json`;
    const evidenceCheck = `test -f ${evidencePath}`;
    const evidenceRemoval = `rm -- ${evidencePath}`;
    const checkIndex = dockerfile.indexOf(evidenceCheck);
    const removalIndex = dockerfile.indexOf(evidenceRemoval);
    const buildIndex = dockerfile.indexOf(`pnpm --filter "@hyperion/${metafilePrefix}-console..." build`);

    assert.notEqual(checkIndex, -1, `${relativePath} must require the provenance receipt before packaging`);
    assert.notEqual(removalIndex, -1, `${relativePath} must remove the private provenance receipt`);
    assert(
      buildIndex < checkIndex && checkIndex < removalIndex && removalIndex < copyIndex,
      `${relativePath} must verify provenance before excluding its receipt from the public image`
    );
  }
});

test("los defaults de imagen exponen exactamente las rutas de su consola", async () => {
  const [lumenDockerfile, platformDockerfile] = await Promise.all([
    source("infra/docker/cells/lumen.Dockerfile"),
    source("infra/docker/cells/platform.Dockerfile")
  ]);
  assert.match(lumenDockerfile, /CONSOLE_ROUTE_PATTERN='\^\(\?:\/\|\/lumen\(\?:\/\[\^\/\]\+\)\?\/\?\)\$'/);
  assert.match(
    platformDockerfile,
    /CONSOLE_ROUTE_PATTERN='\^\(\?:\/\|\/\(\?:operators\|tenants\|grants\|catalog\)\/\?\)\$'/
  );
});

test("el edge por hostname no registra query strings", async () => {
  const template = await source("infra/docker/hostname-edge/default.conf.template");
  const logFormat = template.slice(template.indexOf("log_format hostname_edge_json"), template.indexOf("map $host"));
  assert.match(logFormat, /"uri":"\$uri"/);
  assert.doesNotMatch(logFormat, /\$request_uri|\$args/);
  assert.match(template, /map "\$request_method:\$request_uri" \$nova_provider_request_allowed/);
});

test("el edge legacy filtra deep links, emite telemetría segura y rechaza rutas desconocidas", async () => {
  const [template, legacyHtml, redirects] = await Promise.all([
    source("infra/docker/legacy/default.conf.template"),
    source("apps/web-console/index.html"),
    source("apps/web-console/src/redirects.ts")
  ]);
  for (const product of ["nova", "lumen"]) {
    assert.match(template, new RegExp(`location = /${product}`));
    assert.match(template, new RegExp(`"${product}" "${product}"`));
  }
  assert.match(template, /X-Hyperion-Legacy-Redirect \$legacy_redirect_header always/);
  assert.match(template, /map \$args \$legacy_lumen_query/);
  assert.match(template, /\?encounter=\$legacy_lumen_encounter/);
  assert.match(template, /map \$args \$legacy_pulso_query/);
  assert.match(template, /\?conversationId=\$legacy_pulso_conversation/);
  assert.match(template, /location ~ \^\/conversaciones\/\?\$/);
  assert.match(template, /return 307 \$\{NOVA_CONSOLE_ORIGIN\}\//);
  assert.match(template, /if \(\$request_method !~ \^\(\?:GET\|HEAD\)\$\)/);
  assert.match(template, /Cache-Control "no-store"/);
  assert.doesNotMatch(template, /\$is_args\$args/);
  assert.doesNotMatch(template, /return 30[78][^;]*\$args/);
  assert.doesNotMatch(template, /location ~ \^\/nova\/\(\.\*\)|location ~ \^\/lumen\/\(\.\*\)/);
  assert.match(template, /"event":"legacy_console_redirect"/);
  const logFormat = template.slice(template.indexOf("log_format legacy_redirect_json"), template.indexOf("server {"));
  assert.match(logFormat, /"product":"\$legacy_product"/);
  assert.match(logFormat, /"queryDisposition":"\$legacy_query_disposition"/);
  assert.doesNotMatch(logFormat, /\$request_uri|\$sent_http_location|\$args|\$remote_addr|\$http_user_agent/);
  assert.match(legacyHtml, /<meta name="referrer" content="no-referrer"/);
  assert.doesNotMatch(redirects, /hash:\s*string|location\.hash|access_token|id_token/);
  assert.match(template, /location \/ \{\s*default_type application\/json;\s*return 404\b/s);
});

test("Compose usa BFFs dedicados y elimina web-console-nova", async () => {
  const compose = await source("infra/docker-compose.yml");
  assert.doesNotMatch(compose, /^\s{2}web-console-nova:/m);
  assert.match(compose, /BFF_UPSTREAM: http:\/\/nova-bff:8095/);
  assert.match(compose, /BFF_UPSTREAM: http:\/\/lumen-bff:8096/);
  assert.match(compose, /BFF_UPSTREAM: http:\/\/pulso-bff:8097/);
  assert.match(compose, /BFF_UPSTREAM: http:\/\/platform-admin-bff:8098/);
  assert.doesNotMatch(compose, /BFF_UPSTREAM: http:\/\/api-gateway:/);

  const platformBff = compose.match(/^ {2}platform-admin-bff:\r?\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:|^volumes:)/m);
  assert(platformBff, "missing Compose service platform-admin-bff");
  assert.match(platformBff[1], /<<: \*platform-build/);
  assert.match(platformBff[1], /target: platform-admin-bff/);
  assert.match(platformBff[1], /ACCESS_JWKS_URL:/);
  assert.match(platformBff[1], /PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN:/);

  for (const service of [
    "nova-core-service",
    "voice-channel-service",
    "liwa-channel-service",
    "documents-service",
    "nova-bff",
    "nova-console",
    "nova-migrations"
  ]) {
    const block = compose.match(new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^volumes:)`, "m"));
    assert(block, `missing Compose service ${service}`);
    assert.match(block[1], /<<: \*nova-build/, `${service} escaped the allowlisted NOVA context`);
  }
});

test("api-gateway queda fuera del Compose por defecto y sólo entra con el perfil legacy", async (t) => {
  const compose = await source("infra/docker-compose.yml");
  const gateway = compose.match(/^ {2}api-gateway:\r?\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:|^volumes:)/m);
  assert(gateway, "missing Compose service api-gateway");
  assert.match(gateway[1], /^ {4}profiles: \["legacy-gateway"\]$/m);
  assert.match(gateway[1], /^ {8}host_ip: 127\.0\.0\.1$/m);
  assert.match(gateway[1], /^ {8}published: "\$\{API_GATEWAY_HOST_PORT:-8080\}"$/m);

  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const composeModel = (profiles = []) =>
    spawnSync(
      docker,
      [
        "compose",
        "--env-file",
        ".env.example",
        ...profiles.flatMap((profile) => ["--profile", profile]),
        "-f",
        "infra/docker-compose.yml",
        "config",
        "--format",
        "json"
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: dockerEnvironment,
        shell: false
      }
    );

  const defaultResult = composeModel();
  if (defaultResult.error?.code === "ENOENT") {
    t.skip("docker compose unavailable");
    return;
  }
  assert.equal(defaultResult.status, 0, defaultResult.stderr || defaultResult.stdout);
  const defaultServices = JSON.parse(defaultResult.stdout).services;
  assert.equal(defaultServices["api-gateway"], undefined);

  const compatibilityResult = composeModel(["legacy-gateway"]);
  assert.equal(compatibilityResult.status, 0, compatibilityResult.stderr || compatibilityResult.stdout);
  const compatibilityServices = JSON.parse(compatibilityResult.stdout).services;
  const compatibilityGateway = compatibilityServices["api-gateway"];
  assert(compatibilityGateway, "legacy-gateway profile must materialize api-gateway");
  assert.equal(compatibilityGateway.profiles?.[0], "legacy-gateway");
  assert.deepEqual(compatibilityGateway.ports, [
    {
      name: "legacy-http",
      mode: "ingress",
      host_ip: "127.0.0.1",
      target: 8080,
      published: "8080",
      protocol: "tcp"
    }
  ]);
  const inboundDependents = Object.entries(compatibilityServices)
    .filter(([, descriptor]) => Object.hasOwn(descriptor.depends_on ?? {}, "api-gateway"))
    .map(([service]) => service);
  assert.deepEqual(inboundDependents, []);
});

test("los caminos Contabo y de compatibilidad activan explícitamente el gateway legacy", async (t) => {
  const [contaboOverlay, webhookRunbook, cutoverRunbook, productionRunbook] = await Promise.all([
    source("infra/docker-compose.contabo-test.yml"),
    source("docs/products/nova/CONTABO-TEST-WEBHOOK.md"),
    source("docs/products/nova/CONTABO_CHAT_ESPEJO_CUTOVER.md"),
    source("docs/PRODUCTION.md")
  ]);

  for (const [relativePath, runbook] of [
    ["docs/products/nova/CONTABO-TEST-WEBHOOK.md", webhookRunbook],
    ["docs/products/nova/CONTABO_CHAT_ESPEJO_CUTOVER.md", cutoverRunbook],
    ["docs/PRODUCTION.md", productionRunbook]
  ]) {
    assert.match(runbook, /^status: not-current$/m, `${relativePath} must remain explicitly not-current`);
  }

  const isolatedContaboCommand =
    /docker compose --profile legacy-gateway -p hyperion-test \\\r?\n[\s\S]*?up -d --build/;
  assert.match(contaboOverlay, isolatedContaboCommand);
  assert.match(webhookRunbook, isolatedContaboCommand);
  assert.match(
    cutoverRunbook,
    /docker compose --profile legacy-gateway --env-file \.env\.contabo-test -f infra\/docker-compose\.yml -f infra\/docker-compose\.contabo-test\.yml up -d --build/
  );
  assert.match(
    productionRunbook,
    /## Comando base[\s\S]*?docker compose --profile legacy-gateway --env-file \.env -f infra\/docker-compose\.yml up --build -d/
  );

  const docker = process.platform === "win32" ? "docker.exe" : "docker";
  const composeModel = (profiles = []) =>
    spawnSync(
      docker,
      [
        "compose",
        ...profiles.flatMap((profile) => ["--profile", profile]),
        "--env-file",
        ".env.example",
        "-f",
        "infra/docker-compose.yml",
        "-f",
        "infra/docker-compose.contabo-test.yml",
        "config",
        "--format",
        "json"
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...dockerEnvironment,
          API_GATEWAY_HOST_PORT: "18081",
          WEB_CONSOLE_HOST_PORT: "13001"
        },
        shell: false
      }
    );

  const defaultResult = composeModel();
  if (defaultResult.error?.code === "ENOENT") {
    t.skip("docker compose unavailable");
    return;
  }
  assert.equal(defaultResult.status, 0, defaultResult.stderr || defaultResult.stdout);
  assert.equal(JSON.parse(defaultResult.stdout).services["api-gateway"], undefined);

  const compatibilityResult = composeModel(["legacy-gateway"]);
  assert.equal(compatibilityResult.status, 0, compatibilityResult.stderr || compatibilityResult.stdout);
  const compatibilityGateway = JSON.parse(compatibilityResult.stdout).services["api-gateway"];
  assert(compatibilityGateway, "the Contabo compatibility command must materialize api-gateway");
  assert.equal(compatibilityGateway.profiles?.[0], "legacy-gateway");
  assert.deepEqual(compatibilityGateway.ports, [
    {
      mode: "ingress",
      host_ip: "127.0.0.1",
      target: 8080,
      published: "18081",
      protocol: "tcp"
    }
  ]);
});

test("los BFF NOVA, LUMEN y PULSO sólo quedan healthy cuando su readiness está disponible", async () => {
  const descriptors = [
    ["infra/docker-compose.yml", ["nova-bff", "lumen-bff", "pulso-bff"]],
    ["infra/docker-compose.nova.yml", ["nova-bff"]],
    ["infra/docker-compose.lumen.yml", ["lumen-bff"]],
    ["infra/docker-compose.pulso.yml", ["pulso-bff"]]
  ];

  for (const [relativePath, services] of descriptors) {
    const compose = await source(relativePath);
    assert.match(compose, /x-node-readycheck:[\s\S]*?\/ready/);
    for (const service of services) {
      const block = compose.match(new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|^volumes:)`, "m"));
      assert(block, `${relativePath} is missing ${service}`);
      assert.match(block[1], /healthcheck: \*node-readycheck/, `${service} must gate traffic on /ready`);
      assert.doesNotMatch(block[1], /healthcheck: \*node-healthcheck/, `${service} must keep /health as liveness only`);
    }
  }
});

test("PULSO standalone sirve sus deep links y no colisiona con Platform por defecto", async () => {
  const [pulsoCompose, pulsoDockerfile, pulsoEnvironment, platformCompose] = await Promise.all([
    source("infra/docker-compose.pulso.yml"),
    source("infra/docker/cells/pulso.Dockerfile"),
    source("infra/pulso.env.example"),
    source("infra/docker-compose.platform.yml")
  ]);
  const routePattern =
    /CONSOLE_ROUTE_PATTERN: \^\(\?:\/\|\/\(\?:operacion\|conversaciones\|agenda\|rpa\|campanas\|bi\|configuracion\)\/\?\)\$/;

  assert.match(pulsoCompose, routePattern);
  assert.match(
    pulsoDockerfile,
    /CONSOLE_ROUTE_PATTERN='\^\(\?:\/\|\/\(\?:operacion\|conversaciones\|agenda\|rpa\|campanas\|bi\|configuracion\)\/\?\)\$'/
  );
  assert.match(pulsoCompose, /127\.0\.0\.1:\$\{PULSO_CONSOLE_HOST_PORT:-3000\}:8080/);
  assert.match(pulsoEnvironment, /^PULSO_CONSOLE_HOST_PORT=3000$/m);
  assert.match(platformCompose, /PLATFORM_ADMIN_CONSOLE_HOST_PORT:-3003/);
});

test("el Compose de convivencia cablea secretos provider-owned de NOVA sin reutilizarlos", async () => {
  const [compose, environment] = await Promise.all([source("infra/docker-compose.yml"), source(".env.example")]);
  const voice = compose.match(/^ {2}voice-channel-service:\r?\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:|^volumes:)/m);
  const novaBff = compose.match(/^ {2}nova-bff:\r?\n([\s\S]*?)(?=^ {2}[a-z0-9-]+:|^volumes:)/m);

  assert(voice, "missing Compose service voice-channel-service");
  assert(novaBff, "missing Compose service nova-bff");
  assert.match(voice[1], /^ {6}ELEVENLABS_WEBHOOK_HMAC_SECRET: \$\{ELEVENLABS_WEBHOOK_HMAC_SECRET:-\}$/m);
  assert.doesNotMatch(voice[1], /ELEVENLABS_WEBHOOK_(?:HMAC_)?SECRET:\s*\$\{ELEVENLABS_API_KEY/);
  assert.match(novaBff[1], /^ {6}NOVA_PROVIDER_EDGE_TOKEN: \$\{NOVA_PROVIDER_EDGE_TOKEN:-\}$/m);
  assert.match(environment, /^ELEVENLABS_WEBHOOK_HMAC_SECRET=$/m);
  assert.match(environment, /^NOVA_PROVIDER_EDGE_TOKEN=.{32,}$/m);

  const modelResult = spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    ["compose", "--env-file", ".env.example", "-f", "infra/docker-compose.yml", "config", "--format", "json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: dockerEnvironment,
      shell: false
    }
  );
  assert.equal(modelResult.status, 0, modelResult.stderr || modelResult.stdout);
  const services = JSON.parse(modelResult.stdout).services;
  assert.equal(services["voice-channel-service"].environment.ELEVENLABS_WEBHOOK_HMAC_SECRET, "");
  assert.equal(services["nova-bff"].environment.NOVA_PROVIDER_EDGE_TOKEN, "replace-nova-provider-edge-token-000001");
  for (const [service, descriptor] of Object.entries(services)) {
    if (service === "nova-bff") continue;
    assert.equal(
      descriptor.environment?.NOVA_PROVIDER_EDGE_TOKEN,
      undefined,
      `${service} must not receive the provider edge token`
    );
  }
});
