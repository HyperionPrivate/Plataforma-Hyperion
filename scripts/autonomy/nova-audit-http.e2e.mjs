#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const novaDatabaseUrl = requiredEnvironment("TEST_NOVA_DATABASE_URL");
const auditDatabaseUrl = requiredEnvironment("TEST_AUDIT_DATABASE_URL");
validateAcceptanceDatabaseTargets(novaDatabaseUrl, auditDatabaseUrl);
const databaseModuleUrl = pathToFileURL(path.join(repositoryRoot, "packages/database/dist/index.js")).href;

const { createDatabase } = await import(databaseModuleUrl);

const novaDb = createDatabase(novaDatabaseUrl);
const auditDb = createDatabase(auditDatabaseUrl);
const children = [];
let auditProxy;

try {
  const tenantId = randomUUID();
  const operatorId = randomUUID();
  const phone = `+5731${randomDigits(8)}`;
  const novaPort = await reservePort();
  const auditPort = await reservePort();
  assert.notEqual(novaPort, auditPort);
  auditProxy = await createAuditFaultProxy();

  const novaBffToken = randomSecret("nova-bff");
  const novaToAuditToken = randomSecret("nova-audit");
  const assertionKey = randomSecret("operator-assertion");
  const auditUrl = `http://127.0.0.1:${auditPort}`;
  const novaUrl = `http://127.0.0.1:${novaPort}`;

  const nova = startService("nova-core-service", "services/nova-core-service/dist/index.js", {
    DATABASE_URL: novaDatabaseUrl,
    EXPECTED_DATABASE_ROLE: "hyperion_nova",
    PORT: String(novaPort),
    NOVA_BFF_TO_NOVA_TOKEN: novaBffToken,
    NOVA_OPERATOR_ASSERTION_KEY: assertionKey,
    NOVA_TO_AUDIT_TOKEN: novaToAuditToken,
    AUDIT_SERVICE_URL: auditProxy.url,
    CORE_MODE: "contract"
  });
  children.push(nova);
  await waitForService(nova, `${novaUrl}/ready`, "nova-core-service");

  const operatorHeaders = createNovaOperatorHeaders({
    assertionKey,
    novaBffToken,
    operatorId,
    tenantId
  });
  await expectStatus(
    `${novaUrl}/v1/tenants/${tenantId}/nova/bootstrap`,
    {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ display_name: "NOVA Audit acceptance", agencies: [] })
    },
    201
  );
  const importResponse = await expectStatus(
    `${novaUrl}/v1/tenants/${tenantId}/nova/contacts/import`,
    {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ contacts: [{ phone_e164: phone, full_name: "Acceptance Contact" }] })
    },
    201
  );
  const importBody = await importResponse.json();
  const contactId = importBody?.data?.imported?.[0]?.contact_id;
  assert.match(contactId ?? "", /^[0-9a-f-]{36}$/i);

  const failedDelivery = await waitForDatabaseState(
    async () => readNovaAuditOutbox(novaDb, tenantId, phone, contactId),
    (state) => state?.status === "pending" && state.attemptCount >= 1 && state.lastError === "network_error",
    "NOVA outbox did not persist the Audit outage as a retryable delivery",
    [nova]
  );
  assert.equal(failedDelivery.entityId, contactId);
  assert.equal(failedDelivery.phone, phone);
  assert.equal(failedDelivery.businessIdempotencyKey, `contact-import:${tenantId}:${phone}`);

  const audit = startService("audit-service", "services/audit-service/dist/index.js", {
    DATABASE_URL: auditDatabaseUrl,
    EXPECTED_DATABASE_ROLE: "hyperion_audit",
    PORT: String(auditPort),
    DURABLE_EVENT_TRANSPORT: "http",
    NOVA_TO_AUDIT_TOKEN: novaToAuditToken
  });
  children.push(audit);
  await waitForService(audit, `${auditUrl}/ready`, "audit-service");
  auditProxy.recover(auditUrl);

  const lostAcknowledgementDelivery = await waitForDatabaseState(
    async () => readNovaAuditOutbox(novaDb, tenantId, phone, contactId),
    (state) => state?.status === "pending" && state.attemptCount >= 2 && state.lastError === "network_error",
    "NOVA did not retry after Audit committed but its acknowledgement was lost",
    [nova, audit]
  );
  assert.equal(lostAcknowledgementDelivery.eventId, failedDelivery.eventId);
  assert.deepEqual(await readAuditPersistence(auditDb, failedDelivery.eventId), { inboxCount: 1, auditCount: 1 });

  const completedDelivery = await waitForDatabaseState(
    async () => readNovaAuditOutbox(novaDb, tenantId, phone, contactId),
    (state) => state?.status === "completed" && state.attemptCount >= 3,
    "NOVA outbox did not drain after Audit acknowledged the duplicate retry",
    [nova, audit]
  );
  assert.equal(completedDelivery.eventId, failedDelivery.eventId);

  assert.equal(auditProxy.deliveries.length, 2);
  assert.deepEqual(
    auditProxy.deliveries.map((delivery) => delivery.status),
    [201, 200]
  );
  assert.equal(auditProxy.deliveries[0].body, auditProxy.deliveries[1].body);
  for (const delivery of auditProxy.deliveries) {
    assert.equal(delivery.caller, "nova-core-service");
    assert.equal(delivery.eventId, completedDelivery.eventId);
    assert.equal(JSON.parse(delivery.body).id, completedDelivery.eventId);
  }
  assert.equal(auditProxy.deliveries[1].response?.data?.status, "duplicate");

  const afterRetry = await readAuditPersistence(auditDb, completedDelivery.eventId);
  assert.deepEqual(afterRetry, { inboxCount: 1, auditCount: 1 });

  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      eventId: completedDelivery.eventId,
      outageAttemptCount: failedDelivery.attemptCount,
      lostAcknowledgementAttemptCount: lostAcknowledgementDelivery.attemptCount,
      completedAttemptCount: completedDelivery.attemptCount,
      auditHttpStatuses: auditProxy.deliveries.map((delivery) => delivery.status),
      logicalAuditRecords: afterRetry.auditCount
    })}\n`
  );
} finally {
  await Promise.allSettled(children.reverse().map((child) => stopService(child)));
  await auditProxy?.close();
  await Promise.allSettled([novaDb.close(), auditDb.close()]);
}

function startService(name, relativeEntrypoint, extraEnvironment) {
  const logs = [];
  const child = spawn(process.execPath, [path.join(repositoryRoot, relativeEntrypoint)], {
    cwd: repositoryRoot,
    env: {
      ...minimalProcessEnvironment(),
      CI: "true",
      NODE_ENV: "test",
      HYPERION_ENVIRONMENT: "ci",
      HOST: "127.0.0.1",
      SERVICE_VERSION: "acceptance",
      SHUTDOWN_TIMEOUT_MS: "65000",
      ...extraEnvironment
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logs.push(String(chunk));
      if (logs.length > 200) logs.shift();
    });
  }
  return { name, child, logs };
}

async function stopService(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  service.child.kill("SIGTERM");
  const result = await Promise.race([once(service.child, "exit").then(() => "exited"), delay(12_000, "timeout")]);
  if (result === "timeout" && service.child.exitCode === null) {
    service.child.kill("SIGKILL");
    await once(service.child, "exit");
  }
}

async function waitForService(service, url, expectedService) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    assertServiceRunning(service);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json();
      if (response.ok && body?.status === "ok" && body?.service === expectedService) return;
    } catch {
      // The service may still be binding its socket or checking its ledger.
    }
    await delay(100);
  }
  throw serviceFailure(service, `${expectedService} did not become ready at ${url}`);
}

function assertServiceRunning(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) {
    throw serviceFailure(service, `${service.name} exited before the acceptance flow completed`);
  }
}

function serviceFailure(service, message) {
  const suffix = service.logs.join("").trim();
  return new Error(suffix ? `${message}\n${suffix}` : message);
}

async function expectStatus(url, init, expectedStatus) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000), redirect: "error" });
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${url} returned ${response.status}: ${await response.text()}`);
  }
  return response;
}

