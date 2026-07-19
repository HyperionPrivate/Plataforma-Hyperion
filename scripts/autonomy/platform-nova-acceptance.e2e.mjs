#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const runIdPattern = /^[a-f0-9]{12}$/;
const platformProjectPattern = /^hyperion-platform-acceptance-[a-f0-9]{12}$/;
const novaProjectPattern = /^hyperion-nova-acceptance-[a-f0-9]{12}$/;
const networkPattern = /^hyperion-platform-nova-acceptance-[a-f0-9]{12}$/;
const temporaryPattern = /^hyperion-platform-nova-acceptance-[a-f0-9]{12}-/;
const platformDescriptor = path.join(repositoryRoot, "infra/docker-compose.platform.yml");
const platformOverlay = path.join(repositoryRoot, "infra/docker-compose.platform-nova.acceptance.yml");
const novaDescriptor = path.join(repositoryRoot, "infra/docker-compose.nova.yml");
const novaOverlay = path.join(repositoryRoot, "infra/docker-compose.nova-platform.acceptance.yml");
export const PLATFORM_ACCEPTANCE_BUILD_SERVICES = Object.freeze([
  "access-database-bootstrap",
  "audit-database-bootstrap",
  "identity-service",
  "tenant-service",
  "audit-service",
  "platform-admin-bff",
  "platform-admin-console"
]);
export const NOVA_ACCEPTANCE_BUILD_SERVICES = Object.freeze([
  "nova-database-bootstrap",
  "nova-migrations",
  "nova-role-bootstrap",
  "nova-core-service",
  "voice-channel-service",
  "liwa-channel-service",
  "documents-service",
  "nova-bff",
  "nova-console"
]);
const allowedParentEnvironment = [
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
  "TMP",
  "LANG"
];

let activeChild;
let receivedSignal;
let acceptanceAbortController;
let cleanupMode = false;

