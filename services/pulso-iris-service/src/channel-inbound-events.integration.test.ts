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
      await db.query("delete from platform.tenants where id = $1", [tenantId]);
    }
    await db.close();
  });

  it("commits local projections and one next-hop outbox event, then replays idempotently", async () => {
    const event: ChannelInboundEvent = {
      id: randomUUID(),
      type: "channel.inbound.received.v1",
      version: 1,
      occurredAt: "2026-07-13T15:00:00.000Z",
      tenantId,
      payload: {
        inboundEventId: randomUUID(),
        threadBindingId: randomUUID(),
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
    const replayed = await receiveChannelInboundEvent(db, event);
    const counts = await db.query<{ inbox: number; messages: number; outbox: number }>(
      `select
         (select count(*)::int from pulso_iris.inbox_events where tenant_id = $1) as inbox,
         (select count(*)::int from pulso_iris.messages where tenant_id = $1) as messages,
         (select count(*)::int from pulso_iris.outbox_events where tenant_id = $1) as outbox`,
      [tenantId]
    );

    expect(accepted.status).toBe("accepted");
    expect(replayed).toEqual({ status: "replayed", result: accepted.status === "accepted" ? accepted.result : null });
    expect(counts.rows[0]).toEqual({ inbox: 1, messages: 1, outbox: 1 });
  });
});