function createNovaOperatorHeaders({ assertionKey, novaBffToken, operatorId, tenantId }) {
  const role = "admin";
  const expiresAtUnix = Math.floor(Date.now() / 1000) + 300;
  const payload = `${operatorId}|${role}|${tenantId}|NOVA|${expiresAtUnix}`;
  const signature = createHmac("sha256", assertionKey).update(payload).digest("base64url");
  return {
    authorization: `Bearer ${novaBffToken}`,
    "content-type": "application/json",
    "x-hyperion-caller": "nova-bff",
    "x-hyperion-operator-assertion": `${payload}|${signature}`,
    "x-operator-id": operatorId,
    "x-operator-role": role
  };
}

async function readNovaAuditOutbox(db, tenantId, phone, contactId) {
  const result = await db.query(
    `select event_id::text as "eventId",
            event_type as "eventType",
            status,
            attempt_count::int as "attemptCount",
            last_error as "lastError",
            payload->>'entityId' as "entityId",
            payload #>> '{metadata,businessIdempotencyKey}' as "businessIdempotencyKey",
            payload #>> '{metadata,domainPayload,phone_e164}' as phone,
            payload,
            created_at as "createdAt"
       from nova.outbox_events
      where tenant_id = $1
        and event_type = 'nova.audit.event.record.v1'
        and payload->>'eventType' = 'contact.imported'
        and payload #>> '{metadata,domainPayload,phone_e164}' = $2
        and payload->>'entityId' = $3
      order by created_at desc
      limit 1`,
    [tenantId, phone, contactId]
  );
  return result.rows[0];
}

