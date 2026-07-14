import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { createDatabase } from "../../packages/database/dist/index.js";
import { HYPERION_EVENTS_STREAM, JetStreamOutboxDispatcher } from "../../packages/durable-events/dist/index.js";
import { PostgresAgentOutbox } from "../../services/agent-service/dist/agent-outbox.js";
import {
  PULSO_MESSAGE_EVENT_TYPE,
  startPulsoMessageJetStreamConsumers
} from "../../services/agent-service/dist/pulso-jetstream.js";
import { startAuditEventJetStreamConsumers } from "../../services/audit-service/dist/audit-jetstream.js";
import { AUDIT_EVENT_CONTRACTS } from "../../services/audit-service/dist/event-inbox.js";
import { PostgresPulsoOutbox } from "../../services/pulso-iris-service/dist/pulso-outbox.js";
import {
  CHANNEL_INBOUND_EVENT_TYPE,
  startChannelInboundJetStreamConsumer
} from "../../services/pulso-iris-service/dist/channel-inbound-jetstream.js";
import { PostgresChannelOutbox } from "../../services/whatsapp-channel-service/dist/channel-outbox.js";
import { PostgresChannelRepository } from "../../services/whatsapp-channel-service/dist/channel-repository.js";

const EVENT_TIME = new Date("2026-07-13T15:00:00.000Z");
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const NATS_SECRET_PATTERN = /^[A-Za-z][A-Za-z0-9._~-]{23,}$/;

let phase = "configuration";
let failureDiagnostics;