export async function runPlatformNovaAcceptance(environment = process.env) {
  if (environment.RUN_PLATFORM_NOVA_ACCEPTANCE !== "1") {
    throw new Error("Set RUN_PLATFORM_NOVA_ACCEPTANCE=1 to run the destructive disposable acceptance rehearsal");
  }
  receivedSignal = undefined;
  cleanupMode = false;
  acceptanceAbortController = new AbortController();

  const runId = randomBytes(6).toString("hex");
  assert.match(runId, runIdPattern);
  const names = acceptanceNames(runId);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), `${names.network}-`));
  const privateKeyPath = path.join(temporaryDirectory, "access-token-private-key.pem");
  const migrationImages = [
    `hyperion/access-migrations:acceptance-${runId}`,
    `hyperion/audit-migrations:acceptance-${runId}`
  ];
  const secrets = acceptanceSecrets();
  const issuer = `https://access-${runId}.acceptance.hyperion.invalid`;
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const tenantSlug = `nova-acceptance-${runId}`;
  const adminEmail = `platform-admin-${runId}@acceptance.invalid`;
  const adminPassword = secret("admin-password");
  const sharedEnvironment = {
    PLATFORM_NOVA_ACCEPTANCE_NETWORK: names.network,
    NOVA_BFF_TO_ACCESS_TOKEN: secrets.novaBffToAccess,
    NOVA_TO_AUDIT_TOKEN: secrets.novaToAudit
  };
  const platformEnvironment = {
    ...sharedEnvironment,
    PLATFORM_NODE_ENV: "development",
    PLATFORM_DEPLOYMENT_ENVIRONMENT: "local",
    PLATFORM_POSTGRES_ADMIN_USER: `platform_admin_${runId}`,
    PLATFORM_POSTGRES_ADMIN_PASSWORD: secret("platform-db"),
    ACCESS_POSTGRES_DB: "hyperion_access",
    ACCESS_MIGRATOR_DATABASE_PASSWORD: secret("access-migrator"),
    IDENTITY_DATABASE_PASSWORD: secret("identity-db"),
    TENANT_DATABASE_PASSWORD: secret("tenant-db"),
    AUDIT_POSTGRES_DB: "hyperion_audit",
    AUDIT_MIGRATOR_DATABASE_PASSWORD: secret("audit-migrator"),
    AUDIT_DATABASE_PASSWORD: secret("audit-db"),
    PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN: secret("platform-access"),
    PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN: secret("platform-identity"),
    PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN: secret("platform-tenant"),
    PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY: secret("platform-assertion"),
    PLATFORM_ACCESS_TOKEN_PRIVATE_KEY_FILE: privateKeyPath,
    PLATFORM_ACCESS_TOKEN_ISSUER: issuer,
    PLATFORM_ACCESS_TOKEN_KEY_ID: `acceptance-${runId}`,
    PLATFORM_ACCESS_TOKEN_TTL_SECONDS: "300",
    PLATFORM_ACCESS_JWKS_ALLOW_PRIVATE_HTTP: "true",
    PLATFORM_INITIAL_ADMIN_EMAIL: adminEmail,
    PLATFORM_INITIAL_ADMIN_PASSWORD: adminPassword,
    PLATFORM_SESSION_TTL_HOURS: "1",
    PLATFORM_POSTGRES_HOST_PORT: "0",
    PLATFORM_ACCESS_HOST_PORT: "0",
    PLATFORM_AUDIT_HOST_PORT: "0",
    PLATFORM_ADMIN_BFF_HOST_PORT: "0",
    PLATFORM_ADMIN_CONSOLE_HOST_PORT: "0",
    PLATFORM_ACCESS_MIGRATIONS_IMAGE: migrationImages[0],
    PLATFORM_AUDIT_MIGRATIONS_IMAGE: migrationImages[1]
  };
  const novaEnvironment = {
    ...sharedEnvironment,
    NOVA_NODE_ENV: "development",
    NOVA_DEPLOYMENT_ENVIRONMENT: "local",
    NOVA_POSTGRES_ADMIN_USER: `nova_admin_${runId}`,
    NOVA_POSTGRES_ADMIN_PASSWORD: secret("nova-db"),
    NOVA_POSTGRES_DB: "hyperion_nova",
    NOVA_MIGRATOR_DATABASE_PASSWORD: secret("nova-migrator"),
    NOVA_DATABASE_PASSWORD: secret("nova-runtime"),
    VOICE_DATABASE_PASSWORD: secret("voice-runtime"),
    LIWA_DATABASE_PASSWORD: secret("liwa-runtime"),
    DOCUMENTS_DATABASE_PASSWORD: secret("documents-runtime"),
    NOVA_BFF_TO_NOVA_TOKEN: secret("bff-core"),
    NOVA_BFF_TO_VOICE_TOKEN: secret("bff-voice"),
    NOVA_BFF_TO_LIWA_TOKEN: secret("bff-liwa"),
    NOVA_BFF_TO_DOCUMENTS_TOKEN: secret("bff-documents"),
    NOVA_OPERATOR_ASSERTION_KEY: secret("nova-assertion"),
    NOVA_PROVIDER_EDGE_TOKEN: secret("nova-provider"),
    NOVA_TO_VOICE_TOKEN: secret("core-voice"),
    NOVA_TO_LIWA_TOKEN: secret("core-liwa"),
    NOVA_TO_DOCUMENTS_TOKEN: secret("core-documents"),
    VOICE_TO_NOVA_TOKEN: secret("voice-core"),
    LIWA_TO_NOVA_TOKEN: secret("liwa-core"),
    DOCUMENTS_TO_NOVA_TOKEN: secret("documents-core"),
    VOICE_TO_AUDIT_TOKEN: secret("voice-audit"),
    LIWA_TO_AUDIT_TOKEN: secret("liwa-audit"),
    DOCUMENTS_TO_AUDIT_TOKEN: secret("documents-audit"),
    NOVA_AUDIT_SERVICE_URL: "http://audit-service:8086",
    NOVA_ACCESS_SERVICE_URL: "http://identity-service:8081",
    NOVA_ACCESS_JWKS_URL: "http://identity-service:8081/.well-known/jwks.json",
    NOVA_ACCESS_JWKS_ALLOW_PRIVATE_HTTP: "true",
    NOVA_ACCESS_TOKEN_ISSUER: issuer,
    NOVA_MINIO_ROOT_USER: `nova-minio-${runId}`,
    NOVA_MINIO_ROOT_PASSWORD: secret("minio"),
    NOVA_DOCUMENTS_S3_BUCKET: `nova-documents-${runId}`,
    NOVA_BFF_HOST_PORT: "0",
    NOVA_CONSOLE_HOST_PORT: "0",
    NOVA_COOPFUTURO_HOST_PORT: "0",
    NOVA_VOICE_MODE: "contract",
    NOVA_LIWA_MODE: "contract"
  };

  const platform = composeProject(names.platformProject, [platformDescriptor, platformOverlay], platformEnvironment);
  const nova = composeProject(names.novaProject, [novaDescriptor, novaOverlay], novaEnvironment);
  let ownsPlatformProject = false;
  let ownsNovaProject = false;
  let ownsMigrationImages = false;
  let ownsNetwork = false;
  let acceptanceError;
  let acceptanceResult;
  const cleanupErrors = [];

  try {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

    phase("materializing provider-owned build contexts");
    await run(process.execPath, ["scripts/docker/generate-cell-contexts.mjs", "--cell", "platform", "--cell", "nova"]);
    await assertProjectAbsent(names.platformProject);
    await assertProjectAbsent(names.novaProject);
    for (const image of migrationImages) await assertImageAbsent(image);
    await assertNetworkAbsent(names.network);

    // Absence of the complete namespace is the ownership boundary. Never set
    // these flags before every preflight has passed: finally must not touch a
    // resource that predates this run.
    ownsPlatformProject = true;
    ownsNovaProject = true;
    ownsMigrationImages = true;
    await run(docker, ["network", "create", "--driver", "bridge", "--internal", names.network], { capture: true });
    ownsNetwork = true;

    phase("building isolated Platform and NOVA projects");
    for (const service of PLATFORM_ACCEPTANCE_BUILD_SERVICES) {
      phase(`building Platform service ${service}`);
      await platform.run(["build", service]);
    }
    for (const service of NOVA_ACCEPTANCE_BUILD_SERVICES) {
      phase(`building NOVA service ${service}`);
      await nova.run(["build", service]);
    }

    phase("starting Platform and bootstrapping the initial administrator");
    await platform.run(["up", "--detach", "--no-build", "--wait"]);
    const platformBffUrl = `http://${await publishedLoopback(platform, "platform-admin-bff", 8098)}`;
    const platformSession = await login(platformBffUrl, "platform-admin-console", adminEmail, adminPassword, {
      session: "__Host-hyperion-platform-admin-session",
      csrf: "__Host-hyperion-platform-admin-csrf"
    });
    const operatorId = platformSession.body?.data?.operator?.id;
    assert.match(operatorId ?? "", /^[0-9a-f-]{36}$/i, "Platform login did not return the initial administrator id");

    phase("provisioning the disposable tenant (HYP-FED-001) and its NOVA grant");
    await platform.psql(
      "hyperion_access",
      [
        "\\set ON_ERROR_STOP on",
        "begin;",
        "insert into platform.tenants (id, slug, display_name, status, metadata)",
        "values (:'tenant_id'::uuid, :'tenant_slug', :'display_name', 'active',",
        "        jsonb_build_object('source', 'platform-nova-acceptance', 'debt', 'HYP-FED-001'));",
        "commit;"
      ].join("\n"),
      {
        tenant_id: tenantId,
        tenant_slug: tenantSlug,
        display_name: "NOVA federated acceptance"
      }
    );
    const grantPath = `/v1/platform/grants/${operatorId}/${tenantId}/NOVA`;
    const grantBody = {
      roles: ["admin"],
      capabilities: ["nova:admin"],
      active: true
    };
    await expectCsrfDenied(platformBffUrl, platformSession, "PUT", grantPath, grantBody);
    await browserCall(platformBffUrl, platformSession, "PUT", grantPath, grantBody, 200);

    phase("starting NOVA against real Platform Access and Audit");
    await nova.run(["up", "--detach", "--no-build", "--wait"]);
    const novaBffUrl = `http://${await publishedLoopback(nova, "nova-bff", 8095)}`;
    const novaSession = await login(novaBffUrl, "nova-console", adminEmail, adminPassword, {
      session: "__Host-hyperion-nova-session",
      csrf: "__Host-hyperion-nova-csrf"
    });
    phase("verifying the warm JWKS cache during a real Identity outage");
    await platform.run(["stop", "identity-service"]);
    await browserCall(novaBffUrl, novaSession, "GET", "/v1/auth/me", undefined, 200);
    await platform.run(["up", "--detach", "--no-build", "--wait", "identity-service"]);

    await browserCall(novaBffUrl, novaSession, "GET", `/v1/tenants/${foreignTenantId}/nova/dashboard`, undefined, 403);
    await browserCall(novaBffUrl, novaSession, "GET", `/v1/tenants/${tenantId}/lumen/encounters`, undefined, 404);
    await browserCall(novaBffUrl, novaSession, "POST", `/v1/tenants/${tenantId}/nova/bootstrap`, {
      display_name: "NOVA federated acceptance",
      agencies: []
    });

    phase("forcing an Audit outage during a real NOVA import");
    await platform.run(["stop", "audit-service"]);
    const phone = `+5731${randomDigits(8)}`;
    const imported = await browserCall(
      novaBffUrl,
      novaSession,
      "POST",
      `/v1/tenants/${tenantId}/nova/contacts/import`,
      {
        contacts: [{ phone_e164: phone, full_name: "Federated Acceptance Contact", agency_code: "BGA" }]
      }
    );
    const contactId = imported.body?.data?.imported?.[0]?.contact_id;
    assert.match(contactId ?? "", /^[0-9a-f-]{36}$/i, "NOVA import did not return contact_id");
    const businessIdempotencyKey = `contact-import:${tenantId}:${phone}`;

    const pending = await waitFor(
      async () => readOutbox(nova, tenantId, phone, contactId),
      (state) => {
        return state?.status === "pending" && state.attemptCount >= 1 && state.lastError === "network_error";
      },
      "NOVA Audit outbox never reached pending/network_error during the outage"
    );
    assert.equal(pending.businessIdempotencyKey, businessIdempotencyKey);

    phase("recovering Audit and draining the NOVA outbox");
    await platform.run(["up", "--detach", "--no-build", "--wait", "audit-service"]);
    const completed = await waitFor(
      async () => readOutbox(nova, tenantId, phone, contactId),
      (state) => state?.status === "completed" && state.attemptCount > pending.attemptCount,
      "NOVA Audit outbox did not complete after Audit recovery"
    );
    assert.equal(completed.eventId, pending.eventId, "Audit recovery changed the durable NOVA event id");
    assert.equal(completed.businessIdempotencyKey, businessIdempotencyKey);
    const persistence = await readAuditPersistence(platform, completed.eventId, businessIdempotencyKey);
    assert.deepEqual(persistence, { inboxCount: 1, auditCount: 1, logicalAuditCount: 1 });

    acceptanceResult = {
      status: "ok",
      runId,
      tenantId,
      operatorId,
      contactId,
      eventId: completed.eventId,
      outageAttemptCount: pending.attemptCount,
      completedAttemptCount: completed.attemptCount,
      logicalAuditRecords: persistence.logicalAuditCount
    };
  } catch (error) {
    acceptanceError = error;
  } finally {
    cleanupMode = true;
    if (ownsNovaProject) await captureCleanup(cleanupErrors, () => nova.down());
    if (ownsPlatformProject) await captureCleanup(cleanupErrors, () => platform.down());
    if (ownsMigrationImages) {
      for (const image of migrationImages) await captureCleanup(cleanupErrors, () => removeImageIfPresent(image));
    }
    if (ownsNetwork) await captureCleanup(cleanupErrors, () => removeNetworkIfPresent(names.network));
    if (ownsNovaProject) await captureCleanup(cleanupErrors, () => assertProjectAbsent(names.novaProject));
    if (ownsPlatformProject) await captureCleanup(cleanupErrors, () => assertProjectAbsent(names.platformProject));
    if (ownsNetwork) await captureCleanup(cleanupErrors, () => assertNetworkAbsent(names.network));
    if (ownsMigrationImages) {
      for (const image of migrationImages) await captureCleanup(cleanupErrors, () => assertImageAbsent(image));
    }
    await captureCleanup(cleanupErrors, () => safeRemoveTemporary(temporaryDirectory, names.network));
    cleanupMode = false;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      acceptanceError ? [acceptanceError, ...cleanupErrors] : cleanupErrors,
      "Platform-NOVA acceptance cleanup was incomplete"
    );
  }
  if (acceptanceError) throw acceptanceError;
  if (receivedSignal) throw new Error(`Platform-NOVA acceptance interrupted by ${receivedSignal}`);
  assert.ok(acceptanceResult, "Platform-NOVA acceptance finished without a result receipt");
  process.stdout.write(`${JSON.stringify(acceptanceResult)}\n`);
}

