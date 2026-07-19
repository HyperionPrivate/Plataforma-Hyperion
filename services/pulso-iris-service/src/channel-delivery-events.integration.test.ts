import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHANNEL_DELIVERY_EVENT_TYPE,
  channelDeliveryEventSchema,
  receiveChannelDeliveryEvent,
  type ChannelDeliveryEvent
} from "./channel-delivery-events.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_PULSO_DATABASE_URL;
const TEST_PULSO_FIXTURE_DATABASE_URL = process.env.TEST_PULSO_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_PULSO_FIXTURE_DATABASE_URL ? describe : describe.skip;

let client: pg.Client;
let fixtureClient: pg.Client;
let db: DatabaseClient;
let tenantId: string;
let conversationId: string;

describeIntegration("durable Channel delivery projection", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    fixtureClient = new Client({ connectionString: TEST_PULSO_FIXTURE_DATABASE_URL });
    await client.connect();
    await fixtureClient.connect();
    db = createDatabase(TEST_DATABASE_URL ?? "");

    tenantId = randomUUID();
    conversationId = randomUUID();
    await fixtureClient.query(
      `insert into platform.tenants (id, slug, display_name)
       values ($1::uuid, $2, 'Channel delivery event integration')`,
      [tenantId, `channel-delivery-${tenantId}`]
    );
    await client.query(
      `insert into pulso_iris.conversations (id, tenant_id, channel, direction)
       values ($1::uuid, $2::uuid, 'whatsapp', 'outbound')`,
      [conversationId, tenantId]
    );
  });

  afterAll(async () => {
    await db?.close();
    if (client) {
      if (tenantId) {
        await client.query("delete from pulso_iris.inbox_events where tenant_id = $1::uuid", [tenantId]);
      }
      await client.end();
    }
    if (fixtureClient) {
      if (tenantId) await fixtureClient.query("delete from platform.tenants where id = $1::uuid", [tenantId]);
      await fixtureClient.end();
    }
  });

  it("commits the message projection and processed inbox result, then replays idempotently", async () => {
    const messageId = await createQueuedMessage("accepted and replayed");
    const event = deliveryEvent(messageId, 1, {
      outcome: "sent",
      provider: "whatsapp_web_test",
      providerMessageId: `accepted-${randomUUID()}`
    });

    await expect(receiveChannelDeliveryEvent(db, event)).resolves.toEqual({
      status: "accepted",
      result: { messageId, updated: true }
    });

    const committed = await readMessage(messageId);
    expect(committed).toMatchObject({
      deliveryStatus: "sent",
      provider: "whatsapp_web_test",
      providerMessageId: event.payload.outcome === "sent" ? event.payload.providerMessageId : undefined
    });
    const inbox = await readInbox(event.id);
    expect(inbox).toMatchObject({
      eventId: event.id,
      streamId: messageId,
      streamSequence: "1",
      processed: true,
      result: { messageId, updated: true }
    });

    await expect(receiveChannelDeliveryEvent(db, event)).resolves.toEqual({
      status: "replayed",
      result: { messageId, updated: true }
    });
    expect(await countInbox(event.id)).toBe(1);
    expect(await readMessage(messageId)).toEqual(committed);
  });

  it("rejects reuse of an event id with a different payload without changing the accepted state", async () => {
    const messageId = await createQueuedMessage("event identity conflict");
    const event = deliveryEvent(messageId, 1, {
      outcome: "sent",
      provider: "whatsapp_web_test",
      providerMessageId: `identity-${randomUUID()}`
    });
    await expect(receiveChannelDeliveryEvent(db, event)).resolves.toMatchObject({ status: "accepted" });

    const conflicting = channelDeliveryEventSchema.parse({
      ...event,
      payload: { messageId, outcome: "failed" }
    });
    await expect(receiveChannelDeliveryEvent(db, conflicting)).resolves.toEqual({
      status: "conflict",
      eventId: event.id
    });

    expect(await countInbox(event.id)).toBe(1);
    expect(await readMessage(messageId)).toMatchObject({
      deliveryStatus: "sent",
      providerMessageId: event.payload.outcome === "sent" ? event.payload.providerMessageId : undefined
    });
  });

  it("rolls back the provisional inbox row when a sequence gap is detected", async () => {
    const messageId = await createQueuedMessage("sequence gap");
    const event = deliveryEvent(messageId, 2, {
      outcome: "sent",
      provider: "whatsapp_web_test",
      providerMessageId: `gap-${randomUUID()}`
    });

    await expect(receiveChannelDeliveryEvent(db, event)).resolves.toEqual({
      status: "gap",
      eventId: event.id,
      streamId: messageId,
      expectedSequence: 1,
      receivedSequence: 2
    });
    expect(await countInbox(event.id)).toBe(0);
    expect(await readMessage(messageId)).toMatchObject({
      deliveryStatus: "queued",
      providerMessageId: null
    });
  });

  it("rolls back a missing target and accepts the same event after the message becomes available", async () => {
    const messageId = randomUUID();
    const event = deliveryEvent(messageId, 1, {
      outcome: "sent",
      provider: "whatsapp_web_test",
      providerMessageId: `late-target-${randomUUID()}`
    });

    await expect(receiveChannelDeliveryEvent(db, event)).resolves.toEqual({
      status: "retryable",
      eventId: event.id,
      reason: "target_not_found"
    });
    expect(await countInbox(event.id)).toBe(0);

    await createQueuedMessage("late delivery target", { id: messageId });
    await expect(receiveChannelDeliveryEvent(db, event)).resolves.toEqual({
      status: "accepted",
      result: { messageId, updated: true }
    });
    expect(await countInbox(event.id)).toBe(1);
    expect(await readMessage(messageId)).toMatchObject({
      deliveryStatus: "sent",
      provider: "whatsapp_web_test",
      providerMessageId: event.payload.outcome === "sent" ? event.payload.providerMessageId : undefined
    });
  });

  it("applies contiguous positions 1 then 2 and preserves the monotonic delivery state", async () => {
    const messageId = await createQueuedMessage("contiguous delivery state");
    const providerMessageId = `ordered-${randomUUID()}`;
    const sent = deliveryEvent(messageId, 1, {
      outcome: "sent",
      provider: "whatsapp_web_test",
      providerMessageId
    });
    const occurredAt = new Date(Date.now() - 1_000).toISOString();
    const read = deliveryEvent(
      messageId,
      2,
      {
        outcome: "reconcile",
        provider: "whatsapp_web_test",
        providerMessageId,
        status: "read",
        occurredAt
      },
      randomUUID()
    );

    await expect(receiveChannelDeliveryEvent(db, sent)).resolves.toMatchObject({ status: "accepted" });
    await expect(receiveChannelDeliveryEvent(db, read)).resolves.toMatchObject({ status: "accepted" });

    expect(await readMessage(messageId)).toMatchObject({
      deliveryStatus: "read",
      provider: "whatsapp_web_test",
      providerMessageId,
      deliveredAt: new Date(occurredAt)
    });
    const positions = await client.query<{ streamSequence: string }>(
      `select stream_sequence as "streamSequence"
         from pulso_iris.inbox_events
        where tenant_id = $1::uuid and stream_id = $2::uuid
          and event_type = $3 and processed_at is not null
        order by stream_sequence`,
      [tenantId, messageId, CHANNEL_DELIVERY_EVENT_TYPE]
    );
    expect(positions.rows.map((row) => row.streamSequence)).toEqual(["1", "2"]);
  });

  it("persists uncertain provider identity and rolls back a mismatched reconciliation without consuming its position", async () => {
    const messageId = await createQueuedMessage("uncertain provider identity");
    const providerMessageId = `uncertain-${randomUUID()}`;
    const uncertain = deliveryEvent(messageId, 1, {
      outcome: "uncertain",
      provider: "whatsapp_web_test",
      providerMessageId
    });
    const reconciled = deliveryEvent(
      messageId,
      2,
      {
        outcome: "reconcile",
        provider: "whatsapp_web_test",
        providerMessageId,
        status: "read",
        occurredAt: new Date(Date.now() - 2_000).toISOString()
      },
      randomUUID()
    );

    await expect(receiveChannelDeliveryEvent(db, uncertain)).resolves.toMatchObject({ status: "accepted" });
    await expect(receiveChannelDeliveryEvent(db, reconciled)).resolves.toMatchObject({ status: "accepted" });
    expect(await readMessage(messageId)).toMatchObject({
      deliveryStatus: "read",
      provider: "whatsapp_web_test",
      providerMessageId
    });

    const conflicting = deliveryEvent(
      messageId,
      3,
      {
        outcome: "reconcile",
        provider: "whatsapp_web_test",
        providerMessageId: `different-${randomUUID()}`,
        status: "delivered",
        occurredAt: new Date(Date.now() - 1_000).toISOString()
      },
      randomUUID()
    );
    await expect(receiveChannelDeliveryEvent(db, conflicting)).resolves.toEqual({
      status: "conflict",
      eventId: conflicting.id
    });
    expect(await countInbox(conflicting.id)).toBe(0);

    const legitimate = deliveryEvent(
      messageId,
      3,
      {
        outcome: "reconcile",
        provider: "whatsapp_web_test",
        providerMessageId,
        status: "failed",
        occurredAt: new Date().toISOString()
      },
      randomUUID()
    );
    await expect(receiveChannelDeliveryEvent(db, legitimate)).resolves.toMatchObject({ status: "accepted" });
    expect(await countInbox(legitimate.id)).toBe(1);
    expect(await readMessage(messageId)).toMatchObject({
      deliveryStatus: "read",
      provider: "whatsapp_web_test",
      providerMessageId
    });
  });

  it("rejects a second event at an occupied stream position and leaves no conflicting inbox row", async () => {
    const messageId = await createQueuedMessage("unique stream position");
    const accepted = deliveryEvent(messageId, 1, {
      outcome: "sent",
      provider: "whatsapp_web_test",
      providerMessageId: `position-a-${randomUUID()}`
    });
    await expect(receiveChannelDeliveryEvent(db, accepted)).resolves.toMatchObject({ status: "accepted" });

    const conflict = deliveryEvent(
      messageId,
      1,
      {
        outcome: "sent",
        provider: "whatsapp_web_test",
        providerMessageId: `position-b-${randomUUID()}`
      },
      randomUUID()
    );
    await expect(receiveChannelDeliveryEvent(db, conflict)).resolves.toEqual({
      status: "conflict",
      eventId: conflict.id
    });

    expect(await countInbox(conflict.id)).toBe(0);
    expect(await readMessage(messageId)).toMatchObject({
      deliveryStatus: "sent",
      providerMessageId: accepted.payload.outcome === "sent" ? accepted.payload.providerMessageId : undefined
    });
  });

  it("reports a provider identity uniqueness conflict and rolls back the inbox insert", async () => {
    const providerMessageId = `duplicate-provider-${randomUUID()}`;
    await createQueuedMessage("provider id owner", {
      providerMessageId,
      deliveryStatus: "sent"
    });
    const messageId = await createQueuedMessage("projection must roll back");
    const event = deliveryEvent(messageId, 1, {
      outcome: "sent",
      provider: "whatsapp_web_test",
      providerMessageId
    });

    await expect(receiveChannelDeliveryEvent(db, event)).resolves.toEqual({
      status: "conflict",
      eventId: event.id
    });
    expect(await countInbox(event.id)).toBe(0);
    expect(await readMessage(messageId)).toMatchObject({
      deliveryStatus: "queued",
      providerMessageId: null
    });
  });
});

