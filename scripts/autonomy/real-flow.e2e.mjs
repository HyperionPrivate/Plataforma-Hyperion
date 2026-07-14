import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { createDatabase } from "../../packages/database/dist/index.js";
import {
  DurableJetStreamConsumer,
  HYPERION_EVENTS_STREAM,
  JetStreamOutboxDispatcher
} from "../../packages/durable-events/dist/index.js";
import { createService } from "../../packages/service-runtime/dist/index.js";
import { PostgresAgentOutbox } from "../../services/agent-service/dist/agent-outbox.js";
import {
  PULSO_MESSAGE_EVENT_TYPE,
  startPulsoMessageJetStreamConsumers
} from "../../services/agent-service/dist/pulso-jetstream.js";
import { startAuditEventJetStreamConsumers } from "../../services/audit-service/dist/audit-jetstream.js";
import { AUDIT_EVENT_CONTRACTS } from "../../services/audit-service/dist/event-inbox.js";
import { createAuditClient } from "../../services/pulso-iris-service/dist/audit-client.js";
import { PostgresPulsoAuditOutbox } from "../../services/pulso-iris-service/dist/pulso-audit-outbox.js";
import { registerChannelDeliveryRoutes } from "../../services/pulso-iris-service/dist/channel-delivery-routes.js";
import { startChannelDeliveryJetStreamConsumer } from "../../services/pulso-iris-service/dist/channel-delivery-jetstream.js";
import { PostgresPulsoOutbox } from "../../services/pulso-iris-service/dist/pulso-outbox.js";
import {
  CHANNEL_INBOUND_EVENT_TYPE,
  startChannelInboundJetStreamConsumer
} from "../../services/pulso-iris-service/dist/channel-inbound-jetstream.js";
import { createChannelThreadClient } from "../../services/pulso-iris-service/dist/channel-thread-client.js";
import { PostgresChannelAuditOutbox } from "../../services/whatsapp-channel-service/dist/channel-audit-outbox.js";
import { PostgresChannelDeliveryOutbox } from "../../services/whatsapp-channel-service/dist/channel-delivery-outbox.js";
import { PostgresChannelOutbox } from "../../services/whatsapp-channel-service/dist/channel-outbox.js";
import { PostgresChannelRepository } from "../../services/whatsapp-channel-service/dist/channel-repository.js";
import { createPulsoDeliveryClient } from "../../services/whatsapp-channel-service/dist/pulso-delivery-client.js";
import { registerThreadBindRoutes } from "../../services/whatsapp-channel-service/dist/thread-bind-routes.js";