export function acceptanceNames(runId) {
  assert.match(runId, runIdPattern);
  const names = {
    platformProject: `hyperion-platform-acceptance-${runId}`,
    novaProject: `hyperion-nova-acceptance-${runId}`,
    network: `hyperion-platform-nova-acceptance-${runId}`
  };
  assert.match(names.platformProject, platformProjectPattern);
  assert.match(names.novaProject, novaProjectPattern);
  assert.match(names.network, networkPattern);
  for (const name of Object.values(names)) assert.ok(name.length <= 63);
  return names;
}

function composeProject(projectName, descriptors, environment) {
  assertSafeProject(projectName);
  const prefix = ["compose", "--project-name", projectName, ...descriptors.flatMap((file) => ["-f", file])];
  return {
    run: (arguments_, options) => run(docker, [...prefix, ...arguments_], { environment, ...options }),
    down: () => run(docker, [...prefix, "down", "--volumes", "--remove-orphans", "--rmi", "local"], { environment }),
    psql: (database, sql, variables = {}) =>
      run(
        docker,
        [
          ...prefix,
          "exec",
          "-T",
          "postgres",
          "psql",
          "-X",
          "--no-align",
          "--tuples-only",
          "--set=ON_ERROR_STOP=1",
          ...Object.entries(variables).map(([name, value]) => `--set=${name}=${value}`),
          "--username",
          environment.PLATFORM_POSTGRES_ADMIN_USER ?? environment.NOVA_POSTGRES_ADMIN_USER,
          "--dbname",
          database
        ],
        { environment, input: sql, capture: true }
      )
  };
}

