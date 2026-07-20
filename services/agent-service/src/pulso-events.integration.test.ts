import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  consumePulsoMessageEvent,
  type LegacyPulsoMessageEvent,
  type OrderedPulsoMessageEvent
} from "./pulso-events.js";
import type { PulsoEventPosition } from "./pulso-position-client.js";

const TEST_DATABASE_URL = process.env.TEST_SOFIA_DATABASE_URL;
const TEST_PULSO_FIXTURE_DATABASE_URL = process.env.TEST_PULSO_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_PULSO_FIXTURE_DATABASE_URL ? describe : describe.skip;

describeIntegration("durable PULSO -> SOFIA persistence", () => {
  let db: DatabaseClient;
  let fixtureDb: DatabaseClient;
  let tenantId = "";

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    fixtureDb = createDatabase(TEST_PULSO_FIXTURE_DATABASE_URL ?? "");
    const tenant = await fixtureDb.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'Autonomous SOFIA flow test') returning id`,
      [`autonomous-sofia-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]!.id;
    await db.query(
      `insert into agent_runtime.tenant_snapshots (
         tenant_id, status, source_event_id, source_version, source_updated_at, payload_hash
       ) values ($1::uuid, 'active', $2::uuid, 1, now(), $3)`,
      [tenantId, randomUUID(), "a".repeat(64)]
    );
  });

  afterAll(async () => {
    if (tenantId) {
      await db.query("delete from agent_runtime.outbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.jobs where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.inbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.job_stream_positions where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.pulso_stream_positions where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.access_projection_inbox where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.tenant_snapshots where tenant_id = $1", [tenantId]);
      await fixtureDb.query("delete from platform.tenants where id = $1", [tenantId]);
    }
    await db.close();
    await fixtureDb.close();
  });

  it("persists a contiguous v2 stream, rejects a gap and keeps successor jobs behind the head", async () => {
    const conversationId = randomUUID();
    const sourceStreamId = randomUUID();
    const firstEvent: OrderedPulsoMessageEvent = {
      id: randomUUID(),
      type: "pulso.message.received.v2",
      version: 2,
      occurredAt: "2026-07-13T15:05:00.000Z",
      tenantId,
      streamId: conversationId,
      streamSequence: 1,
      payload: {
        inboundEventId: randomUUID(),
        threadBindingId: sourceStreamId,
        patientId: randomUUID(),
        conversationId,
        messageId: randomUUID(),
        occurredAt: "2026-07-13T15:05:00.000Z",
        sourceStreamId,
        sourceStreamSequence: 1
      }
    };
    const secondEvent: OrderedPulsoMessageEvent = {
      ...firstEvent,
      id: randomUUID(),
      occurredAt: "2026-07-13T15:05:01.000Z",
      streamSequence: 2,
      payload: {
        ...firstEvent.payload,
        inboundEventId: randomUUID(),
        messageId: randomUUID(),
        occurredAt: "2026-07-13T15:05:01.000Z",
        sourceStreamSequence: 2
      }
    };

    const gap = await consumePulsoMessageEvent(db, secondEvent);
    const acceptedFirst = await consumePulsoMessageEvent(db, firstEvent);
    const acceptedSecond = await consumePulsoMessageEvent(db, secondEvent);
    const replayed = await consumePulsoMessageEvent(db, firstEvent);
    const counts = await db.query<{ inbox: number; jobs: number; outbox: number }>(
      `select
         (select count(*)::int from agent_runtime.inbox_events where tenant_id = $1) as inbox,
         (select count(*)::int from agent_runtime.jobs where tenant_id = $1) as jobs,
         (select count(*)::int from agent_runtime.outbox_events where tenant_id = $1) as outbox`,
      [tenantId]
    );

    expect(gap).toEqual({
      status: "gap",
      streamId: conversationId,
      expectedSequence: 1,
      receivedSequence: 2
    });
    expect(acceptedFirst.status).toBe("accepted");
    expect(acceptedSecond.status).toBe("accepted");
    expect(replayed).toEqual({
      status: "duplicate",
      jobId: acceptedFirst.status === "accepted" ? acceptedFirst.jobId : ""
    });
    expect(counts.rows[0]).toEqual({ inbox: 2, jobs: 2, outbox: 2 });

    const jobsBeforeRelease = await db.query<{
      id: string;
      streamSequence: string;
      ready: boolean;
    }>(
      `select id, stream_sequence as "streamSequence", next_attempt_at <= now() as ready
         from agent_runtime.jobs
        where tenant_id = $1 and stream_id = $2
        order by stream_sequence`,
      [tenantId, conversationId]
    );
    expect(jobsBeforeRelease.rows.map((row) => ({ sequence: Number(row.streamSequence), ready: row.ready }))).toEqual([
      { sequence: 1, ready: true },
      { sequence: 2, ready: false }
    ]);

    await db.query(
      `update agent_runtime.jobs
          set status = 'completed', completed_at = now(), updated_at = now()
        where id = $1`,
      [acceptedFirst.status === "accepted" ? acceptedFirst.jobId : ""]
    );
    const released = await db.query<{ ready: boolean }>(
      `select next_attempt_at <= now() as ready
         from agent_runtime.jobs
        where id = $1`,
      [acceptedSecond.status === "accepted" ? acceptedSecond.jobId : ""]
    );
    expect(released.rows[0]?.ready).toBe(true);
  });

  it("treats an owner-resolved v1 delivery and its v2 upgrade replay as one event", async () => {
    const position: PulsoEventPosition = {
      streamId: randomUUID(),
      streamSequence: 1,
      sourceStreamId: randomUUID(),
      sourceStreamSequence: 1
    };
    const legacy: LegacyPulsoMessageEvent = {
      id: randomUUID(),
      type: "pulso.message.received.v1",
      version: 1,
      occurredAt: "2026-07-13T16:00:00.000Z",
      tenantId,
      payload: {
        inboundEventId: randomUUID(),
        threadBindingId: position.sourceStreamId,
        patientId: randomUUID(),
        conversationId: position.streamId,
        messageId: randomUUID(),
        occurredAt: "2026-07-13T16:00:00.000Z"
      }
    };
    const upgraded: OrderedPulsoMessageEvent = {
      ...legacy,
      type: "pulso.message.received.v2",
      version: 2,
      streamId: position.streamId,
      streamSequence: position.streamSequence,
      payload: {
        ...legacy.payload,
        sourceStreamId: position.sourceStreamId,
        sourceStreamSequence: position.sourceStreamSequence
      }
    };

    const accepted = await consumePulsoMessageEvent(db, legacy, position);
    const replayed = await consumePulsoMessageEvent(db, upgraded);

    expect(accepted.status).toBe("accepted");
    expect(replayed).toEqual({
      status: "duplicate",
      jobId: accepted.status === "accepted" ? accepted.jobId : ""
    });
    const persisted = await db.query<{ inbox: number; jobs: number }>(
      `select
         (select count(*)::int from agent_runtime.inbox_events where event_id = $1) as inbox,
         (select count(*)::int from agent_runtime.jobs where tenant_id = $2 and inbound_event_id = $3) as jobs`,
      [legacy.id, tenantId, legacy.payload.inboundEventId]
    );
    expect(persisted.rows[0]).toEqual({ inbox: 1, jobs: 1 });
  });

  it("serializes concurrent replays into one accepted delivery and one duplicate", async () => {
    const conversationId = randomUUID();
    const sourceStreamId = randomUUID();
    const event: OrderedPulsoMessageEvent = {
      id: randomUUID(),
      type: "pulso.message.received.v2",
      version: 2,
      occurredAt: "2026-07-13T17:00:00.000Z",
      tenantId,
      streamId: conversationId,
      streamSequence: 1,
      payload: {
        inboundEventId: randomUUID(),
        threadBindingId: sourceStreamId,
        patientId: randomUUID(),
        conversationId,
        messageId: randomUUID(),
        occurredAt: "2026-07-13T17:00:00.000Z",
        sourceStreamId,
        sourceStreamSequence: 1
      }
    };

    const concurrentDb = gateTransactionsBeforeAdvisoryLock(db, 2);
    const deliveries = await Promise.all([
      consumePulsoMessageEvent(concurrentDb, event),
      consumePulsoMessageEvent(concurrentDb, event)
    ]);
    const accepted = deliveries.find((delivery) => delivery.status === "accepted");
    const duplicate = deliveries.find((delivery) => delivery.status === "duplicate");

    expect(deliveries.map((delivery) => delivery.status).sort()).toEqual(["accepted", "duplicate"]);
    expect(accepted?.status).toBe("accepted");
    expect(duplicate?.status).toBe("duplicate");
    expect(duplicate?.status === "duplicate" ? duplicate.jobId : undefined).toBe(
      accepted?.status === "accepted" ? accepted.jobId : undefined
    );

    const jobId = accepted?.status === "accepted" ? accepted.jobId : "";
    const persisted = await db.query<{ inbox: number; jobs: number; outbox: number }>(
      `select
         (select count(*)::int from agent_runtime.inbox_events where event_id = $1) as inbox,
         (select count(*)::int from agent_runtime.jobs where tenant_id = $2 and inbound_event_id = $3) as jobs,
         (select count(*)::int from agent_runtime.outbox_events where tenant_id = $2 and aggregate_id = $4) as outbox`,
      [event.id, tenantId, event.payload.inboundEventId, jobId]
    );
    expect(persisted.rows[0]).toEqual({ inbox: 1, jobs: 1, outbox: 1 });
  });
});

function gateTransactionsBeforeAdvisoryLock(database: DatabaseClient, participants: number): DatabaseClient {
  let arrivals = 0;
  let releaseBarrier: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  return {
    query: (text, params) => database.query(text, params),
    transaction: (work) =>
      database.transaction((transaction) =>
        work({
          query: async (text: string, params?: unknown[]) => {
            if (text.includes("pg_advisory_xact_lock")) {
              arrivals += 1;
              if (arrivals === participants) releaseBarrier?.();
              await barrier;
            }
            return transaction.query(text, params);
          }
        } as never)
      ),
    close: async () => undefined
  };
}
