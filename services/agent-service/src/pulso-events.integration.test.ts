import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumePulsoMessageEvent, type PulsoMessageEvent } from "./pulso-events.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("durable PULSO -> SOFIA persistence", () => {
  let db: DatabaseClient;
  let tenantId = "";

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    const tenant = await db.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'Autonomous SOFIA flow test') returning id`,
      [`autonomous-sofia-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await db.query("delete from agent_runtime.outbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.inbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from agent_runtime.jobs where tenant_id = $1", [tenantId]);
      await db.query("delete from platform.tenants where id = $1", [tenantId]);
    }
    await db.close();
  });

  it("creates one job and one audit event in the outbox across a replay", async () => {
    const event: PulsoMessageEvent = {
      id: randomUUID(),
      type: "pulso.message.received.v1",
      version: 1,
      occurredAt: "2026-07-13T15:05:00.000Z",
      tenantId,
      payload: {
        inboundEventId: randomUUID(),
        threadBindingId: randomUUID(),
        patientId: randomUUID(),
        conversationId: randomUUID(),
        messageId: randomUUID(),
        occurredAt: "2026-07-13T15:05:00.000Z"
      }
    };

    const accepted = await consumePulsoMessageEvent(db, event);
    const replayed = await consumePulsoMessageEvent(db, event);
    const counts = await db.query<{ inbox: number; jobs: number; outbox: number }>(
      `select
         (select count(*)::int from agent_runtime.inbox_events where tenant_id = $1) as inbox,
         (select count(*)::int from agent_runtime.jobs where tenant_id = $1) as jobs,
         (select count(*)::int from agent_runtime.outbox_events where tenant_id = $1) as outbox`,
      [tenantId]
    );

    expect(accepted.status).toBe("accepted");
    expect(replayed).toEqual({
      status: "duplicate",
      jobId: accepted.status === "accepted" ? accepted.jobId : ""
    });
    expect(counts.rows[0]).toEqual({ inbox: 1, jobs: 1, outbox: 1 });
  });
});
