import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receiveChannelInboundEvent, type ChannelInboundEvent } from "./channel-inbound-events.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("durable Channel -> PULSO persistence", () => {
  let db: DatabaseClient;
  let tenantId = "";

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    const tenant = await db.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'Autonomous PULSO flow test') returning id`,
      [`autonomous-pulso-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await db.query("delete from pulso_iris.outbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from pulso_iris.inbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from pulso_iris.channel_threads where tenant_id = $1", [tenantId]);
      await db.query("delete from channel_runtime.outbox_event_positions where tenant_id = $1", [tenantId]);
      await db.query("delete from platform.tenants where id = $1", [tenantId]);
    }
    await db.close();
  });

  it("commits local projections and one next-hop outbox event, then replays idempotently", async () => {
    const threadBindingId = randomUUID();
    const event: ChannelInboundEvent = {
      id: randomUUID(),
      type: "channel.inbound.received.v2",
      version: 2,
      occurredAt: "2026-07-13T15:00:00.000Z",
      tenantId,
      streamId: threadBindingId,
      streamSequence: 1,
      payload: {
        inboundEventId: randomUUID(),
        threadBindingId,
        provider: "whatsapp_web_test",
        externalThreadId: `${randomUUID()}@s.whatsapp.net`,
        externalMessageId: `integration-${randomUUID()}`,
        phoneHash: "c".repeat(64),
        phoneMasked: "********4321",
        body: "mensaje sintetico de integracion",
        receivedAt: "2026-07-13T15:00:00.000Z"
      }
    };

    const accepted = await receiveChannelInboundEvent(db, event);
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("controlled test setup failed");
    await db.query(
      `update pulso_iris.inbox_events
          set result = jsonb_set(result, '{outboxEventType}', '"pulso.message.received.v1"'::jsonb)
        where tenant_id = $1 and event_id = $2`,
      [tenantId, event.id]
    );
    const replayed = await receiveChannelInboundEvent(db, event);
    const counts = await db.query<{ inbox: number; messages: number; outbox: number; outboxV2: number }>(
      `select
         (select count(*)::int from pulso_iris.inbox_events where tenant_id = $1) as inbox,
         (select count(*)::int from pulso_iris.messages where tenant_id = $1) as messages,
         (select count(*)::int from pulso_iris.outbox_events where tenant_id = $1) as outbox,
         (select count(*)::int from pulso_iris.outbox_events
           where tenant_id = $1 and event_type = 'pulso.message.received.v2') as "outboxV2"`,
      [tenantId]
    );

    expect(replayed).toEqual({
      status: "replayed",
      result: { ...accepted.result, outboxEventType: "pulso.message.received.v1" }
    });
    expect(counts.rows[0]).toEqual({ inbox: 1, messages: 1, outbox: 1, outboxV2: 1 });
  });

  it("uses the producer-assigned v1 position when v1 sequence 2 arrives before v2 sequence 1", async () => {
    const threadBindingId = randomUUID();
    const firstInboundId = randomUUID();
    const secondInboundId = randomUUID();
    await db.query(
      `insert into channel_runtime.outbox_event_positions (
         tenant_id, event_id, stream_id, stream_sequence
       ) values ($1, $2, $4, 1), ($1, $3, $4, 2)`,
      [tenantId, firstInboundId, secondInboundId, threadBindingId]
    );

    const first: ChannelInboundEvent = {
      id: randomUUID(),
      type: "channel.inbound.received.v2",
      version: 2,
      occurredAt: "2026-07-13T16:00:00.000Z",
      tenantId,
      streamId: threadBindingId,
      streamSequence: 1,
      payload: {
        inboundEventId: firstInboundId,
        threadBindingId,
        provider: "whatsapp_web_test",
        externalThreadId: `${randomUUID()}@s.whatsapp.net`,
        externalMessageId: `mixed-v2-${randomUUID()}`,
        phoneHash: "e".repeat(64),
        phoneMasked: "********4322",
        body: "primero v2",
        receivedAt: "2026-07-13T16:00:00.000Z"
      }
    };
    const second: ChannelInboundEvent = {
      id: randomUUID(),
      type: "channel.inbound.received.v1",
      version: 1,
      occurredAt: "2026-07-13T16:00:01.000Z",
      tenantId,
      payload: {
        ...first.payload,
        inboundEventId: secondInboundId,
        externalMessageId: `mixed-v1-${randomUUID()}`,
        body: "segundo v1",
        receivedAt: "2026-07-13T16:00:01.000Z"
      }
    };
    const secondOwnerPosition = {
      streamId: threadBindingId,
      streamSequence: 2
    };

    const premature = await receiveChannelInboundEvent(db, second, secondOwnerPosition);
    expect(premature).toMatchObject({
      status: "gap",
      expectedSequence: 1,
      receivedSequence: 2
    });
    const beforeFirst = await db.query<{ count: number }>(
      `select count(*)::int as count
         from pulso_iris.inbox_events
        where tenant_id = $1 and event_id = any($2::uuid[])`,
      [tenantId, [first.id, second.id]]
    );
    expect(beforeFirst.rows[0]?.count).toBe(0);

    expect((await receiveChannelInboundEvent(db, first)).status).toBe("accepted");
    expect((await receiveChannelInboundEvent(db, second, secondOwnerPosition)).status).toBe("accepted");
    const checkpoint = await db.query<{ sequence: number }>(
      `select last_inbound_sequence::int as sequence
         from pulso_iris.channel_threads
        where tenant_id = $1 and id = $2`,
      [tenantId, threadBindingId]
    );
    expect(checkpoint.rows[0]?.sequence).toBe(2);
  });
});