async function login(baseUrl, requestedWith, email, password, cookieNames) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": requestedWith },
    body: JSON.stringify({ email, password }),
    redirect: "error",
    signal: acceptanceFetchSignal(10_000)
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 201) throw new Error(`Authenticated login returned ${response.status}`);
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("set-cookie")?.split(/,(?=\s*__Host-)/) ?? []);
  const sessionHeader = uniqueSetCookie(setCookies, cookieNames.session);
  const csrfHeader = uniqueSetCookie(setCookies, cookieNames.csrf);
  const session = sessionHeader?.split(";", 1)[0];
  const csrf = csrfHeader?.split(";", 1)[0];
  if (!session || !csrf) throw new Error("Authenticated login did not return isolated session and CSRF cookies");
  assert.match(sessionHeader, /;\s*HttpOnly(?:;|$)/i);
  assert.match(sessionHeader, /;\s*Secure(?:;|$)/i);
  assert.match(sessionHeader, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(sessionHeader, /;\s*Path=\/(?:;|$)/i);
  assert.doesNotMatch(sessionHeader, /;\s*Domain=/i);
  assert.doesNotMatch(csrfHeader, /;\s*HttpOnly(?:;|$)/i);
  assert.match(csrfHeader, /;\s*Secure(?:;|$)/i);
  assert.match(csrfHeader, /;\s*SameSite=Strict(?:;|$)/i);
  assert.match(csrfHeader, /;\s*Path=\/(?:;|$)/i);
  assert.doesNotMatch(csrfHeader, /;\s*Domain=/i);
  return {
    body,
    cookie: `${session}; ${csrf}`,
    csrf: decodeURIComponent(csrf.slice(csrf.indexOf("=") + 1))
  };
}