async function readAuditPersistence(db, eventId) {
  const result = await db.query(
    `select (select count(*)::int from audit_runtime.inbox_events where event_id = $1) as "inboxCount",
            (select count(*)::int from platform.audit_events where source_event_id = $1) as "auditCount"`,
    [eventId]
  );
  return result.rows[0];
}

async function waitForDatabaseState(read, predicate, failureMessage, services = []) {
  let lastState;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    for (const service of services) assertServiceRunning(service);
    lastState = await read();
    if (predicate(lastState)) return lastState;
    await delay(100);
  }
  throw new Error(`${failureMessage}; last state: ${JSON.stringify(lastState)}`);
}

async function createAuditFaultProxy() {
  let targetUrl;
  let dropNextAcknowledgement = true;
  const deliveries = [];
  const server = createHttpServer((request, response) => {
    void handleRequest(request, response).catch(() => response.destroy());
  });
  server.unref();

  async function handleRequest(request, response) {
    if (!targetUrl) {
      request.resume();
      request.socket.destroy();
      return;
    }
    if (request.method !== "POST" || request.url !== "/internal/v1/events") {
      request.resume();
      response.writeHead(404).end();
      return;
    }

    const body = await readBoundedBody(request, 1024 * 1024);
    const upstream = await fetch(`${targetUrl}/internal/v1/events`, {
      method: "POST",
      headers: forwardedHeaders(request.headers),
      body,
      redirect: "error",
      signal: AbortSignal.timeout(5_000)
    });
    const responseBody = await upstream.text();
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseBody);
    } catch {
      parsedResponse = undefined;
    }
    deliveries.push({
      body: body.toString("utf8"),
      caller: singleHeader(request.headers["x-hyperion-caller"]),
      eventId: singleHeader(request.headers["x-hyperion-event-id"]),
      status: upstream.status,
      response: parsedResponse
    });

    if (dropNextAcknowledgement) {
      dropNextAcknowledgement = false;
      response.destroy();
      return;
    }

    const contentType = upstream.headers.get("content-type");
    response.writeHead(upstream.status, contentType ? { "content-type": contentType } : undefined);
    response.end(responseBody);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");

  return {
    url: `http://127.0.0.1:${address.port}`,
    deliveries,
    recover(url) {
      const parsed = new URL(url);
      assert.equal(parsed.protocol, "http:");
      assert.equal(parsed.hostname, "127.0.0.1");
      targetUrl = url.replace(/\/$/, "");
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function readBoundedBody(request, maximumBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBytes) {
      request.destroy();
      throw new Error("Audit fault-proxy request exceeded its acceptance bound");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, length);
}

function forwardedHeaders(incoming) {
  const headers = new Headers();
  const hopByHop = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);
  for (const [name, value] of Object.entries(incoming)) {
    if (hopByHop.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function singleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function reservePort() {
  const server = net.createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function minimalProcessEnvironment() {
  return Object.fromEntries(
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
      "TEMP",
      "TMP",
      "LANG"
    ]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])
  );
}

function randomSecret(prefix) {
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

function randomDigits(length) {
  return Array.from(randomBytes(length), (value) => String(value % 10)).join("");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateAcceptanceDatabaseTargets(novaUrl, auditUrl) {
  const nova = parseAcceptanceDatabaseTarget(novaUrl, "TEST_NOVA_DATABASE_URL");
  const audit = parseAcceptanceDatabaseTarget(auditUrl, "TEST_AUDIT_DATABASE_URL");
  assert.notEqual(
    `${nova.hostname}:${nova.port || "5432"}${nova.pathname}`,
    `${audit.hostname}:${audit.port || "5432"}${audit.pathname}`,
    "NOVA and Audit acceptance databases must be distinct"
  );
}

function parseAcceptanceDatabaseTarget(value, name) {
  const parsed = new URL(value);
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error(`${name} must use PostgreSQL`);
  }
  if (!new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(parsed.hostname)) {
    throw new Error(`${name} must target a loopback database host`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/_(?:ci|acceptance)$/.test(databaseName)) {
    throw new Error(`${name} must target a disposable database ending in _ci or _acceptance`);
  }
  return parsed;
}
