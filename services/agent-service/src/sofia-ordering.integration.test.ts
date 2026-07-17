import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("SOFIA ordered job workers", () => {
  let db: DatabaseClient;
  let tenantId = "";

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    const tenant = await db.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'SOFIA ordered workers test') returning id`,
      [`sofia-worker-order-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await db.query("delete from agent_runtime.jobs where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.job_stream_positions where tenant_id = $1", [tenantId]);
      await db.query("delete from platform.tenants where id = $1", [tenantId]);
    }
    await db.close();
  });

  it("does not let a second worker claim the successor while the head retries", async () => {
    const conversationId = randomUUID();
    const firstId = await insertJob(db, tenantId, conversationId, 1);
    const secondId = await insertJob(db, tenantId, conversationId, 2);

    const firstRace = await Promise.all([claimJob(db, "sofia-order-a"), claimJob(db, "sofia-order-b")]);
    expect(firstRace.flat().map((job) => job.id)).toEqual([firstId]);
    await db.query(
      `update agent_runtime.jobs
          set status = 'retry_scheduled', next_attempt_at = now() + interval '1 minute',
              locked_at = null, locked_by = null, updated_at = now()
        where id = $1`,
      [firstId]
    );

    const whileRetrying = await Promise.all([claimJob(db, "sofia-order-a"), claimJob(db, "sofia-order-b")]);
    expect(whileRetrying.flat()).toEqual([]);
    const blockedSuccessor = await db.query<{ deferred: boolean }>(
      `select next_attempt_at = 'infinity'::timestamptz as deferred
         from agent_runtime.jobs
        where id = $1`,
      [secondId]
    );
    expect(blockedSuccessor.rows[0]?.deferred).toBe(true);

    await db.query("update agent_runtime.jobs set next_attempt_at = now() where id = $1", [firstId]);
    const retryRace = await Promise.all([claimJob(db, "sofia-order-a"), claimJob(db, "sofia-order-b")]);
    expect(retryRace.flat().map((job) => [job.id, Number(job.streamSequence)])).toEqual([[firstId, 1]]);
    await db.query(
      `update agent_runtime.jobs
          set status = 'completed', completed_at = now(), locked_at = null, locked_by = null, updated_at = now()
        where id = $1`,
      [firstId]
    );

    const successorRace = await Promise.all([claimJob(db, "sofia-order-a"), claimJob(db, "sofia-order-b")]);
    expect(successorRace.flat().map((job) => [job.id, Number(job.streamSequence)])).toEqual([[secondId, 2]]);
  });

  it("keeps the origin/main polling insert and claim contract compatible with schema 037", async () => {
    const conversationId = randomUUID();
    const inboundEventId = randomUUID();
    const inserted = await db.query<{ id: string }>(
      `insert into agent_runtime.jobs
         (tenant_id, conversation_id, inbound_event_id, idempotency_key, status, input)
       values ($1, $2, $3, $4, 'queued', $5::jsonb)
       on conflict (tenant_id, inbound_event_id) do nothing
       returning id`,
      [
        tenantId,
        conversationId,
        inboundEventId,
        `sofia-inbound:${inboundEventId}`,
        JSON.stringify({
          patientId: randomUUID(),
          messageId: randomUUID(),
          threadBindingId: randomUUID(),
          occurredAt: "2026-07-13T17:00:00.000Z"
        })
      ]
    );
    const jobId = inserted.rows[0]!.id;

    const positioned = await db.query<{
      streamId: string;
      streamSequence: string | number;
      orderingSource: string;
    }>(
      `select stream_id as "streamId", stream_sequence as "streamSequence",
              ordering_source as "orderingSource"
         from agent_runtime.jobs
        where id = $1`,
      [jobId]
    );
    expect(positioned.rows[0]).toEqual({
      streamId: conversationId,
      streamSequence: "1",
      orderingSource: "legacy_polling_allocator"
    });

    const claimed = await claimJob(db, "origin-main-polling-worker");
    expect(claimed.map((job) => job.id)).toEqual([jobId]);
  });
});

async function insertJob(
  db: DatabaseClient,
  tenantId: string,
  conversationId: string,
  sequence: number
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into agent_runtime.jobs (
       tenant_id, conversation_id, inbound_event_id, idempotency_key,
       status, input, stream_id, stream_sequence, ordering_source
     ) values ($1, $2, $3, $4, 'queued', '{}'::jsonb, $2, $5, 'pulso_durable')
     returning id`,
    [tenantId, conversationId, randomUUID(), `sofia-order-${randomUUID()}`, sequence]
  );
  return result.rows[0]!.id;
}

async function claimJob(
  db: DatabaseClient,
  workerId: string
): Promise<Array<{ id: string; streamSequence: string | number }>> {
  const result = await db.query<{ id: string; streamSequence: string | number }>(
    `select id, stream_sequence as "streamSequence"
       from agent_runtime.claim_next_job($1)`,
    [workerId]
  );
  return result.rows;
}