async function browserCall(baseUrl, session, method, requestPath, body, expectedStatus) {
  const mutation = !new Set(["GET", "HEAD", "OPTIONS"]).has(method);
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      cookie: session.cookie,
      ...(mutation ? { "x-csrf-token": session.csrf } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: acceptanceFetchSignal(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  const expected = expectedStatus ?? (mutation ? 201 : 200);
  if (response.status !== expected)
    throw new Error(`${method} ${requestPath} returned ${response.status}, expected ${expected}`);
  return { status: response.status, body: payload };
}

async function expectCsrfDenied(baseUrl, session, method, requestPath, body) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: { cookie: session.cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: acceptanceFetchSignal(10_000)
  });
  if (response.status !== 403) {
    throw new Error(`${method} ${requestPath} without CSRF returned ${response.status}, expected 403`);
  }
}

async function readOutbox(nova, tenantId, phone, contactId) {
  const result = await nova.psql(
    "hyperion_nova",
    `select coalesce(json_agg(row_to_json(matched)), '[]'::json)::text
       from (
         select event_id::text as "eventId",
                status,
                attempt_count as "attemptCount",
                last_error as "lastError",
                payload #>> '{metadata,businessIdempotencyKey}' as "businessIdempotencyKey"
           from nova.outbox_events
          where tenant_id = :'tenant_id'::uuid
            and event_type = 'nova.audit.event.record.v1'
            and payload->>'eventType' = 'contact.imported'
            and payload #>> '{metadata,domainPayload,phone_e164}' = :'phone'
            and payload->>'entityId' = :'contact_id'
          order by created_at
       ) matched;`,
    { tenant_id: tenantId, phone, contact_id: contactId }
  );
  const rows = parsePsqlJson(result.stdout) ?? [];
  assert.ok(Array.isArray(rows), "NOVA outbox query did not return an array");
  assert.ok(rows.length <= 1, "NOVA created more than one outbox row for the same logical contact import");
  return rows[0];
}