try {
  const effects = await run();
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      flow: "Channel->PULSO->SOFIA->Audit",
      transport: "JetStream",
      effects
    })}\n`
  );
} catch (error) {
  const errorCode =
    error instanceof Error && /^[a-z0-9_]{1,128}$/.test(error.message) ? error.message : "autonomy_e2e_failed";
  process.stderr.write(`${JSON.stringify({ status: "failed", phase, errorCode, diagnostics: failureDiagnostics })}\n`);
  process.exitCode = 1;
}

async function run() {
  const configuration = readConfiguration(process.env);
  const adminDb = createDatabase(configuration.adminDatabaseUrl);
  const channelDb = createDatabase(serviceDatabaseUrl(configuration, "hyperion_channel", "CHANNEL_DATABASE_PASSWORD"));
  const pulsoDb = createDatabase(serviceDatabaseUrl(configuration, "hyperion_pulso", "PULSO_DATABASE_PASSWORD"));
  const sofiaDb = createDatabase(serviceDatabaseUrl(configuration, "hyperion_sofia", "SOFIA_DATABASE_PASSWORD"));
  const auditDb = createDatabase(serviceDatabaseUrl(configuration, "hyperion_audit", "AUDIT_DATABASE_PASSWORD"));
  const databases = [channelDb, pulsoDb, sofiaDb, auditDb, adminDb];
  const consumers = [];
  const dispatchers = [];
  const runId = randomUUID();
  let verified = false;
  let tenantId;

  try {
    phase = "database-role-verification";
    await Promise.all([
      assertRuntimeRole(channelDb, "hyperion_channel"),
      assertRuntimeRole(pulsoDb, "hyperion_pulso"),
      assertRuntimeRole(sofiaDb, "hyperion_sofia"),
      assertRuntimeRole(auditDb, "hyperion_audit")
    ]);

    phase = "synthetic-fixture";
    tenantId = await createSyntheticTenant(adminDb, runId);

    phase = "consumer-startup";
    consumers.push(
      await startChannelInboundJetStreamConsumer(() => undefined, pulsoDb, {
        natsUrl: configuration.natsUrl,
        username: "pulso",
        password: configuration.natsPasswords.PULSO
      })
    );
    consumers.push(
      ...(await startPulsoMessageJetStreamConsumers(sofiaDb, {
        natsUrl: configuration.natsUrl,
        username: "sofia",
        password: configuration.natsPasswords.SOFIA
      }))
    );
    const auditConsumers = await startAuditEventJetStreamConsumers(() => undefined, auditDb, {
      transport: "jetstream",
      natsUrl: configuration.natsUrl,
      username: "audit",
      password: configuration.natsPasswords.AUDIT
    });
    consumers.push(...auditConsumers.map(({ consumer }) => consumer));

    const channelOutbox = new PostgresChannelOutbox(channelDb, `channel-e2e-${runId}`, "http://unused.invalid");
    const pulsoOutbox = new PostgresPulsoOutbox(pulsoDb, `pulso-e2e-${runId}`, "http://unused.invalid");
    const agentOutbox = new PostgresAgentOutbox(sofiaDb, `sofia-e2e-${runId}`, "http://unused.invalid");
    const channelDispatcher = jetStreamDispatcher(channelOutbox, {
      workerId: `channel-e2e-${runId}`,
      natsUrl: configuration.natsUrl,
      username: "channel",
      password: configuration.natsPasswords.CHANNEL
    });
    const pulsoDispatcher = jetStreamDispatcher(pulsoOutbox, {
      workerId: `pulso-e2e-${runId}`,
      natsUrl: configuration.natsUrl,
      username: "pulso",
      password: configuration.natsPasswords.PULSO
    });
    const agentDispatcher = jetStreamDispatcher(agentOutbox, {
      workerId: `sofia-e2e-${runId}`,
      natsUrl: configuration.natsUrl,
      username: "sofia",
      password: configuration.natsPasswords.SOFIA
    });
    dispatchers.push(channelDispatcher, pulsoDispatcher, agentDispatcher);

    phase = "channel-persistence";
    const channelRepository = new PostgresChannelRepository(channelDb);
    await channelRepository.projectConnection(tenantId, {
      providerMode: "whatsapp_web_test",
      state: "ready",
      phoneMasked: "********4242",
      lastActivityAt: EVENT_TIME.toISOString(),
      sessionRestorable: false
    });
    const inbound = syntheticInbound(tenantId, runId);
    const firstPersistence = await channelRepository.persistInbound(inbound);
    assert.equal(firstPersistence.inserted, true);

    const channelEvent = await oneRow(adminDb, "channel outbox event", {
      text: `select id, status, attempt_count as "attemptCount"
               from channel_runtime.outbox_events
              where tenant_id = $1 and aggregate_id = $2 and event_type = $3`,
      values: [tenantId, firstPersistence.eventId, CHANNEL_INBOUND_EVENT_TYPE]
    });
    assert.deepEqual(channelEvent, { id: channelEvent.id, status: "queued", attemptCount: 0 });

    phase = "channel-to-pulso";
    assertDrain(await channelDispatcher.drainOnce(), "channel");
    const pulsoProjection = await eventually("PULSO projection", () =>
      queryOneOrUndefined(adminDb, {
        text: `select inbox.processed_at as "processedAt", outbox.id as "outboxEventId",
                      outbox.status as "outboxStatus", message.id as "messageId"
                 from pulso_iris.inbox_events inbox
                 join pulso_iris.outbox_events outbox
                  on outbox.tenant_id = inbox.tenant_id
                  and outbox.event_type = $4
                 join pulso_iris.messages message
                   on message.tenant_id = inbox.tenant_id
                  and message.external_message_id = $3
                where inbox.event_id = $1 and inbox.tenant_id = $2`,
        values: [channelEvent.id, tenantId, inbound.externalMessageId, PULSO_MESSAGE_EVENT_TYPE]
      })
    );
    assert.ok(pulsoProjection.processedAt);
    assert.equal(pulsoProjection.outboxStatus, "queued");

    phase = "pulso-to-sofia";
    assertDrain(await pulsoDispatcher.drainOnce(), "pulso");
    const sofiaProjection = await eventually("SOFIA projection", () =>
      queryOneOrUndefined(adminDb, {
        text: `select inbox.processed_at as "processedAt", job.id as "jobId",
                      outbox.id as "outboxEventId", outbox.status as "outboxStatus"
                 from agent_runtime.inbox_events inbox
                 join agent_runtime.jobs job
                   on job.tenant_id = inbox.tenant_id
                  and job.id = (inbox.result->>'jobId')::uuid
                 join agent_runtime.outbox_events outbox
                  on outbox.tenant_id = job.tenant_id
                  and outbox.aggregate_id = job.id
                  and outbox.event_type = $3
                where inbox.event_id = $1 and inbox.tenant_id = $2`,
        values: [pulsoProjection.outboxEventId, tenantId, AUDIT_EVENT_CONTRACTS.sofia.eventType]
      })
    );
    assert.ok(sofiaProjection.processedAt);
    assert.equal(sofiaProjection.outboxStatus, "queued");

    phase = "sofia-to-audit";
    assertDrain(await agentDispatcher.drainOnce(), "sofia");
    const auditProjection = await eventually("Audit projection", () =>
      queryOneOrUndefined(adminDb, {
        text: `select ledger.id as "auditEventId", ledger.source_event_id as "sourceEventId",
                      ledger.actor_id as "actorId", ledger.event_type as "eventType",
                      ledger.entity_id as "entityId"
                 from audit_runtime.inbox_events inbox
                 join platform.audit_events ledger on ledger.source_event_id = inbox.event_id
                where inbox.event_id = $1 and inbox.tenant_id = $2`,
        values: [sofiaProjection.outboxEventId, tenantId]
      })
    );
    assert.equal(auditProjection.sourceEventId, sofiaProjection.outboxEventId);
    assert.equal(auditProjection.actorId, "agent:SOFIA");
    assert.equal(auditProjection.eventType, "agent.job.queued");
    assert.equal(auditProjection.entityId, sofiaProjection.jobId);

    phase = "idempotency-replay";
    const replay = await channelRepository.persistInbound(inbound);
    assert.deepEqual(replay, { ...firstPersistence, inserted: false });
    const replayDrain = await channelDispatcher.drainOnce();
    assert.equal(replayDrain.claimed, 0);
    assert.equal(replayDrain.completed, 0);

    phase = "exactly-once-verification";
    const counts = await oneRow(adminDb, "flow counts", {
      text: `select
        (select count(*)::int from channel_runtime.inbound_events
          where tenant_id = $1 and id = $2 and status = 'processed') as "channelInbox",
        (select count(*)::int from channel_runtime.outbox_events
          where tenant_id = $1 and aggregate_id = $2 and status = 'published') as "channelOutbox",
        (select count(*)::int from pulso_iris.inbox_events
          where tenant_id = $1 and event_id = $3 and processed_at is not null) as "pulsoInbox",
        (select count(*)::int from pulso_iris.messages
          where tenant_id = $1 and external_message_id = $4) as "pulsoEffect",
        (select count(*)::int from pulso_iris.outbox_events
          where tenant_id = $1 and id = $5 and status = 'published') as "pulsoOutbox",
        (select count(*)::int from agent_runtime.inbox_events
          where tenant_id = $1 and event_id = $5 and processed_at is not null) as "sofiaInbox",
        (select count(*)::int from agent_runtime.jobs
          where tenant_id = $1 and id = $6) as "sofiaEffect",
        (select count(*)::int from agent_runtime.outbox_events
          where tenant_id = $1 and id = $7 and status = 'published') as "sofiaOutbox",
        (select count(*)::int from audit_runtime.inbox_events
          where tenant_id = $1 and event_id = $7) as "auditInbox",
        (select count(*)::int from platform.audit_events
          where tenant_id = $1 and source_event_id = $7) as "auditEffect"`,
      values: [
        tenantId,
        firstPersistence.eventId,
        channelEvent.id,
        inbound.externalMessageId,
        pulsoProjection.outboxEventId,
        sofiaProjection.jobId,
        sofiaProjection.outboxEventId
      ]
    });
    assert.deepEqual(counts, {
      channelInbox: 1,
      channelOutbox: 1,
      pulsoInbox: 1,
      pulsoEffect: 1,
      pulsoOutbox: 1,
      sofiaInbox: 1,
      sofiaEffect: 1,
      sofiaOutbox: 1,
      auditInbox: 1,
      auditEffect: 1
    });

    verified = true;
    return counts;
  } catch (error) {
    if (tenantId) {
      try {
        failureDiagnostics = await collectFailureDiagnostics(adminDb, tenantId);
      } catch {
        failureDiagnostics = { snapshot: "unavailable" };
      }
    }
    throw error;
  } finally {
    if (verified) phase = "cleanup";
    await Promise.allSettled(dispatchers.map((dispatcher) => dispatcher.stop()));
    await Promise.allSettled(consumers.map((consumer) => consumer.stop()));
    try {
      if (tenantId) await cleanupSyntheticTenant(adminDb, tenantId);
    } finally {
      await Promise.allSettled(databases.map((database) => database.close()));
    }
  }
}

function readConfiguration(environment) {
  const adminDatabaseUrl = requiredEnvironment(environment, "TEST_DATABASE_URL");
  const parsedDatabaseUrl = safeUrl(adminDatabaseUrl, "TEST_DATABASE_URL");
  if (parsedDatabaseUrl.protocol !== "postgres:" && parsedDatabaseUrl.protocol !== "postgresql:") {
    throw new Error("invalid_database_protocol");
  }

  const natsUrl = requiredEnvironment(environment, "NATS_URL");
  const parsedNatsUrl = safeUrl(natsUrl, "NATS_URL");
  if (
    parsedNatsUrl.protocol !== "nats:" ||
    !parsedNatsUrl.hostname ||
    parsedNatsUrl.username ||
    parsedNatsUrl.password ||
    parsedNatsUrl.pathname !== "" ||
    parsedNatsUrl.search ||
    parsedNatsUrl.hash
  ) {
    throw new Error("invalid_nats_url");
  }

  const natsPasswords = {
    CHANNEL: requiredNatsPassword(environment, "NATS_CHANNEL_PASSWORD"),
    PULSO: requiredNatsPassword(environment, "NATS_PULSO_PASSWORD"),
    SOFIA: requiredNatsPassword(environment, "NATS_SOFIA_PASSWORD"),
    AUDIT: requiredNatsPassword(environment, "NATS_AUDIT_PASSWORD")
  };
  assert.equal(new Set(Object.values(natsPasswords)).size, Object.keys(natsPasswords).length);

  const databasePasswords = [
    "CHANNEL_DATABASE_PASSWORD",
    "PULSO_DATABASE_PASSWORD",
    "SOFIA_DATABASE_PASSWORD",
    "AUDIT_DATABASE_PASSWORD"
  ].map((name) => {
    const password = requiredEnvironment(environment, name);
    if (!/^[A-Za-z0-9._~-]{24,}$/.test(password)) throw new Error(`invalid_${name.toLowerCase()}`);
    return password;
  });
  assert.equal(new Set(databasePasswords).size, databasePasswords.length);

  return { adminDatabaseUrl, parsedDatabaseUrl, natsUrl, natsPasswords, environment };
}

function serviceDatabaseUrl(configuration, role, passwordName) {
  const url = new URL(configuration.parsedDatabaseUrl);
  url.username = role;
  url.password = requiredEnvironment(configuration.environment, passwordName);
  return url.toString();
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function requiredNatsPassword(environment, name) {
  const password = requiredEnvironment(environment, name);
  if (!NATS_SECRET_PATTERN.test(password)) throw new Error(`invalid_${name.toLowerCase()}`);
  return password;
}

function safeUrl(value, name) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`invalid_${name.toLowerCase()}`);
  }
}

async function assertRuntimeRole(database, expectedRole) {
  const result = await database.query(
    `select current_user as role, rolcanlogin as "canLogin", rolsuper as "superuser",
            rolcreatedb as "createDatabase", rolcreaterole as "createRole",
            rolinherit as inherit, rolreplication as replication, rolbypassrls as "bypassRls"
       from pg_roles where rolname = current_user`
  );
  assert.deepEqual(result.rows[0], {
    role: expectedRole,
    canLogin: true,
    superuser: false,
    createDatabase: false,
    createRole: false,
    inherit: false,
    replication: false,
    bypassRls: false
  });
}

async function createSyntheticTenant(adminDb, runId) {
  const result = await adminDb.query(
    `insert into platform.tenants (slug, display_name, metadata)
     values ($1, 'Autonomy E2E synthetic tenant', '{"synthetic":true,"purpose":"autonomy_e2e"}'::jsonb)
     returning id`,
    [`autonomy-e2e-${runId}`]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0].id;
}

function syntheticInbound(tenantId, runId) {
  const opaqueAddress = `${runId}@synthetic.invalid`;
  return {
    tenantId,
    provider: "whatsapp_web_test",
    externalMessageId: `synthetic-message-${runId}`,
    providerAddress: opaqueAddress,
    phoneHash: createHash("sha256").update(`synthetic-contact-${runId}`).digest("hex"),
    phoneMasked: "********4242",
    body: "Mensaje sintetico para verificar el flujo autonomo.",
    receivedAt: EVENT_TIME
  };
}

function jetStreamDispatcher(outbox, configuration) {
  return new JetStreamOutboxDispatcher({
    workerId: configuration.workerId,
    servers: configuration.natsUrl,
    username: configuration.username,
    password: configuration.password,
    connectionName: configuration.workerId,
    subjectPrefix: "hyperion.events",
    expectedStream: HYPERION_EVENTS_STREAM,
    claim: (limit) => outbox.claim(limit),
    complete: (eventId) => outbox.complete(eventId),
    fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
    batchSize: 1,
    connectTimeoutMs: 5_000,
    publishTimeoutMs: 5_000
  });
}

function assertDrain(result, owner) {
  assert.equal(result.workerId.startsWith(`${owner}-e2e-`), true);
  assert.equal(result.claimFailed, false);
  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.callbackErrors, 0);
}

async function eventually(label, read) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`timeout_${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}`);
}

async function queryOneOrUndefined(database, query) {
  const result = await database.query(query.text, query.values);
  return result.rows[0];
}

async function oneRow(database, label, query) {
  const result = await database.query(query.text, query.values);
  assert.equal(result.rowCount, 1, `${label} must have exactly one row`);
  return result.rows[0];
}

async function cleanupSyntheticTenant(adminDb, tenantId) {
  await adminDb.query("delete from platform.tenants where id = $1", [tenantId]);
  await Promise.all([
    adminDb.query("delete from channel_runtime.outbox_events where tenant_id = $1", [tenantId]),
    adminDb.query("delete from pulso_iris.outbox_events where tenant_id = $1", [tenantId]),
    adminDb.query("delete from pulso_iris.inbox_events where tenant_id = $1", [tenantId]),
    adminDb.query("delete from pulso_iris.channel_threads where tenant_id = $1", [tenantId]),
    adminDb.query("delete from agent_runtime.outbox_events where tenant_id = $1", [tenantId]),
    adminDb.query("delete from agent_runtime.inbox_events where tenant_id = $1", [tenantId]),
    adminDb.query("delete from audit_runtime.inbox_events where tenant_id = $1", [tenantId]),
    adminDb.query("delete from platform.audit_events where tenant_id = $1", [tenantId])
  ]);
}

async function collectFailureDiagnostics(adminDb, tenantId) {
  return oneRow(adminDb, "failure diagnostics", {
    text: `select
      (select count(*)::int from channel_runtime.outbox_events
        where tenant_id = $1) as "channelOutbox",
      (select count(*)::int from channel_runtime.outbox_events
        where tenant_id = $1 and status = 'published') as "channelPublished",
      (select count(*)::int from pulso_iris.inbox_events
        where tenant_id = $1) as "pulsoInbox",
      (select count(*)::int from pulso_iris.inbox_events
        where tenant_id = $1 and processed_at is not null) as "pulsoProcessed",
      (select count(*)::int from pulso_iris.channel_threads
        where tenant_id = $1) as "pulsoThreads",
      (select count(*)::int from pulso_iris.messages
        where tenant_id = $1) as "pulsoMessages",
      (select count(*)::int from pulso_iris.outbox_events
        where tenant_id = $1) as "pulsoOutbox"`,
    values: [tenantId]
  });
}
