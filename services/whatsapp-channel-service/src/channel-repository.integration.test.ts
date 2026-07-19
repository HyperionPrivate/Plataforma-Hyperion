import { createHash, randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient, type DatabaseTransaction } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_DELIVERY_EVENT_TYPE } from "./channel-delivery-outbox.js";
import { PostgresChannelRepository } from "./channel-repository.js";
import { createDatabasePulsoDeliveryGuard } from "./pulso-delivery.integration.test.support.js";
import { WHATSAPP_PROVIDER_MODE } from "./types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_PULSO_FIXTURE_DATABASE_URL = process.env.TEST_PULSO_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_PULSO_FIXTURE_DATABASE_URL ? describe : describe.skip;

describeIntegration("PostgresChannelRepository", () => {
  let db: DatabaseClient;
  let fixtureDb: DatabaseClient;
  let repository: PostgresChannelRepository;
  let tenantId: string;

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    fixtureDb = createDatabase(TEST_PULSO_FIXTURE_DATABASE_URL ?? "");
    const tenant = await fixtureDb.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'WhatsApp repository integration test')
       returning id`,
      [`wa-repository-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]?.id ?? "";
    repository = new PostgresChannelRepository(db, createDatabasePulsoDeliveryGuard(fixtureDb));
    await repository.projectConnection(tenantId, {
      providerMode: WHATSAPP_PROVIDER_MODE,
      state: "ready",
      phoneMasked: "********4567",
      sessionRestorable: true
    });
  });

  afterAll(async () => {
    if (tenantId) {
      await db.query("delete from channel_runtime.outbox_events where tenant_id = $1", [tenantId]);
      await fixtureDb.query("delete from platform.tenants where id = $1", [tenantId]);
    }
    await db.close();
    await fixtureDb.close();
  });

  async function createClaimedOutbound(label: string) {
    const binding = await db.query<{ id: string; conversationId: string }>(
      `select id, conversation_id as "conversationId"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and status = 'active' and conversation_id is not null
       limit 1`,
      [tenantId]
    );
    const bindingRow = binding.rows[0];
    if (!bindingRow) throw new Error("Expected an active bound conversation");
    const body = `respuesta durable ${label}`;
    const message = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', $3, $4, 'queued') returning id`,
      [tenantId, bindingRow.conversationId, body, WHATSAPP_PROVIDER_MODE]
    );
    const messageId = message.rows[0]?.id ?? "";
    const outbound = await repository.enqueueOutbound({
      tenantId,
      threadBindingId: bindingRow.id,
      messageId,
      body,
      idempotencyKey: `repository-durable-${label}-${randomUUID()}`
    });
    const claimed = await repository.claimOutbound(`repository-durable-worker-${label}`);
    if (!claimed || claimed.id !== outbound.id) throw new Error(`Expected the ${label} outbound claim`);
    await expect(repository.markOutboundSending(claimed)).resolves.toBe(true);
    return { messageId, outbound, claimed };
  }

  it("deduplicates inbound events and creates one tenant-scoped binding", async () => {
    const message = {
      tenantId,
      provider: WHATSAPP_PROVIDER_MODE,
      externalMessageId: "provider-inbound-1",
      providerAddress: "573001234567@s.whatsapp.net",
      phoneHash: "a".repeat(64),
      phoneMasked: "********4567",
      body: "mensaje sintetico",
      receivedAt: new Date()
    } as const;

    const first = await repository.persistInbound(message);
    const duplicate = await repository.persistInbound(message);
    await expect(repository.persistInbound({ ...message, body: "contenido alterado" })).rejects.toThrow(
      "Inbound event identity conflict"
    );
    await expect(repository.persistInbound({ ...message, phoneHash: "b".repeat(64) })).rejects.toThrow(
      "Inbound event identity conflict"
    );
    await db.query(
      `delete from channel_runtime.outbox_events
       where tenant_id = $1 and aggregate_id = $2`,
      [tenantId, first.eventId]
    );
    const repairedReplay = await repository.persistInbound({
      ...message,
      providerAddress: "replayed-address@s.whatsapp.net",
      phoneMasked: "********9999",
      receivedAt: new Date("2026-07-13T23:59:59.000Z")
    });
    const counts = await db.query<{
      events: number;
      bindings: number;
      outbox: number;
      outboxType: string;
      outboxStreamId: string;
      outboxStreamSequence: number;
      body: string;
      phoneHash: string;
      outboxPayload: Record<string, unknown>;
    }>(
      `select
         (select count(*)::int from channel_runtime.inbound_events where tenant_id = $1) as events,
         (select count(*)::int from channel_runtime.thread_bindings where tenant_id = $1) as bindings,
         (select count(*)::int from channel_runtime.outbox_events where tenant_id = $1) as outbox,
         (select event_type from channel_runtime.outbox_events where tenant_id = $1 limit 1) as "outboxType",
         (select stream_id::text from channel_runtime.outbox_events where tenant_id = $1 limit 1) as "outboxStreamId",
         (select stream_sequence::int from channel_runtime.outbox_events where tenant_id = $1 limit 1) as "outboxStreamSequence",
         (select body from channel_runtime.inbound_events where tenant_id = $1 limit 1) as body,
         (select phone_e164_hash from channel_runtime.thread_bindings where tenant_id = $1 limit 1) as "phoneHash",
         (select payload from channel_runtime.outbox_events where tenant_id = $1 limit 1) as "outboxPayload"`,
      [tenantId]
    );

    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, eventId: first.eventId });
    expect(repairedReplay).toMatchObject({ inserted: false, eventId: first.eventId });
    expect(counts.rows[0]).toMatchObject({
      events: 1,
      bindings: 1,
      outbox: 1,
      outboxType: "channel.inbound.received.v2",
      outboxStreamId: first.threadBindingId,
      outboxStreamSequence: 1,
      body: message.body,
      phoneHash: message.phoneHash
    });
    expect(counts.rows[0]?.outboxPayload).toMatchObject({
      inboundEventId: first.eventId,
      threadBindingId: first.threadBindingId,
      externalThreadId: message.providerAddress,
      externalMessageId: message.externalMessageId,
      phoneHash: message.phoneHash,
      phoneMasked: message.phoneMasked,
      body: message.body
    });
    const persistedReceivedAt = String(counts.rows[0]?.outboxPayload.receivedAt);
    expect(Number.isNaN(Date.parse(persistedReceivedAt))).toBe(false);
    expect(new Date(persistedReceivedAt).toISOString()).toBe(message.receivedAt.toISOString());
  });

  it("replays an inbound without waiting on the binding lock used by patient identification", async () => {
    const binding = await db.query<{ id: string }>(
      `select id from channel_runtime.thread_bindings where tenant_id = $1 limit 1`,
      [tenantId]
    );
    let releaseLock!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolveLocked) => {
      signalLocked = resolveLocked;
    });
    const hold = new Promise<void>((resolveHold) => {
      releaseLock = resolveHold;
    });
    const locker = db.transaction(async (client) => {
      await client.query(`select id from channel_runtime.thread_bindings where tenant_id = $1 and id = $2 for update`, [
        tenantId,
        binding.rows[0]?.id
      ]);
      signalLocked();
      await hold;
    });
    await locked;

    try {
      await expect(
        repository.persistInbound({
          tenantId,
          provider: WHATSAPP_PROVIDER_MODE,
          externalMessageId: "provider-inbound-1",
          providerAddress: "synthetic-address@s.whatsapp.net",
          phoneHash: "a".repeat(64),
          phoneMasked: "********4567",
          body: "mensaje sintetico",
          receivedAt: new Date()
        })
      ).resolves.toMatchObject({ inserted: false });
    } finally {
      releaseLock();
      await locker;
    }
  });

  it("does not resurrect a contract-invalid terminal legacy event through replay", async () => {
    const connection = await db.query<{ id: string }>(
      `select id from channel_runtime.connections where tenant_id = $1`,
      [tenantId]
    );
    const binding = await db.query<{ id: string }>(
      `insert into channel_runtime.thread_bindings (
         tenant_id, connection_id, provider, external_thread_id,
         phone_e164_hash, phone_masked
       ) values ($1, $2, $3, $4, $5, '********8888') returning id`,
      [tenantId, connection.rows[0]?.id, WHATSAPP_PROVIDER_MODE, "573008888888@s.whatsapp.net", "Z".repeat(64)]
    );
    const legacy = await db.query<{ id: string }>(
      `insert into channel_runtime.inbound_events (
         tenant_id, connection_id, thread_binding_id, provider,
         external_message_id, body, status, occurred_at,
         last_error_code, metadata
       ) values (
         $1, $2, $3, $4, 'legacy-invalid-replay', 'legacy invalido',
         'dead_letter', now(), 'legacy_inbound_contract_invalid',
         '{"outboxBackfillStatus":"dead_letter"}'::jsonb
       ) returning id`,
      [tenantId, connection.rows[0]?.id, binding.rows[0]?.id, WHATSAPP_PROVIDER_MODE]
    );

    await expect(
      repository.persistInbound({
        tenantId,
        provider: WHATSAPP_PROVIDER_MODE,
        externalMessageId: "legacy-invalid-replay",
        providerAddress: "573008888888@s.whatsapp.net",
        phoneHash: "Z".repeat(64),
        phoneMasked: "********8888",
        body: "legacy invalido",
        receivedAt: new Date()
      })
    ).rejects.toThrow("Unable to ensure durable outbox for inbound event");

    const outbox = await db.query<{ count: number }>(
      `select count(*)::int as count
       from channel_runtime.outbox_events
       where tenant_id = $1 and aggregate_id = $2`,
      [tenantId, legacy.rows[0]?.id]
    );
    expect(outbox.rows[0]?.count).toBe(0);
  });

  it("enqueues idempotently, claims once and records delivery", async () => {
    const binding = await db.query<{ id: string }>(
      `select id from channel_runtime.thread_bindings where tenant_id = $1 limit 1`,
      [tenantId]
    );
    const conversation = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.conversations (tenant_id, channel, direction, status)
       values ($1, 'whatsapp', 'inbound', 'active') returning id`,
      [tenantId]
    );
    const message = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', 'respuesta sintetica', $3, 'queued') returning id`,
      [tenantId, conversation.rows[0]?.id, WHATSAPP_PROVIDER_MODE]
    );
    await db.query(
      `update channel_runtime.thread_bindings
       set conversation_id = $3, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, binding.rows[0]?.id, conversation.rows[0]?.id]
    );
    const input = {
      tenantId,
      threadBindingId: binding.rows[0]?.id ?? "",
      messageId: message.rows[0]?.id ?? "",
      body: "respuesta sintetica",
      idempotencyKey: "repository-outbound-1"
    };

    const first = await repository.enqueueOutbound(input);
    const duplicate = await repository.enqueueOutbound(input);
    const duplicateWithAnotherKey = await repository.enqueueOutbound({
      ...input,
      idempotencyKey: "repository-outbound-alias"
    });
    const outboundCount = await db.query<{ count: number }>(
      `select count(*)::int as count
       from channel_runtime.outbound_messages
       where tenant_id = $1 and message_id = $2`,
      [tenantId, input.messageId]
    );
    const claimed = await repository.claimOutbound("repository-test-worker");

    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ id: first.id, inserted: false });
    expect(duplicateWithAnotherKey).toEqual({ id: first.id, inserted: false });
    expect(outboundCount.rows[0]?.count).toBe(1);
    expect(claimed).toMatchObject({ id: first.id, tenantId, body: input.body });
    if (!claimed) throw new Error("Expected an outbound message");
    await expect(repository.markOutboundSending({ ...claimed, workerId: "another-worker" })).resolves.toBe(false);
    await expect(repository.markOutboundSending(claimed)).resolves.toBe(true);
    await expect(
      repository.markOutboundSent({ ...claimed, workerId: "another-worker" }, "provider-wrong-worker", new Date())
    ).resolves.toBe(false);
    const sentAt = new Date("2026-07-10T05:00:00.000Z");
    const deliveredAt = new Date("2026-07-10T05:00:01.000Z");
    const readAt = new Date("2026-07-10T05:00:02.000Z");
    const failedAt = new Date("2026-07-10T05:00:03.000Z");
    const deliveredAgainAt = new Date("2026-07-10T05:00:04.000Z");
    await expect(
      repository.updateDelivery({
        tenantId,
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId: "provider-outbound-1",
        status: "delivered",
        occurredAt: deliveredAt
      })
    ).resolves.toBe(true);
    const pendingBeforeCorrelation = await db.query<{ count: number }>(
      `select count(*)::int as count
       from channel_runtime.delivery_receipts
       where tenant_id = $1 and provider_message_id = 'provider-outbound-1'`,
      [tenantId]
    );
    expect(pendingBeforeCorrelation.rows[0]?.count).toBe(1);
    await expect(repository.markOutboundSent(claimed, "provider-outbound-1", sentAt)).resolves.toBe(true);
    await repository.updateDelivery({
      tenantId,
      provider: WHATSAPP_PROVIDER_MODE,
      providerMessageId: "provider-outbound-1",
      status: "read",
      occurredAt: readAt
    });
    await repository.updateDelivery({
      tenantId,
      provider: WHATSAPP_PROVIDER_MODE,
      providerMessageId: "provider-outbound-1",
      status: "failed",
      occurredAt: failedAt
    });
    await repository.updateDelivery({
      tenantId,
      provider: WHATSAPP_PROVIDER_MODE,
      providerMessageId: "provider-outbound-1",
      status: "delivered",
      occurredAt: deliveredAgainAt
    });
    const state = await fixtureDb.query<{
      outbound: string;
      message: string;
      messageProviderId: string | null;
      deliveredAt: Date;
      messageDeliveredAt: Date | null;
      pendingReceipts: number;
    }>(
      `select o.status as outbound, m.delivery_status as message,
               m.provider_message_id as "messageProviderId",
               o.delivered_at as "deliveredAt", m.delivered_at as "messageDeliveredAt",
               (select count(*)::int from channel_runtime.delivery_receipts receipt
                where receipt.tenant_id = o.tenant_id
                  and receipt.provider = o.provider
                  and receipt.provider_message_id = o.provider_message_id) as "pendingReceipts"
       from channel_runtime.outbound_messages o
       join pulso_iris.messages m on m.tenant_id = o.tenant_id and m.id = o.message_id
       where o.tenant_id = $1 and o.id = $2`,
      [tenantId, first.id]
    );
    expect(state.rows[0]).toEqual({
      outbound: "delivered",
      message: "queued",
      messageProviderId: null,
      deliveredAt,
      messageDeliveredAt: null,
      pendingReceipts: 0
    });

    const deliveryEvents = await loadDeliveryEvents(db, tenantId, input.messageId);
    expect(deliveryEvents.map(({ payload }) => payload)).toEqual([
      {
        messageId: input.messageId,
        outcome: "sent",
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId: "provider-outbound-1"
      },
      {
        messageId: input.messageId,
        outcome: "reconcile",
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId: "provider-outbound-1",
        status: "delivered",
        occurredAt: deliveredAt.toISOString()
      },
      {
        messageId: input.messageId,
        outcome: "reconcile",
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId: "provider-outbound-1",
        status: "read",
        occurredAt: readAt.toISOString()
      },
      {
        messageId: input.messageId,
        outcome: "reconcile",
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId: "provider-outbound-1",
        status: "failed",
        occurredAt: failedAt.toISOString()
      },
      {
        messageId: input.messageId,
        outcome: "reconcile",
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId: "provider-outbound-1",
        status: "delivered",
        occurredAt: deliveredAgainAt.toISOString()
      }
    ]);
    expect(deliveryEvents.map(({ streamId, streamSequence }) => ({ streamId, streamSequence }))).toEqual(
      [1, 2, 3, 4, 5].map((streamSequence) => ({ streamId: input.messageId, streamSequence }))
    );
    for (const event of deliveryEvents) {
      expect(event).toMatchObject({ eventType: CHANNEL_DELIVERY_EVENT_TYPE, eventVersion: 1, status: "queued" });
      expect(event.dedupeKey).toBe(deliveryDedupeKey(input.messageId, event.payload));
    }
  });

  it("persists failed, uncertain and receipt outcomes as ordered events before PULSO changes", async () => {
    const failed = await createClaimedOutbound("failed");
    await expect(
      repository.markOutboundFailed(
        { ...failed.claimed, attemptCount: failed.claimed.maxAttempts },
        "provider_terminal_failure"
      )
    ).resolves.toBe(true);

    const uncertain = await createClaimedOutbound("uncertain");
    const uncertainAt = new Date("2026-07-10T06:00:00.000Z");
    const deliveredAt = new Date("2026-07-10T06:00:01.000Z");
    const providerMessageId = `provider-uncertain-${randomUUID()}`;
    await expect(repository.markOutboundUncertain(uncertain.claimed, providerMessageId, uncertainAt)).resolves.toBe(
      true
    );
    await expect(
      repository.updateDelivery({
        tenantId,
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId,
        status: "delivered",
        occurredAt: deliveredAt
      })
    ).resolves.toBe(true);

    const states = await fixtureDb.query<{ id: string; outbound: string; message: string }>(
      `select m.id, o.status as outbound, m.delivery_status as message
       from pulso_iris.messages m
       join channel_runtime.outbound_messages o
         on o.tenant_id = m.tenant_id and o.message_id = m.id
       where m.tenant_id = $1 and m.id = any($2::uuid[])
       order by m.id`,
      [tenantId, [failed.messageId, uncertain.messageId]]
    );
    expect(new Map(states.rows.map((row) => [row.id, row]))).toEqual(
      new Map([
        [failed.messageId, { id: failed.messageId, outbound: "dead_letter", message: "queued" }],
        [uncertain.messageId, { id: uncertain.messageId, outbound: "delivered", message: "queued" }]
      ])
    );

    const failedEvents = await loadDeliveryEvents(db, tenantId, failed.messageId);
    expect(failedEvents).toEqual([
      expect.objectContaining({
        streamId: failed.messageId,
        streamSequence: 1,
        status: "queued",
        payload: { messageId: failed.messageId, outcome: "failed" }
      })
    ]);
    const uncertainEvents = await loadDeliveryEvents(db, tenantId, uncertain.messageId);
    expect(uncertainEvents.map(({ streamSequence, payload }) => ({ streamSequence, payload }))).toEqual([
      {
        streamSequence: 1,
        payload: {
          messageId: uncertain.messageId,
          outcome: "uncertain",
          provider: WHATSAPP_PROVIDER_MODE,
          providerMessageId
        }
      },
      {
        streamSequence: 2,
        payload: {
          messageId: uncertain.messageId,
          outcome: "reconcile",
          provider: WHATSAPP_PROVIDER_MODE,
          providerMessageId,
          status: "delivered",
          occurredAt: deliveredAt.toISOString()
        }
      }
    ]);
    for (const event of [...failedEvents, ...uncertainEvents]) {
      expect(event.dedupeKey).toBe(deliveryDedupeKey(String(event.payload.messageId), event.payload));
    }
  });

  it("rolls back the Channel transition when its durable delivery event cannot be inserted", async () => {
    const pending = await createClaimedOutbound("outbox-rollback");
    const providerMessageId = `provider-rollback-${randomUUID()}`;
    const failingDatabase = createOutboxFailureDatabase(db);
    const failingRepository = new PostgresChannelRepository(
      failingDatabase,
      createDatabasePulsoDeliveryGuard(fixtureDb)
    );

    await expect(
      failingRepository.markOutboundSent(pending.claimed, providerMessageId, new Date("2026-07-10T06:30:00.000Z"))
    ).rejects.toThrow("synthetic_channel_delivery_outbox_failure");

    const rolledBack = await fixtureDb.query<{
      outbound: string;
      providerMessageId: string | null;
      message: string;
    }>(
      `select o.status as outbound, o.provider_message_id as "providerMessageId", m.delivery_status as message
       from channel_runtime.outbound_messages o
       join pulso_iris.messages m on m.tenant_id = o.tenant_id and m.id = o.message_id
       where o.tenant_id = $1 and o.id = $2`,
      [tenantId, pending.outbound.id]
    );
    expect(rolledBack.rows[0]).toEqual({ outbound: "sending", providerMessageId: null, message: "queued" });
    await expect(loadDeliveryEvents(db, tenantId, pending.messageId)).resolves.toEqual([]);

    await expect(
      repository.markOutboundSent(pending.claimed, providerMessageId, new Date("2026-07-10T06:30:00.000Z"))
    ).resolves.toBe(true);
    await expect(loadDeliveryEvents(db, tenantId, pending.messageId)).resolves.toEqual([
      expect.objectContaining({
        streamId: pending.messageId,
        streamSequence: 1,
        payload: {
          messageId: pending.messageId,
          outcome: "sent",
          provider: WHATSAPP_PROVIDER_MODE,
          providerMessageId
        }
      })
    ]);
  });

  it("quarantines unmatched receipts without bodies and expires stale evidence", async () => {
    await expect(
      repository.updateDelivery({
        tenantId,
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId: "provider-unmatched-expired",
        status: "delivered",
        occurredAt: new Date("2026-07-01T05:00:00.000Z")
      })
    ).resolves.toBe(true);
    await db.query(
      `update channel_runtime.delivery_receipts
       set received_at = now() - interval '8 days'
       where tenant_id = $1 and provider_message_id = 'provider-unmatched-expired'`,
      [tenantId]
    );

    await expect(
      repository.updateDelivery({
        tenantId,
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId: "provider-unmatched-current",
        status: "delivered",
        occurredAt: new Date()
      })
    ).resolves.toBe(true);

    const pending = await db.query<{ providerMessageId: string }>(
      `select provider_message_id as "providerMessageId"
       from channel_runtime.delivery_receipts
       where tenant_id = $1
         and provider_message_id in ('provider-unmatched-expired', 'provider-unmatched-current')
       order by provider_message_id`,
      [tenantId]
    );
    expect(pending.rows).toEqual([{ providerMessageId: "provider-unmatched-current" }]);
  });

  it("prunes receipt capacity by message identity without dropping a positive state", async () => {
    const tenant = await fixtureDb.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'Receipt capacity integration test') returning id`,
      [`receipt-capacity-${randomUUID()}`]
    );
    const capacityTenantId = tenant.rows[0]?.id ?? "";
    const targetProviderMessageId = "provider-capacity-target";
    try {
      await db.query(
        `insert into channel_runtime.delivery_receipts (
           tenant_id, provider, provider_message_id, status, occurred_at, received_at
         )
         select $1, 'whatsapp_web_test', 'provider-capacity-' || value::text,
                'failed', now(), now()
         from generate_series(1, 2000) value`,
        [capacityTenantId]
      );
      await db.query(
        `insert into channel_runtime.delivery_receipts (
           tenant_id, provider, provider_message_id, status, occurred_at, received_at
         ) values ($1, 'whatsapp_web_test', $2, 'delivered', now() - interval '8 days', now() - interval '8 days')`,
        [capacityTenantId, targetProviderMessageId]
      );

      await expect(
        repository.updateDelivery({
          tenantId: capacityTenantId,
          provider: WHATSAPP_PROVIDER_MODE,
          providerMessageId: targetProviderMessageId,
          status: "failed",
          occurredAt: new Date()
        })
      ).resolves.toBe(true);

      const state = await db.query<{ identities: number; rows: number; targetStatuses: string[] }>(
        `select count(distinct (provider, provider_message_id))::int as identities,
                count(*)::int as rows,
                coalesce(
                  array_agg(status order by status) filter (where provider_message_id = $2),
                  array[]::text[]
                ) as "targetStatuses"
         from channel_runtime.delivery_receipts
         where tenant_id = $1`,
        [capacityTenantId, targetProviderMessageId]
      );
      expect(state.rows[0]).toEqual({
        identities: 2000,
        rows: 2001,
        targetStatuses: ["delivered", "failed"]
      });
    } finally {
      await fixtureDb.query("delete from platform.tenants where id = $1", [capacityTenantId]);
    }
  });

  it("does not miss a receipt racing the provider-message correlation transaction", async () => {
    const binding = await db.query<{ id: string; conversationId: string }>(
      `select id, conversation_id as "conversationId"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and status = 'active' and conversation_id is not null
       limit 1`,
      [tenantId]
    );
    const bindingRow = binding.rows[0];
    if (!bindingRow) throw new Error("Expected an active bound conversation");
    const body = "respuesta con receipt concurrente";
    const message = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', $3, $4, 'queued') returning id`,
      [tenantId, bindingRow.conversationId, body, WHATSAPP_PROVIDER_MODE]
    );
    const outbound = await repository.enqueueOutbound({
      tenantId,
      threadBindingId: bindingRow.id,
      messageId: message.rows[0]?.id ?? "",
      body,
      idempotencyKey: "repository-concurrent-delivery-correlation"
    });
    const claimed = await repository.claimOutbound("repository-concurrent-delivery-worker");
    if (!claimed || claimed.id !== outbound.id) throw new Error("Expected the concurrent outbound claim");
    await expect(repository.markOutboundSending(claimed)).resolves.toBe(true);

    const providerMessageId = "provider-concurrent-delivery-correlation";
    const deliveredAt = new Date("2026-07-10T05:30:01.000Z");
    const [sent, receiptPersisted] = await Promise.all([
      repository.markOutboundSent(claimed, providerMessageId, new Date("2026-07-10T05:30:00.000Z")),
      repository.updateDelivery({
        tenantId,
        provider: WHATSAPP_PROVIDER_MODE,
        providerMessageId,
        status: "delivered",
        occurredAt: deliveredAt
      })
    ]);
    expect({ sent, receiptPersisted }).toEqual({ sent: true, receiptPersisted: true });

    const messageId = message.rows[0]?.id ?? "";
    const state = await fixtureDb.query<{ outbound: string; message: string; pending: number }>(
      `select o.status as outbound, m.delivery_status as message,
              (select count(*)::int from channel_runtime.delivery_receipts receipt
               where receipt.tenant_id = o.tenant_id
                 and receipt.provider = o.provider
                 and receipt.provider_message_id = o.provider_message_id) as pending
       from channel_runtime.outbound_messages o
       join pulso_iris.messages m on m.tenant_id = o.tenant_id and m.id = o.message_id
       where o.tenant_id = $1 and o.id = $2`,
      [tenantId, outbound.id]
    );
    expect(state.rows[0]).toEqual({ outbound: "delivered", message: "queued", pending: 0 });
    const deliveryEvents = await loadDeliveryEvents(db, tenantId, messageId);
    expect(deliveryEvents.map(({ streamSequence, payload }) => ({ streamSequence, payload }))).toEqual([
      {
        streamSequence: 1,
        payload: {
          messageId,
          outcome: "sent",
          provider: WHATSAPP_PROVIDER_MODE,
          providerMessageId
        }
      },
      {
        streamSequence: 2,
        payload: {
          messageId,
          outcome: "reconcile",
          provider: WHATSAPP_PROVIDER_MODE,
          providerMessageId,
          status: "delivered",
          occurredAt: deliveredAt.toISOString()
        }
      }
    ]);
  });

  it("deduplicates concurrent enqueue requests for the same persisted message", async () => {
    const binding = await db.query<{ id: string; conversationId: string }>(
      `select id, conversation_id as "conversationId"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and status = 'active' and conversation_id is not null
       limit 1`,
      [tenantId]
    );
    const bindingRow = binding.rows[0];
    if (!bindingRow) throw new Error("Expected an active bound conversation");
    const message = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', 'respuesta concurrente', $3, 'queued') returning id`,
      [tenantId, bindingRow.conversationId, WHATSAPP_PROVIDER_MODE]
    );
    const messageId = message.rows[0]?.id ?? "";
    const base = {
      tenantId,
      threadBindingId: bindingRow.id,
      messageId,
      body: "respuesta concurrente"
    };

    const results = await Promise.all([
      repository.enqueueOutbound({ ...base, idempotencyKey: "repository-concurrent-a" }),
      repository.enqueueOutbound({ ...base, idempotencyKey: "repository-concurrent-b" })
    ]);
    const count = await db.query<{ count: number }>(
      `select count(*)::int as count
       from channel_runtime.outbound_messages
       where tenant_id = $1 and message_id = $2`,
      [tenantId, messageId]
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    expect(count.rows[0]?.count).toBe(1);
    await db.query(`delete from channel_runtime.outbound_messages where tenant_id = $1 and message_id = $2`, [
      tenantId,
      messageId
    ]);
    await fixtureDb.query(`delete from pulso_iris.messages where tenant_id = $1 and id = $2`, [tenantId, messageId]);
  });

  it("rejects cross-conversation, non-SOFIA and body-drift outbound messages", async () => {
    const binding = await db.query<{ id: string; conversationId: string }>(
      `select id, conversation_id as "conversationId"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and status = 'active' and conversation_id is not null
       limit 1`,
      [tenantId]
    );
    const bindingRow = binding.rows[0];
    if (!bindingRow) throw new Error("Expected an active bound conversation");
    const foreignConversation = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.conversations (tenant_id, channel, direction, status)
       values ($1, 'whatsapp', 'inbound', 'active') returning id`,
      [tenantId]
    );
    const foreignMessage = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', 'otra conversacion', $3, 'queued') returning id`,
      [tenantId, foreignConversation.rows[0]?.id, WHATSAPP_PROVIDER_MODE]
    );
    const patientMessage = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'patient', 'mensaje del paciente', $3, 'received') returning id`,
      [tenantId, bindingRow.conversationId, WHATSAPP_PROVIDER_MODE]
    );
    const boundMessage = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', 'contenido persistido', $3, 'queued') returning id`,
      [tenantId, bindingRow.conversationId, WHATSAPP_PROVIDER_MODE]
    );

    await expect(
      repository.enqueueOutbound({
        tenantId,
        threadBindingId: bindingRow.id,
        messageId: foreignMessage.rows[0]?.id ?? "",
        body: "otra conversacion",
        idempotencyKey: "repository-invalid-conversation"
      })
    ).rejects.toThrow("pulso_message_rejected");
    await expect(
      repository.enqueueOutbound({
        tenantId,
        threadBindingId: bindingRow.id,
        messageId: patientMessage.rows[0]?.id ?? "",
        body: "mensaje del paciente",
        idempotencyKey: "repository-invalid-sender"
      })
    ).rejects.toThrow("pulso_message_rejected");
    await expect(
      repository.enqueueOutbound({
        tenantId,
        threadBindingId: bindingRow.id,
        messageId: boundMessage.rows[0]?.id ?? "",
        body: "contenido alterado",
        idempotencyKey: "repository-invalid-body"
      })
    ).rejects.toThrow("pulso_message_rejected");
    const invalidRows = await db.query<{ count: number }>(
      `select count(*)::int as count
       from channel_runtime.outbound_messages
       where tenant_id = $1 and idempotency_key like 'repository-invalid-%'`,
      [tenantId]
    );
    expect(invalidRows.rows[0]?.count).toBe(0);
  });

  it("rejects a valid outbound when its idempotency key belongs to another message", async () => {
    const binding = await db.query<{ id: string; conversationId: string }>(
      `select id, conversation_id as "conversationId"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and status = 'active' and conversation_id is not null
       limit 1`,
      [tenantId]
    );
    const bindingRow = binding.rows[0];
    if (!bindingRow) throw new Error("Expected an active bound conversation");

    const ownerBody = "respuesta propietaria de la clave";
    const contenderBody = "respuesta valida con clave colisionada";
    const ownerMessage = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', $3, $4, 'queued') returning id`,
      [tenantId, bindingRow.conversationId, ownerBody, WHATSAPP_PROVIDER_MODE]
    );
    const contenderMessage = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', $3, $4, 'queued') returning id`,
      [tenantId, bindingRow.conversationId, contenderBody, WHATSAPP_PROVIDER_MODE]
    );
    const ownerMessageId = ownerMessage.rows[0]?.id ?? "";
    const contenderMessageId = contenderMessage.rows[0]?.id ?? "";
    const idempotencyKey = `repository-conflict-${randomUUID()}`;

    try {
      await expect(
        repository.enqueueOutbound({
          tenantId,
          threadBindingId: bindingRow.id,
          messageId: ownerMessageId,
          body: ownerBody,
          idempotencyKey
        })
      ).resolves.toMatchObject({ inserted: true });

      await expect(
        repository.enqueueOutbound({
          tenantId,
          threadBindingId: bindingRow.id,
          messageId: contenderMessageId,
          body: contenderBody,
          idempotencyKey
        })
      ).rejects.toThrow("outbound_conflict");

      const persisted = await db.query<{ messageId: string; count: number }>(
        `select min(message_id::text) as "messageId", count(*)::int as count
         from channel_runtime.outbound_messages
         where tenant_id = $1 and provider = $2 and idempotency_key = $3`,
        [tenantId, WHATSAPP_PROVIDER_MODE, idempotencyKey]
      );
      expect(persisted.rows[0]).toEqual({ messageId: ownerMessageId, count: 1 });
    } finally {
      await db.query(
        `delete from channel_runtime.outbound_messages
         where tenant_id = $1 and provider = $2 and idempotency_key = $3`,
        [tenantId, WHATSAPP_PROVIDER_MODE, idempotencyKey]
      );
      await fixtureDb.query(
        `delete from pulso_iris.messages
         where tenant_id = $1 and id in ($2, $3)`,
        [tenantId, ownerMessageId, contenderMessageId]
      );
    }
  });

  it("cancels claimed outbound rows when their durable source state changed", async () => {
    const binding = await db.query<{ id: string; conversationId: string }>(
      `select id, conversation_id as "conversationId"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and status = 'active' and conversation_id is not null
       limit 1`,
      [tenantId]
    );
    const bindingRow = binding.rows[0];
    if (!bindingRow) throw new Error("Expected an active bound conversation");
    const foreignConversation = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.conversations (tenant_id, channel, direction, status)
       values ($1, 'whatsapp', 'inbound', 'active') returning id`,
      [tenantId]
    );

    const createQueued = async (label: string) => {
      const body = `respuesta controlada ${label}`;
      const message = await fixtureDb.query<{ id: string }>(
        `insert into pulso_iris.messages (
           tenant_id, conversation_id, sender, body, provider, delivery_status
         ) values ($1, $2, 'sofia', $3, $4, 'queued') returning id`,
        [tenantId, bindingRow.conversationId, body, WHATSAPP_PROVIDER_MODE]
      );
      const messageId = message.rows[0]?.id ?? "";
      const outbound = await repository.enqueueOutbound({
        tenantId,
        threadBindingId: bindingRow.id,
        messageId,
        body,
        idempotencyKey: `repository-claim-${label}`
      });
      return { body, messageId, outboundId: outbound.id };
    };

    const assertCancelled = async (outboundId: string, messageId: string, ownerStatus = "queued") => {
      const state = await fixtureDb.query<{ outbound: string; errorCode: string; message: string }>(
        `select o.status as outbound, o.last_error_code as "errorCode", m.delivery_status as message
         from channel_runtime.outbound_messages o
         join pulso_iris.messages m on m.tenant_id = o.tenant_id and m.id = o.message_id
         where o.tenant_id = $1 and o.id = $2 and m.id = $3`,
        [tenantId, outboundId, messageId]
      );
      expect(state.rows[0]).toEqual({
        outbound: "cancelled",
        errorCode: "outbound_source_state_changed",
        message: ownerStatus
      });
      const deliveryEvents = await loadDeliveryEvents(db, tenantId, messageId);
      expect(deliveryEvents).toHaveLength(1);
      expect(deliveryEvents[0]).toMatchObject({
        eventType: CHANNEL_DELIVERY_EVENT_TYPE,
        eventVersion: 1,
        streamId: messageId,
        streamSequence: 1,
        status: "queued",
        payload: { messageId, outcome: "cancel_source" }
      });
      expect(deliveryEvents[0]?.dedupeKey).toBe(deliveryDedupeKey(messageId, { messageId, outcome: "cancel_source" }));
    };

    const blockedBinding = await createQueued("blocked-binding");
    await db.query(`update channel_runtime.thread_bindings set status = 'blocked' where tenant_id = $1 and id = $2`, [
      tenantId,
      bindingRow.id
    ]);
    await expect(repository.claimOutbound("repository-invalid-binding")).resolves.toBeUndefined();
    await db.query(`update channel_runtime.thread_bindings set status = 'active' where tenant_id = $1 and id = $2`, [
      tenantId,
      bindingRow.id
    ]);
    await assertCancelled(blockedBinding.outboundId, blockedBinding.messageId);

    const movedConversation = await createQueued("moved-conversation");
    await fixtureDb.query(`update pulso_iris.messages set conversation_id = $3 where tenant_id = $1 and id = $2`, [
      tenantId,
      movedConversation.messageId,
      foreignConversation.rows[0]?.id
    ]);
    await expect(repository.claimOutbound("repository-invalid-conversation")).resolves.toBeUndefined();
    await assertCancelled(movedConversation.outboundId, movedConversation.messageId);

    const changedSender = await createQueued("changed-sender");
    await fixtureDb.query(`update pulso_iris.messages set sender = 'patient' where tenant_id = $1 and id = $2`, [
      tenantId,
      changedSender.messageId
    ]);
    await expect(repository.claimOutbound("repository-invalid-sender")).resolves.toBeUndefined();
    await assertCancelled(changedSender.outboundId, changedSender.messageId);

    const changedBody = await createQueued("changed-body");
    await fixtureDb.query(
      `update pulso_iris.messages set body = 'contenido cambiado' where tenant_id = $1 and id = $2`,
      [tenantId, changedBody.messageId]
    );
    await expect(repository.claimOutbound("repository-invalid-body")).resolves.toBeUndefined();
    await assertCancelled(changedBody.outboundId, changedBody.messageId);

    const changedProvider = await createQueued("changed-provider");
    await fixtureDb.query(
      `update pulso_iris.messages set provider = 'other-provider' where tenant_id = $1 and id = $2`,
      [tenantId, changedProvider.messageId]
    );
    await expect(repository.claimOutbound("repository-invalid-provider")).resolves.toBeUndefined();
    await assertCancelled(changedProvider.outboundId, changedProvider.messageId);

    const changedLifecycle = await createQueued("changed-lifecycle");
    await fixtureDb.query(`update pulso_iris.messages set delivery_status = 'sent' where tenant_id = $1 and id = $2`, [
      tenantId,
      changedLifecycle.messageId
    ]);
    await expect(repository.claimOutbound("repository-invalid-lifecycle")).resolves.toBeUndefined();
    await assertCancelled(changedLifecycle.outboundId, changedLifecycle.messageId, "sent");
  });

  it("revalidates the outbound source immediately before entering sending", async () => {
    const binding = await db.query<{ id: string; conversationId: string }>(
      `select id, conversation_id as "conversationId"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and status = 'active' and conversation_id is not null
       limit 1`,
      [tenantId]
    );
    const bindingRow = binding.rows[0];
    if (!bindingRow) throw new Error("Expected an active bound conversation");
    const message = await fixtureDb.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', 'respuesta previa al envio', $3, 'queued') returning id`,
      [tenantId, bindingRow.conversationId, WHATSAPP_PROVIDER_MODE]
    );
    const messageId = message.rows[0]?.id ?? "";
    const outbound = await repository.enqueueOutbound({
      tenantId,
      threadBindingId: bindingRow.id,
      messageId,
      body: "respuesta previa al envio",
      idempotencyKey: "repository-pre-send-guard"
    });
    const claimed = await repository.claimOutbound("repository-pre-send-worker");
    if (!claimed) throw new Error("Expected a claimed outbound message");

    await fixtureDb.query(`update pulso_iris.messages set delivery_status = 'sent' where tenant_id = $1 and id = $2`, [
      tenantId,
      messageId
    ]);

    await expect(repository.markOutboundSending(claimed)).resolves.toBe(false);
    const state = await fixtureDb.query<{ outbound: string; errorCode: string; message: string }>(
      `select o.status as outbound, o.last_error_code as "errorCode", m.delivery_status as message
       from channel_runtime.outbound_messages o
       join pulso_iris.messages m on m.tenant_id = o.tenant_id and m.id = o.message_id
       where o.tenant_id = $1 and o.id = $2`,
      [tenantId, outbound.id]
    );
    expect(state.rows[0]).toEqual({
      outbound: "cancelled",
      errorCode: "outbound_source_state_changed",
      message: "sent"
    });
    await expect(loadDeliveryEvents(db, tenantId, messageId)).resolves.toEqual([
      expect.objectContaining({
        eventType: CHANNEL_DELIVERY_EVENT_TYPE,
        eventVersion: 1,
        streamId: messageId,
        streamSequence: 1,
        status: "queued",
        payload: { messageId, outcome: "cancel_source" }
      })
    ]);
  });

  it("rejects new outbox rows for a non-WhatsApp or non-queued SOFIA message", async () => {
    const binding = await db.query<{ id: string; conversationId: string }>(
      `select id, conversation_id as "conversationId"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and status = 'active' and conversation_id is not null
       limit 1`,
      [tenantId]
    );
    const bindingRow = binding.rows[0];
    if (!bindingRow) throw new Error("Expected an active bound conversation");

    for (const [label, provider, deliveryStatus] of [
      ["wrong-provider", "other-provider", "queued"],
      ["already-sent", WHATSAPP_PROVIDER_MODE, "sent"]
    ] as const) {
      const message = await fixtureDb.query<{ id: string }>(
        `insert into pulso_iris.messages (
           tenant_id, conversation_id, sender, body, provider, delivery_status
         ) values ($1, $2, 'sofia', $3, $4, $5) returning id`,
        [tenantId, bindingRow.conversationId, `respuesta ${label}`, provider, deliveryStatus]
      );
      await expect(
        repository.enqueueOutbound({
          tenantId,
          threadBindingId: bindingRow.id,
          messageId: message.rows[0]?.id ?? "",
          body: `respuesta ${label}`,
          idempotencyKey: `repository-ineligible-${label}`
        })
      ).rejects.toThrow("pulso_message_rejected");
    }
  });
});