type DeliveryPayload = ChannelDeliveryEvent["payload"] extends infer Payload
  ? Payload extends { messageId: string }
    ? Omit<Payload, "messageId">
    : never
  : never;

function deliveryEvent(
  messageId: string,
  streamSequence: number,
  payload: DeliveryPayload,
  id = randomUUID()
): ChannelDeliveryEvent {
  return channelDeliveryEventSchema.parse({
    id,
    type: CHANNEL_DELIVERY_EVENT_TYPE,
    version: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    streamId: messageId,
    streamSequence,
    payload: { messageId, ...payload }
  });
}

async function createQueuedMessage(
  body: string,
  options: { id?: string; providerMessageId?: string; deliveryStatus?: "queued" | "sent" } = {}
): Promise<string> {
  const messageId = options.id ?? randomUUID();
  await client.query(
    `insert into pulso_iris.messages (
       id, tenant_id, conversation_id, sender, body, provider, provider_message_id, delivery_status
     ) values ($1::uuid, $2::uuid, $3::uuid, 'sofia', $4, 'whatsapp_web_test', $5, $6)`,
    [messageId, tenantId, conversationId, body, options.providerMessageId ?? null, options.deliveryStatus ?? "queued"]
  );
  return messageId;
}

async function readMessage(messageId: string): Promise<{
  deliveryStatus: string | null;
  provider: string | null;
  providerMessageId: string | null;
  deliveredAt: Date | null;
}> {
  const result = await client.query<{
    deliveryStatus: string | null;
    provider: string | null;
    providerMessageId: string | null;
    deliveredAt: Date | null;
  }>(
    `select delivery_status as "deliveryStatus", provider,
            provider_message_id as "providerMessageId", delivered_at as "deliveredAt"
       from pulso_iris.messages
      where tenant_id = $1::uuid and id = $2::uuid`,
    [tenantId, messageId]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Missing integration message ${messageId}`);
  return row;
}

async function readInbox(eventId: string): Promise<{
  eventId: string;
  streamId: string | null;
  streamSequence: string | null;
  processed: boolean;
  result: unknown;
}> {
  const result = await client.query<{
    eventId: string;
    streamId: string | null;
    streamSequence: string | null;
    processed: boolean;
    result: unknown;
  }>(
    `select event_id as "eventId", stream_id as "streamId",
            stream_sequence as "streamSequence", processed_at is not null as processed, result
       from pulso_iris.inbox_events
      where tenant_id = $1::uuid and event_id = $2::uuid`,
    [tenantId, eventId]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Missing integration inbox event ${eventId}`);
  return row;
}

async function countInbox(eventId: string): Promise<number> {
  const result = await client.query<{ count: number }>(
    `select count(*)::int as count
       from pulso_iris.inbox_events
      where tenant_id = $1::uuid and event_id = $2::uuid`,
    [tenantId, eventId]
  );
  return result.rows[0]?.count ?? 0;
}
