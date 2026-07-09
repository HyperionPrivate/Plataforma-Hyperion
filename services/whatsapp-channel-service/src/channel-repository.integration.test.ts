import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChannelRepository } from "./channel-repository.js";
import { WHATSAPP_PROVIDER_MODE } from "./types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("PostgresChannelRepository", () => {
  let db: DatabaseClient;
  let repository: PostgresChannelRepository;
  let tenantId: string;

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    const tenant = await db.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'WhatsApp repository integration test')
       returning id`,
      [`wa-repository-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]?.id ?? "";
    repository = new PostgresChannelRepository(db);
    await repository.projectConnection(tenantId, {
      providerMode: WHATSAPP_PROVIDER_MODE,
      state: "ready",
      phoneMasked: "********4567",
      sessionRestorable: true
    });
  });

  afterAll(async () => {
    if (tenantId) await db.query("delete from platform.tenants where id = $1", [tenantId]);
    await db.close();
  });

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
    const counts = await db.query<{ events: number; bindings: number }>(
      `select
         (select count(*)::int from channel_runtime.inbound_events where tenant_id = $1) as events,
         (select count(*)::int from channel_runtime.thread_bindings where tenant_id = $1) as bindings`,
      [tenantId]
    );

    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, eventId: first.eventId });
    expect(counts.rows[0]).toEqual({ events: 1, bindings: 1 });
  });

  it("enqueues idempotently, claims once and records delivery", async () => {
    const binding = await db.query<{ id: string }>(
      `select id from channel_runtime.thread_bindings where tenant_id = $1 limit 1`,
      [tenantId]
    );
    const conversation = await db.query<{ id: string }>(
      `insert into pulso_iris.conversations (tenant_id, channel, direction, status)
       values ($1, 'whatsapp', 'inbound', 'active') returning id`,
      [tenantId]
    );
    const message = await db.query<{ id: string }>(
      `insert into pulso_iris.messages (
         tenant_id, conversation_id, sender, body, provider, delivery_status
       ) values ($1, $2, 'sofia', 'respuesta sintetica', $3, 'queued') returning id`,
      [tenantId, conversation.rows[0]?.id, WHATSAPP_PROVIDER_MODE]
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
    const claimed = await repository.claimOutbound("repository-test-worker");

    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ id: first.id, inserted: false });
    expect(claimed).toMatchObject({ id: first.id, tenantId, body: input.body });
    if (!claimed) throw new Error("Expected an outbound message");
    await expect(repository.markOutboundSending({ ...claimed, workerId: "another-worker" })).resolves.toBe(false);
    await expect(repository.markOutboundSending(claimed)).resolves.toBe(true);
    await expect(
      repository.markOutboundSent({ ...claimed, workerId: "another-worker" }, "provider-wrong-worker", new Date())
    ).resolves.toBe(false);
    await expect(repository.markOutboundSent(claimed, "provider-outbound-1", new Date())).resolves.toBe(true);
    await repository.updateDelivery({
      tenantId,
      provider: WHATSAPP_PROVIDER_MODE,
      providerMessageId: "provider-outbound-1",
      status: "delivered",
      occurredAt: new Date()
    });
    const state = await db.query<{ outbound: string; message: string }>(
      `select o.status as outbound, m.delivery_status as message
       from channel_runtime.outbound_messages o
       join pulso_iris.messages m on m.tenant_id = o.tenant_id and m.id = o.message_id
       where o.tenant_id = $1 and o.id = $2`,
      [tenantId, first.id]
    );
    expect(state.rows[0]).toEqual({ outbound: "delivered", message: "delivered" });
  });
});