const EVENT_TIME = new Date("2026-07-13T15:00:00.000Z");
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const CHANNEL_CONSUMER_PULL_EXPIRES_MS = 1_000;
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
  const channelDatabaseUrl = serviceDatabaseUrl(configuration, "hyperion_channel", "CHANNEL_DATABASE_PASSWORD");
  const pulsoDatabaseUrl = serviceDatabaseUrl(configuration, "hyperion_pulso", "PULSO_DATABASE_PASSWORD");
  const channelDb = createDatabase(channelDatabaseUrl);
  const pulsoDb = createDatabase(pulsoDatabaseUrl);
  const sofiaDb = createDatabase(serviceDatabaseUrl(configuration, "hyperion_sofia", "SOFIA_DATABASE_PASSWORD"));
  const auditDb = createDatabase(serviceDatabaseUrl(configuration, "hyperion_audit", "AUDIT_DATABASE_PASSWORD"));
  const databases = [channelDb, pulsoDb, sofiaDb, auditDb, adminDb];
  const consumers = [];
  const dispatchers = [];
  const runId = randomUUID();
  let verified = false;
  let tenantId;
  let channelThreadContract;
  let pulsoDeliveryContract;

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

    phase = "channel-thread-contract";
    channelThreadContract = await startChannelThreadContractServer(channelDb, channelDatabaseUrl, runId);
    pulsoDeliveryContract = await startPulsoDeliveryContractServer(pulsoDb, pulsoDatabaseUrl, runId);

    phase = "consumer-startup";
    const channelConsumerProbe = createInspectableChannelConsumerFactory();
    consumers.push(
      await startChannelInboundJetStreamConsumer(
        () => undefined,
        pulsoDb,
        {
          natsUrl: configuration.natsUrl,
          username: "pulso",
          password: configuration.natsPasswords.PULSO,
          channelThreads: channelThreadContract.client
        },
        channelConsumerProbe.factory
      )
    );
    const channelDeliveryConsumerProbe = createInspectableDeliveryConsumerFactory();
    consumers.push(
      await startChannelDeliveryJetStreamConsumer(
        () => undefined,
        pulsoDb,
        {
          natsUrl: configuration.natsUrl,
          username: "pulso",
          password: configuration.natsPasswords.PULSO
        },
        channelDeliveryConsumerProbe.factory
      )
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
    const channelAuditOutbox = new PostgresChannelAuditOutbox(
      channelDb,
      `channel-audit-e2e-${runId}`,
      "http://unused.invalid"
    );
    const channelDeliveryOutbox = new PostgresChannelDeliveryOutbox(
      channelDb,
      `channel-delivery-e2e-${runId}`,
      "http://unused.invalid"
    );
    const pulsoOutbox = new PostgresPulsoOutbox(pulsoDb, `pulso-e2e-${runId}`, "http://unused.invalid");
    const pulsoAuditOutbox = new PostgresPulsoAuditOutbox(pulsoDb, `pulso-audit-e2e-${runId}`, "http://unused.invalid");
    const agentOutbox = new PostgresAgentOutbox(sofiaDb, `sofia-e2e-${runId}`, "http://unused.invalid");
    const channelDispatcher = jetStreamDispatcher(channelOutbox, {
      workerId: `channel-e2e-${runId}`,
      natsUrl: configuration.natsUrl,
      username: "channel",
      password: configuration.natsPasswords.CHANNEL
    });
    const channelAuditDispatcher = jetStreamDispatcher(channelAuditOutbox, {
      workerId: `channel-audit-e2e-${runId}`,
      natsUrl: configuration.natsUrl,
      username: "channel",
      password: configuration.natsPasswords.CHANNEL
    });
    const channelDeliveryDispatcher = jetStreamDispatcher(channelDeliveryOutbox, {
      workerId: `channel-delivery-e2e-${runId}`,
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
    const pulsoAuditDispatcher = jetStreamDispatcher(pulsoAuditOutbox, {
      workerId: `pulso-audit-e2e-${runId}`,
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
    dispatchers.push(
      channelDispatcher,
      channelAuditDispatcher,
      channelDeliveryDispatcher,
      pulsoDispatcher,
      pulsoAuditDispatcher,
      agentDispatcher
    );

    phase = "channel-persistence";
    const channelRepository = new PostgresChannelRepository(channelDb, pulsoDeliveryContract.client);
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
    const channelDelivery = await channelConsumerProbe.consumeOnce();
    assert.deepEqual(
      channelDelivery,
      { status: "acked", deliveryCount: 1 },
      "Channel->PULSO must receive a server-confirmed ACK without NAK, redelivery or DLQ"
    );
    assert.deepEqual(
      await channelConsumerProbe.consumeOnce(),
      { status: "idle" },
      "Channel->PULSO durable must have no pending message after the confirmed ACK"
    );
    const pulsoProjection = await eventually("PULSO projection", () =>
      queryOneOrUndefined(adminDb, {
        text: `select inbox.processed_at as "processedAt", outbox.id as "outboxEventId",
                      outbox.status as "outboxStatus", message.id as "messageId",
                      message.conversation_id as "conversationId", conversation.patient_id as "patientId"
                 from pulso_iris.inbox_events inbox
                 join pulso_iris.outbox_events outbox
                  on outbox.tenant_id = inbox.tenant_id
                  and outbox.event_type = $4
                 join pulso_iris.messages message
                   on message.tenant_id = inbox.tenant_id
                  and message.external_message_id = $3
                 join pulso_iris.conversations conversation
                   on conversation.tenant_id = message.tenant_id
                  and conversation.id = message.conversation_id
                where inbox.event_id = $1 and inbox.tenant_id = $2`,
        values: [channelEvent.id, tenantId, inbound.externalMessageId, PULSO_MESSAGE_EVENT_TYPE]
      })
    );
    assert.ok(pulsoProjection.processedAt);
    assert.equal(pulsoProjection.outboxStatus, "queued");

    const channelBinding = await oneRow(adminDb, "Channel owner binding", {
      text: `select binding.patient_id as "patientId", binding.conversation_id as "conversationId",
                    inbound.thread_binding_id as "eventThreadBindingId", inbound.message_id as "messageId"
               from channel_runtime.thread_bindings binding
               join channel_runtime.inbound_events inbound
                 on inbound.tenant_id = binding.tenant_id
                and inbound.thread_binding_id = binding.id
              where binding.tenant_id = $1 and binding.id = $2 and inbound.id = $3`,
      values: [tenantId, firstPersistence.threadBindingId, firstPersistence.eventId]
    });
    assert.deepEqual(channelBinding, {
      patientId: pulsoProjection.patientId,
      conversationId: pulsoProjection.conversationId,
      eventThreadBindingId: firstPersistence.threadBindingId,
      messageId: pulsoProjection.messageId
    });

    phase = "channel-delivery-to-pulso";
    const outboundBody = "Respuesta sintetica para verificar la entrega durable.";
    const outboundMessage = await oneRow(pulsoDb, "PULSO outbound fixture", {
      text: `insert into pulso_iris.messages (
               tenant_id, conversation_id, sender, body, provider, delivery_status, metadata
             ) values ($1, $2, 'sofia', $3, 'whatsapp_web_test', 'queued', '{"synthetic":true}'::jsonb)
             returning id`,
      values: [tenantId, pulsoProjection.conversationId, outboundBody]
    });
    const queued = await channelRepository.enqueueOutbound({
      tenantId,
      threadBindingId: firstPersistence.threadBindingId,
      messageId: outboundMessage.id,
      body: outboundBody,
      idempotencyKey: `autonomy-delivery-${runId}`
    });
    assert.equal(queued.inserted, true);
    const claimedOutbound = await channelRepository.claimOutbound(`autonomy-provider-${runId}`);
    assert.ok(claimedOutbound);
    assert.equal(await channelRepository.markOutboundSending(claimedOutbound), true);
    const providerMessageId = `synthetic-provider-${runId}`;
    assert.equal(await channelRepository.markOutboundSent(claimedOutbound, providerMessageId, EVENT_TIME), true);
    const channelDeliveryEvent = await oneRow(adminDb, "Channel delivery outbox event", {
      text: `select id, status, stream_id as "streamId", stream_sequence::int as "streamSequence"
               from channel_runtime.outbox_events
              where tenant_id = $1 and event_type = 'channel.delivery.updated.v1'
                and payload->>'messageId' = $2`,
      values: [tenantId, outboundMessage.id]
    });
    assert.deepEqual(channelDeliveryEvent, {
      id: channelDeliveryEvent.id,
      status: "queued",
      streamId: outboundMessage.id,
      streamSequence: 1
    });
    const deliveryBeforeDispatch = await oneRow(pulsoDb, "PULSO delivery before dispatch", {
      text: `select delivery_status as "deliveryStatus" from pulso_iris.messages where tenant_id = $1 and id = $2`,
      values: [tenantId, outboundMessage.id]
    });
    assert.equal(deliveryBeforeDispatch.deliveryStatus, "queued");

    assertDrain(await channelDeliveryDispatcher.drainOnce(), "channel-delivery");
    assert.deepEqual(
      await channelDeliveryConsumerProbe.consumeOnce(),
      { status: "acked", deliveryCount: 1 },
      "Channel delivery must receive a confirmed ACK without NAK, redelivery or DLQ"
    );
    assert.deepEqual(await channelDeliveryConsumerProbe.consumeOnce(), { status: "idle" });
    const deliveryProjection = await oneRow(adminDb, "PULSO delivery projection", {
      text: `select inbox.processed_at as "processedAt", message.delivery_status as "deliveryStatus",
                    message.provider_message_id as "providerMessageId"
               from pulso_iris.inbox_events inbox
               join pulso_iris.messages message
                 on message.tenant_id = inbox.tenant_id
                and message.id = (inbox.result->>'messageId')::uuid
              where inbox.event_id = $1 and inbox.tenant_id = $2`,
      values: [channelDeliveryEvent.id, tenantId]
    });
    assert.ok(deliveryProjection.processedAt);
    assert.equal(deliveryProjection.deliveryStatus, "sent");
    assert.equal(deliveryProjection.providerMessageId, providerMessageId);

    phase = "channel-audit-to-ledger";
    const channelAuditEvent = await oneRow(adminDb, "Channel audit outbox event", {
      text: `select id, status
               from channel_runtime.outbox_events
              where tenant_id = $1 and event_type = $2 and payload->>'entityId' = $3`,
      values: [tenantId, AUDIT_EVENT_CONTRACTS.channel.eventType, outboundMessage.id]
    });
    assert.equal(channelAuditEvent.status, "queued");
    assertDrain(await channelAuditDispatcher.drainOnce(), "channel-audit");
    const channelAuditProjection = await eventually("Channel audit projection", () =>
      queryOneOrUndefined(adminDb, {
        text: `select inbox.received_at as "receivedAt", inbox.source_service as "sourceService",
                      ledger.event_type as "businessEventType", ledger.entity_id as "entityId"
                 from audit_runtime.inbox_events inbox
                 join platform.audit_events ledger on ledger.source_event_id = inbox.event_id
                where inbox.event_id = $1 and inbox.tenant_id = $2`,
        values: [channelAuditEvent.id, tenantId]
      })
    );
    assert.ok(channelAuditProjection.receivedAt);
    assert.equal(channelAuditProjection.sourceService, AUDIT_EVENT_CONTRACTS.channel.sourceService);
    assert.equal(channelAuditProjection.businessEventType, "channel.message.sent");
    assert.equal(channelAuditProjection.entityId, outboundMessage.id);

    phase = "pulso-transactional-audit-enqueue";
    const emitPulsoAudit = createAuditClient({
      logger: {
        warn: (message) => {
          throw new Error(`unexpected_pulso_audit_warning_${message.replaceAll(/[^a-z0-9]+/gi, "_")}`);
        }
      }
    });
    const pulsoAuditEntityId = randomUUID();
    const pulsoAuditFacts = [
      { suffix: `autonomy-config-revision-1-${runId}`, revision: 1 },
      { suffix: `autonomy-config-revision-2-${runId}`, revision: 2 }
    ];
    await pulsoDb.transaction(async (transaction) => {
      for (const fact of pulsoAuditFacts) {
        await emitPulsoAudit(
          {
            tenantId,
            actorId: "operator:autonomy-e2e",
            eventType: "config.updated",
            entityType: "configuration",
            entityId: pulsoAuditEntityId,
            idempotencyKey: fact.suffix,
            metadata: { revision: fact.revision }
          },
          transaction
        );
      }
    });
    const pulsoAuditEvents = await pulsoDb.query(
      `select id, aggregate_id as "aggregateId", status, attempt_count as "attemptCount",
              (payload#>>'{metadata,revision}')::int as revision
         from pulso_iris.outbox_events
        where tenant_id = $1 and event_type = $2 and payload->>'entityId' = $3
        order by (payload#>>'{metadata,revision}')::int`,
      [tenantId, AUDIT_EVENT_CONTRACTS.pulso.eventType, pulsoAuditEntityId]
    );
    assert.equal(pulsoAuditEvents.rowCount, 2);
    assert.equal(new Set(pulsoAuditEvents.rows.map((row) => row.id)).size, 2);
    for (const event of pulsoAuditEvents.rows) {
      assert.equal(event.aggregateId, event.id);
      assert.equal(event.status, "queued");
      assert.equal(event.attemptCount, 0);
    }
    assert.deepEqual(
      pulsoAuditEvents.rows.map((event) => event.revision),
      [1, 2]
    );

    phase = "pulso-to-sofia";
    assertDrain(await pulsoDispatcher.drainOnce(), "pulso");
    const untouchedPulsoAudits = await oneRow(pulsoDb, "queued PULSO audits after message drain", {
      text: `select count(*)::int as count
               from pulso_iris.outbox_events
              where tenant_id = $1 and id in ($2::uuid, $3::uuid)
                and status = 'queued' and attempt_count = 0`,
      values: [tenantId, pulsoAuditEvents.rows[0].id, pulsoAuditEvents.rows[1].id]
    });
    assert.equal(untouchedPulsoAudits.count, 2);
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

    phase = "pulso-audit-to-ledger";
    for (const event of pulsoAuditEvents.rows) {
      assert.ok(event.id);
      assertDrain(await pulsoAuditDispatcher.drainOnce(), "pulso-audit");
    }
    const pulsoAuditProjection = await eventually("PULSO audit projections", async () => {
      const result = await adminDb.query(
        `select inbox.event_id as "sourceEventId", inbox.received_at as "receivedAt",
                inbox.source_service as "sourceService", ledger.event_type as "businessEventType",
                ledger.entity_id as "entityId", (ledger.metadata->>'revision')::int as revision
           from audit_runtime.inbox_events inbox
           join platform.audit_events ledger on ledger.source_event_id = inbox.event_id
          where inbox.tenant_id = $1 and inbox.event_id in ($2::uuid, $3::uuid)
          order by (ledger.metadata->>'revision')::int`,
        [tenantId, pulsoAuditEvents.rows[0].id, pulsoAuditEvents.rows[1].id]
      );
      return result.rowCount === 2 ? result.rows : undefined;
    });
    assert.deepEqual(
      pulsoAuditProjection.map((event) => ({
        sourceEventId: event.sourceEventId,
        sourceService: event.sourceService,
        businessEventType: event.businessEventType,
        entityId: event.entityId,
        revision: event.revision,
        received: Boolean(event.receivedAt)
      })),
      pulsoAuditEvents.rows.map((event) => ({
        sourceEventId: event.id,
        sourceService: AUDIT_EVENT_CONTRACTS.pulso.sourceService,
        businessEventType: "config.updated",
        entityId: pulsoAuditEntityId,
        revision: event.revision,
        received: true
      }))
    );

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
          where tenant_id = $1 and source_event_id = $7) as "auditEffect",
        (select count(*)::int from channel_runtime.outbox_events
          where tenant_id = $1 and id = $8 and status = 'published') as "channelDeliveryOutbox",
        (select count(*)::int from pulso_iris.inbox_events
          where tenant_id = $1 and event_id = $8 and processed_at is not null) as "pulsoDeliveryInbox",
        (select count(*)::int from pulso_iris.messages
          where tenant_id = $1 and id = $9 and delivery_status = 'sent') as "pulsoDeliveryEffect",
        (select count(*)::int from channel_runtime.outbox_events
          where tenant_id = $1 and id = $10 and status = 'published') as "channelAuditOutbox",
        (select count(*)::int from audit_runtime.inbox_events
          where tenant_id = $1 and event_id = $10) as "channelAuditInbox",
        (select count(*)::int from platform.audit_events
          where tenant_id = $1 and source_event_id = $10) as "channelAuditEffect",
        (select count(*)::int from pulso_iris.outbox_events
          where tenant_id = $1 and id in ($11::uuid, $12::uuid) and status = 'published') as "pulsoAuditOutbox",
        (select count(*)::int from audit_runtime.inbox_events
          where tenant_id = $1 and event_id in ($11::uuid, $12::uuid)) as "pulsoAuditInbox",
        (select count(*)::int from platform.audit_events
          where tenant_id = $1 and source_event_id in ($11::uuid, $12::uuid)) as "pulsoAuditEffect"`,
      values: [
        tenantId,
        firstPersistence.eventId,
        channelEvent.id,
        inbound.externalMessageId,
        pulsoProjection.outboxEventId,
        sofiaProjection.jobId,
        sofiaProjection.outboxEventId,
        channelDeliveryEvent.id,
        outboundMessage.id,
        channelAuditEvent.id,
        pulsoAuditEvents.rows[0].id,
        pulsoAuditEvents.rows[1].id
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
      auditEffect: 1,
      channelDeliveryOutbox: 1,
      pulsoDeliveryInbox: 1,
      pulsoDeliveryEffect: 1,
      channelAuditOutbox: 1,
      channelAuditInbox: 1,
      channelAuditEffect: 1,
      pulsoAuditOutbox: 2,
      pulsoAuditInbox: 2,
      pulsoAuditEffect: 2
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
    if (channelThreadContract) {
      await Promise.allSettled([channelThreadContract.close()]);
    }
    if (pulsoDeliveryContract) {
      await Promise.allSettled([pulsoDeliveryContract.close()]);
    }
    try {
      if (tenantId) await cleanupSyntheticTenant(adminDb, tenantId);
    } finally {
      await Promise.allSettled(databases.map((database) => database.close()));
    }
  }
}

async function startPulsoDeliveryContractServer(pulsoDb, pulsoDatabaseUrl, runId) {
  const credential = `autonomy-delivery-${runId}`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousExpectedRole = process.env.EXPECTED_DATABASE_ROLE;
  process.env.DATABASE_URL = pulsoDatabaseUrl;
  process.env.EXPECTED_DATABASE_ROLE = "hyperion_pulso";

  let service;
  try {
    service = await createService({
      serviceName: "pulso-iris-service",
      databaseRequired: true,
      createDatabase: () => databaseView(pulsoDb),
      registerRoutes: async (app, context) => registerChannelDeliveryRoutes(app, context, credential)
    });
  } finally {
    restoreEnvironment("DATABASE_URL", previousDatabaseUrl);
    restoreEnvironment("EXPECTED_DATABASE_ROLE", previousExpectedRole);
  }

  try {
    const pulsoIrisUrl = await service.app.listen({ host: "127.0.0.1", port: 0 });
    return {
      client: createPulsoDeliveryClient({ pulsoIrisUrl, credential }),
      close: () => service.app.close()
    };
  } catch (error) {
    await service.app.close();
    throw error;
  }
}

async function startChannelThreadContractServer(channelDb, channelDatabaseUrl, runId) {
  const credential = `autonomy-e2e-${runId}`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousExpectedRole = process.env.EXPECTED_DATABASE_ROLE;
  process.env.DATABASE_URL = channelDatabaseUrl;
  process.env.EXPECTED_DATABASE_ROLE = "hyperion_channel";

  let service;
  try {
    service = await createService({
      serviceName: "whatsapp-channel-service",
      databaseRequired: true,
      createDatabase: () => databaseView(channelDb),
      registerRoutes: async (app, context) => registerThreadBindRoutes(app, context, credential)
    });
  } finally {
    restoreEnvironment("DATABASE_URL", previousDatabaseUrl);
    restoreEnvironment("EXPECTED_DATABASE_ROLE", previousExpectedRole);
  }

  try {
    const channelServiceUrl = await service.app.listen({ host: "127.0.0.1", port: 0 });
    return {
      client: createChannelThreadClient({ channelServiceUrl, credential }),
      close: () => service.app.close()
    };
  } catch (error) {
    await service.app.close();
    throw error;
  }
}

function databaseView(database) {
  return {
    query: (...args) => database.query(...args),
    transaction: (...args) => database.transaction(...args),
    close: async () => undefined
  };
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createInspectableChannelConsumerFactory() {
  let consumer;
  return {
    factory: (options) => {
      assert.equal(consumer, undefined, "Channel E2E expects exactly one current-contract consumer");
      consumer = new DurableJetStreamConsumer({
        ...options,
        pullExpiresMs: CHANNEL_CONSUMER_PULL_EXPIRES_MS
      });
      return {
        initialize: () => consumer.initialize(),
        checkReadiness: () => consumer.checkReadiness(),
        start: () => undefined,
        stop: () => consumer.stop()
      };
    },
    consumeOnce: () => {
      assert.ok(consumer, "Channel consumer must be initialized before delivery");
      return consumer.consumeOnce();
    }
  };
}

function createInspectableDeliveryConsumerFactory() {
  let consumer;
  return {
    factory: (options) => {
      assert.equal(consumer, undefined, "Delivery E2E expects exactly one current-contract consumer");
      consumer = new DurableJetStreamConsumer({
        ...options,
        pullExpiresMs: CHANNEL_CONSUMER_PULL_EXPIRES_MS
      });
      return {
        initialize: () => consumer.initialize(),
        checkReadiness: () => consumer.checkReadiness(),
        start: () => undefined,
        stop: () => consumer.stop()
      };
    },
    consumeOnce: () => {
      assert.ok(consumer, "Delivery consumer must be initialized before delivery");
      return consumer.consumeOnce();
    }
  };
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
  await adminDb.transaction(async (transaction) => {
    await transaction.query("delete from platform.audit_events where tenant_id = $1", [tenantId]);
    await transaction.query("delete from audit_runtime.inbox_events where tenant_id = $1", [tenantId]);
    await transaction.query("delete from channel_runtime.outbox_event_positions where tenant_id = $1", [tenantId]);
    await transaction.query("delete from channel_runtime.outbox_stream_positions where tenant_id = $1", [tenantId]);
    await transaction.query("delete from channel_runtime.outbox_events where tenant_id = $1", [tenantId]);
    await transaction.query("delete from pulso_iris.outbox_event_positions where tenant_id = $1", [tenantId]);
    await transaction.query("delete from pulso_iris.outbox_stream_positions where tenant_id = $1", [tenantId]);
    await transaction.query("delete from pulso_iris.outbox_events where tenant_id = $1", [tenantId]);
    await transaction.query("delete from pulso_iris.inbox_events where tenant_id = $1", [tenantId]);
    await transaction.query("delete from pulso_iris.channel_threads where tenant_id = $1", [tenantId]);
    await transaction.query("delete from agent_runtime.pulso_stream_positions where tenant_id = $1", [tenantId]);
    await transaction.query("delete from agent_runtime.job_stream_positions where tenant_id = $1", [tenantId]);
    await transaction.query("delete from agent_runtime.outbox_events where tenant_id = $1", [tenantId]);
    await transaction.query("delete from agent_runtime.inbox_events where tenant_id = $1", [tenantId]);
    await transaction.query("delete from platform.tenants where id = $1", [tenantId]);
  });
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
