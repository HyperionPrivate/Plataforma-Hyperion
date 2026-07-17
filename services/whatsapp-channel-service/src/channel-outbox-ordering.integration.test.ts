import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChannelOutbox } from "./channel-outbox.js";
import { PostgresChannelRepository } from "./channel-repository.js";
import { createDatabasePulsoDeliveryGuard } from "./pulso-delivery.integration.test.support.js";
import { WHATSAPP_PROVIDER_MODE } from "./types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("Channel outbox conversation ordering", () => {
  let db: DatabaseClient;
  let tenantId = "";
  let repository: PostgresChannelRepository;

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    const tenant = await db.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'Channel ordering integration test') returning id`,
      [`channel-ordering-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]?.id ?? "";
    repository = new PostgresChannelRepository(db, createDatabasePulsoDeliveryGuard(db));
    await repository.projectConnection(tenantId, {
      providerMode: WHATSAPP_PROVIDER_MODE,
      state: "ready",
      phoneMasked: "********1111",
      sessionRestorable: true
    });
  });

  afterAll(async () => {
    if (tenantId) {
      await db.query("delete from channel_runtime.outbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from platform.tenants where id = $1", [tenantId]);
    }
    await db.close();
  });

  it("serializes concurrent allocation and prevents another worker from overtaking a retry", async () => {
    const base = {
      tenantId,
      provider: WHATSAPP_PROVIDER_MODE,
      providerAddress: `${randomUUID()}@s.whatsapp.net`,
      phoneHash: "d".repeat(64),
      phoneMasked: "********1111"
    } as const;
    const [first, second] = await Promise.all([
      repository.persistInbound({
        ...base,
        externalMessageId: `ordered-a-${randomUUID()}`,
        body: "mensaje ordenado A",
        receivedAt: new Date("2026-07-13T20:00:00.000Z")
      }),
      repository.persistInbound({
        ...base,
        externalMessageId: `ordered-b-${randomUUID()}`,
        body: "mensaje ordenado B",
        receivedAt: new Date("2026-07-13T20:00:01.000Z")
      })
    ]);

    const positions = await db.query<{ id: string; streamId: string; streamSequence: number }>(
      `select id, stream_id as "streamId", stream_sequence::int as "streamSequence"
       from channel_runtime.outbox_events
       where tenant_id = $1 and aggregate_id = any($2::uuid[])
       order by stream_sequence`,
      [tenantId, [first.eventId, second.eventId]]
    );
    expect(positions.rows.map((row) => row.streamSequence)).toEqual([1, 2]);
    expect(new Set(positions.rows.map((row) => row.streamId))).toEqual(new Set([first.threadBindingId]));

    const workers = [
      new PostgresChannelOutbox(db, "ordering-worker-a", "http://pulso.local"),
      new PostgresChannelOutbox(db, "ordering-worker-b", "http://pulso.local")
    ] as const;
    const initialClaims = await Promise.all(workers.map((worker) => worker.claim(1, tenantId)));
    expect(initialClaims.flat()).toHaveLength(1);
    const initialOwner = initialClaims.findIndex((claim) => claim.length === 1);
    const initial = initialClaims[initialOwner]![0]!;
    expect(initial.streamSequence).toBe(1);

    await workers[initialOwner]!.fail(initial.id, "http_503");
    const whileRetrying = await Promise.all(workers.map((worker) => worker.claim(1, tenantId)));
    expect(whileRetrying.flat()).toHaveLength(0);
    await expect(legacyNMinusOneClaim(db, tenantId, "ordering-legacy-blocked")).resolves.toEqual([]);

    await db.query(
      `update channel_runtime.outbox_events
       set next_attempt_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, initial.id]
    );
    const retried = (await legacyNMinusOneClaim(db, tenantId, "ordering-legacy-retry"))[0]!;
    expect(retried).toMatchObject({ id: initial.id, streamSequence: 1 });
    await new PostgresChannelOutbox(db, "ordering-legacy-retry", "http://pulso.local").complete(retried.id);

    const successor = (await legacyNMinusOneClaim(db, tenantId, "ordering-legacy-successor"))[0]!;
    expect(successor.streamSequence).toBe(2);
    await new PostgresChannelOutbox(db, "ordering-legacy-successor", "http://pulso.local").complete(successor.id);

    const finalState = await db.query<{ streamSequence: number; status: string }>(
      `select stream_sequence::int as "streamSequence", status
       from channel_runtime.outbox_events
       where tenant_id = $1 and aggregate_id = any($2::uuid[])
       order by stream_sequence`,
      [tenantId, [first.eventId, second.eventId]]
    );
    expect(finalState.rows).toEqual([
      { streamSequence: 1, status: "published" },
      { streamSequence: 2, status: "published" }
    ]);
  });
});

async function legacyNMinusOneClaim(
  db: DatabaseClient,
  tenantId: string,
  workerId: string
): Promise<Array<{ id: string; streamSequence: number }>> {
  const result = await db.query<{ id: string; streamSequence: number }>(
    `with candidates as (
       select id
       from channel_runtime.outbox_events
       where tenant_id = $2
         and (
           status in ('queued', 'retry_scheduled')
           or (status = 'processing' and locked_at < now() - interval '2 minutes')
         )
         and next_attempt_at <= now()
         and attempt_count < max_attempts
       order by next_attempt_at, created_at
       for update skip locked
       limit 10
     )
     update channel_runtime.outbox_events event
     set status = 'processing', attempt_count = event.attempt_count + 1,
         locked_at = now(), locked_by = $1, updated_at = now()
     from candidates
     where event.id = candidates.id
     returning event.id, event.stream_sequence::int as "streamSequence"`,
    [workerId, tenantId]
  );
  return result.rows;
}