interface PersistedDeliveryEvent {
  eventType: string;
  eventVersion: number;
  streamId: string;
  streamSequence: number;
  dedupeKey: string;
  payload: Record<string, unknown>;
  status: string;
}

async function loadDeliveryEvents(
  db: DatabaseClient,
  tenantId: string,
  messageId: string
): Promise<PersistedDeliveryEvent[]> {
  const result = await db.query<PersistedDeliveryEvent>(
    `select event_type as "eventType", event_version as "eventVersion",
            stream_id::text as "streamId", stream_sequence::int as "streamSequence",
            dedupe_key as "dedupeKey", payload, status
     from channel_runtime.outbox_events
     where tenant_id = $1 and event_type = $2 and stream_id = $3::uuid
     order by stream_sequence`,
    [tenantId, CHANNEL_DELIVERY_EVENT_TYPE, messageId]
  );
  return result.rows;
}

function deliveryDedupeKey(messageId: string, payload: Record<string, unknown>): string {
  const digest = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  return `message:${messageId}:channel.delivery:${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Delivery event payload must be JSON serializable");
}

function createOutboxFailureDatabase(db: DatabaseClient): DatabaseClient {
  return {
    query: (text, params) => db.query(text, params),
    transaction: async <T>(work: (client: DatabaseTransaction) => Promise<T>) =>
      db.transaction(async (transaction) =>
        work({
          query: async (text: string, params?: unknown[]) => {
            if (
              text.includes("insert into channel_runtime.outbox_events") &&
              params?.[2] === CHANNEL_DELIVERY_EVENT_TYPE
            ) {
              throw new Error("synthetic_channel_delivery_outbox_failure");
            }
            return transaction.query(text, params);
          }
        } as DatabaseTransaction)
      ),
    close: async () => {
      throw new Error("The fault-injection database does not own the shared pool");
    }
  };
}