async function readAuditPersistence(platform, eventId, businessIdempotencyKey) {
  const result = await platform.psql(
    "hyperion_audit",
    `select json_build_object(
       'inboxCount', (select count(*)::int from audit_runtime.inbox_events where event_id = :'event_id'::uuid),
       'auditCount', (select count(*)::int from platform.audit_events where source_event_id = :'event_id'::uuid),
       'logicalAuditCount', (
         select count(*)::int from platform.audit_events
          where metadata->>'businessIdempotencyKey' = :'business_key'
       )
     )::text;`,
    { event_id: eventId, business_key: businessIdempotencyKey }
  );
  return parsePsqlJson(result.stdout);
}

async function waitFor(read, predicate, message) {
  let last;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    last = await read();
    if (predicate(last)) return last;
    throwIfInterrupted();
    await delay(1_000, undefined, { signal: acceptanceAbortController?.signal });
  }
  throw new Error(`${message}; last state=${JSON.stringify(last)}`);
}

async function publishedLoopback(project, service, port) {
  const result = await project.run(["port", service, String(port)], { capture: true });
  const endpoint = result.stdout.trim();
  assert.match(endpoint, /^127\.0\.0\.1:\d+$/, `${service} is not bound to a loopback ephemeral port`);
  return endpoint;
}

async function assertProjectAbsent(projectName) {
  assertSafeProject(projectName);
  for (const [kind, arguments_] of [
    ["containers", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`]],
    ["volumes", ["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`]],
    ["networks", ["network", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`]],
    ["images", ["image", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`]]
  ]) {
    const result = await run(docker, arguments_, { capture: true });
    assert.equal(result.stdout.trim(), "", `${projectName} still owns ${kind}`);
  }
}

async function removeImageIfPresent(image) {
  assert.match(image, /^hyperion\/(?:access|audit)-migrations:acceptance-[a-f0-9]{12}$/);
  const inspected = await run(docker, ["image", "inspect", image], { capture: true, allowFailure: true });
  if (inspected.status === 0) await run(docker, ["image", "rm", image], { capture: true });
}

