import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPulsoOutbox } from "./pulso-outbox.js";

const TEST_DATABASE_URL = process.env.TEST_PULSO_DATABASE_URL;
const TEST_PULSO_FIXTURE_DATABASE_URL = process.env.TEST_PULSO_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_PULSO_FIXTURE_DATABASE_URL ? describe : describe.skip;

describeIntegration("PULSO ordered outbox workers", () => {
  let db: DatabaseClient;
  let fixtureDb: DatabaseClient;
  let tenantId = "";

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    fixtureDb = createDatabase(TEST_PULSO_FIXTURE_DATABASE_URL ?? "");
    const tenant = await fixtureDb.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'PULSO ordered outbox test') returning id`,
      [`pulso-outbox-order-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await db.query("delete from pulso_iris.outbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from pulso_iris.outbox_event_positions where tenant_id = $1", [tenantId]);
      await db.query("delete from pulso_iris.outbox_stream_positions where tenant_id = $1", [tenantId]);
      await fixtureDb.query("delete from platform.tenants where id = $1", [tenantId]);
    }
    await db.close();
    await fixtureDb.close();
  });

  it("keeps the successor blocked across competing workers and a head retry", async () => {
    const conversationId = randomUUID();
    const sourceStreamId = randomUUID();
    const firstId = await insertOutboxEvent(db, {
      tenantId,
      conversationId,
      sourceStreamId,
      sourceStreamSequence: 1,
      occurredAt: "2026-07-13T14:00:00.000Z"
    });
    const secondId = await insertOutboxEvent(db, {
      tenantId,
      conversationId,
      sourceStreamId,
      sourceStreamSequence: 2,
      occurredAt: "2026-07-13T14:00:01.000Z"
    });

    const persistedPositions = await db.query<{
      id: string;
      eventType: string;
      eventVersion: number;
      streamId: string;
      streamSequence: string;
      sourceStreamId: string;
      sourceStreamSequence: string;
      ledgerStreamId: string;
      ledgerStreamSequence: string;
      ledgerSourceStreamId: string;
      ledgerSourceStreamSequence: string;
    }>(
      `select event.id,
              event.event_type as "eventType",
              event.event_version as "eventVersion",
              event.stream_id as "streamId",
              event.stream_sequence as "streamSequence",
              event.source_stream_id as "sourceStreamId",
              event.source_stream_sequence as "sourceStreamSequence",
              position.stream_id as "ledgerStreamId",
              position.stream_sequence as "ledgerStreamSequence",
              position.source_stream_id as "ledgerSourceStreamId",
              position.source_stream_sequence as "ledgerSourceStreamSequence"
         from pulso_iris.outbox_events event
         join pulso_iris.outbox_event_positions position
           on position.tenant_id = event.tenant_id
          and position.event_id = event.id
        where event.id = any($1::uuid[])
        order by event.stream_sequence`,
      [[firstId, secondId]]
    );
    expect(persistedPositions.rows).toEqual([
      {
        id: firstId,
        eventType: "pulso.message.received.v2",
        eventVersion: 2,
        streamId: conversationId,
        streamSequence: "1",
        sourceStreamId,
        sourceStreamSequence: "1",
        ledgerStreamId: conversationId,
        ledgerStreamSequence: "1",
        ledgerSourceStreamId: sourceStreamId,
        ledgerSourceStreamSequence: "1"
      },
      {
        id: secondId,
        eventType: "pulso.message.received.v2",
        eventVersion: 2,
        streamId: conversationId,
        streamSequence: "2",
        sourceStreamId,
        sourceStreamSequence: "2",
        ledgerStreamId: conversationId,
        ledgerStreamSequence: "2",
        ledgerSourceStreamId: sourceStreamId,
        ledgerSourceStreamSequence: "2"
      }
    ]);

    const workerA = new PostgresPulsoOutbox(db, "pulso-order-a", "http://agent.test");
    const workerB = new PostgresPulsoOutbox(db, "pulso-order-b", "http://agent.test");
    const firstRace = await Promise.all([workerA.claim(1, tenantId), workerB.claim(1, tenantId)]);
    expect(firstRace.flat().map((event) => event.id)).toEqual([firstId]);
    const firstOwner = firstRace[0]!.length > 0 ? workerA : workerB;
    await firstOwner.fail(firstId, "synthetic_retry");
    await db.query("update pulso_iris.outbox_events set next_attempt_at = now() + interval '1 hour' where id = $1", [
      firstId
    ]);

    const whileRetrying = await Promise.all([workerA.claim(1, tenantId), workerB.claim(1, tenantId)]);
    expect(whileRetrying.flat()).toEqual([]);
    const blockedSuccessor = await db.query<{ deferred: boolean }>(
      `select next_attempt_at = 'infinity'::timestamptz as deferred
         from pulso_iris.outbox_events
        where id = $1`,
      [secondId]
    );
    expect(blockedSuccessor.rows[0]?.deferred).toBe(true);

    await db.query("update pulso_iris.outbox_events set next_attempt_at = now() where id = $1", [firstId]);
    const retryRace = await Promise.all([workerA.claim(1, tenantId), workerB.claim(1, tenantId)]);
    expect(retryRace.flat().map((event) => [event.id, event.streamSequence])).toEqual([[firstId, 1]]);
    const retryOwner = retryRace[0]!.length > 0 ? workerA : workerB;
    await retryOwner.complete(firstId);

    const successorRace = await Promise.all([workerA.claim(1, tenantId), workerB.claim(1, tenantId)]);
    expect(successorRace.flat().map((event) => [event.id, event.streamSequence])).toEqual([[secondId, 2]]);
    const successorOwner = successorRace[0]!.length > 0 ? workerA : workerB;
    await successorOwner.complete(secondId);

    const finalState = await db.query<{ id: string; status: string; attempts: number }>(
      `select id, status, attempt_count as attempts
         from pulso_iris.outbox_events
        where id = any($1::uuid[])
        order by stream_sequence`,
      [[firstId, secondId]]
    );
    expect(finalState.rows).toEqual([
      { id: firstId, status: "published", attempts: 2 },
      { id: secondId, status: "published", attempts: 1 }
    ]);
  });
});

async function insertOutboxEvent(
  db: DatabaseClient,
  options: {
    tenantId: string;
    conversationId: string;
    sourceStreamId: string;
    sourceStreamSequence: number;
    occurredAt: string;
  }
): Promise<string> {
  const messageId = randomUUID();
  const result = await db.query<{ id: string }>(
    `insert into pulso_iris.outbox_events (
       tenant_id, event_type, event_version, aggregate_type, aggregate_id,
       payload, occurred_at
     ) values ($1, 'pulso.message.received.v2', 2, 'message', $2, $3::jsonb, $4)
     returning id`,
    [
      options.tenantId,
      messageId,
      JSON.stringify({
        inboundEventId: randomUUID(),
        threadBindingId: options.sourceStreamId,
        patientId: randomUUID(),
        conversationId: options.conversationId,
        messageId,
        occurredAt: options.occurredAt,
        sourceStreamId: options.sourceStreamId,
        sourceStreamSequence: options.sourceStreamSequence
      }),
      options.occurredAt
    ]
  );
  return result.rows[0]!.id;
}