async function removeNetworkIfPresent(network) {
  assert.match(network, networkPattern);
  const inspected = await run(docker, ["network", "inspect", network], { capture: true, allowFailure: true });
  if (inspected.status === 0) await run(docker, ["network", "rm", network], { capture: true });
}

async function assertNetworkAbsent(network) {
  assert.match(network, networkPattern);
  const result = await run(docker, ["network", "inspect", network], { capture: true, allowFailure: true });
  assert.notEqual(result.status, 0, `${network} still exists`);
}

async function assertImageAbsent(image) {
  assert.match(image, /^hyperion\/(?:access|audit)-migrations:acceptance-[a-f0-9]{12}$/);
  const result = await run(docker, ["image", "inspect", image], { capture: true, allowFailure: true });
  assert.notEqual(result.status, 0, `${image} still exists`);
}

async function safeRemoveTemporary(directory, network) {
  const resolved = path.resolve(directory);
  const temporaryRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), temporaryRoot, "temporary acceptance directory escaped the OS temp root");
  assert.match(path.basename(resolved), temporaryPattern);
  assert.ok(path.basename(resolved).startsWith(`${network}-`));
  await rm(resolved, { recursive: true, force: true });
}

function assertSafeProject(projectName) {
  assert.match(
    projectName,
    new RegExp(`^(?:${platformProjectPattern.source.slice(1, -1)}|${novaProjectPattern.source.slice(1, -1)})$`)
  );
}

async function captureCleanup(errors, cleanup) {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

function acceptanceSecrets() {
  return { novaBffToAccess: secret("nova-access"), novaToAudit: secret("nova-audit") };
}

function secret(prefix) {
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

function randomDigits(length) {
  return Array.from(randomBytes(length), (value) => String(value % 10)).join("");
}

function uniqueSetCookie(setCookies, name) {
  const matching = setCookies.filter((cookie) => cookie.trimStart().startsWith(`${name}=`));
  return matching.length === 1 ? matching[0].trim() : undefined;
}

function parsePsqlJson(output) {
  const line = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ? JSON.parse(line) : undefined;
}

function phase(message) {
  process.stdout.write(`[platform-nova-acceptance] ${message}\n`);
}

function commandEnvironment(overrides = {}) {
  return {
    ...Object.fromEntries(
      allowedParentEnvironment
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]])
    ),
    ...overrides,
    // Docker Compose otherwise discovers a repository-local .env implicitly.
    // The rehearsal accepts only the generated allowlisted environment above.
    COMPOSE_DISABLE_ENV_FILE: "1"
  };
}

function run(command, arguments_, { environment = {}, input, capture = false, allowFailure = false } = {}) {
  throwIfInterrupted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: commandEnvironment(environment),
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"]
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      const status = code ?? 1;
      if (status !== 0 && !allowFailure) {
        reject(new Error(`${path.basename(command)} failed (status=${status}, signal=${signal ?? "none"})`));
      } else {
        resolve({ status, stdout, stderr });
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function handleSignal(signal) {
  receivedSignal = signal;
  if (cleanupMode) return;
  acceptanceAbortController?.abort(new Error(`Platform-NOVA acceptance interrupted by ${signal}`));
  activeChild?.kill("SIGTERM");
}

function throwIfInterrupted() {
  if (!cleanupMode && receivedSignal) {
    throw new Error(`Platform-NOVA acceptance interrupted by ${receivedSignal}`);
  }
}

function acceptanceFetchSignal(timeoutMilliseconds) {
  const timeout = AbortSignal.timeout(timeoutMilliseconds);
  const acceptanceSignal = acceptanceAbortController?.signal;
  return acceptanceSignal ? AbortSignal.any([acceptanceSignal, timeout]) : timeout;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  try {
    await runPlatformNovaAcceptance(process.env);
  } catch (error) {
    process.stderr.write(
      `Platform-NOVA acceptance failed: ${error instanceof Error ? error.message : "unknown error"}\n`
    );
    process.exitCode = receivedSignal ? 130 : 1;
  }
}
