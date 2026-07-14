import { jetstream } from "@nats-io/jetstream";
import { PermissionViolationError, RequestError, connect, type NatsConnection } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testUrl = process.env.TEST_NATS_ACL_URL;
const channelPassword = process.env.TEST_NATS_CHANNEL_PASSWORD;
const pulsoPassword = process.env.TEST_NATS_PULSO_PASSWORD;
const sofiaPassword = process.env.TEST_NATS_SOFIA_PASSWORD;
const auditPassword = process.env.TEST_NATS_AUDIT_PASSWORD;
const lumenPassword = process.env.TEST_NATS_LUMEN_PASSWORD;
const topologyPassword = process.env.TEST_NATS_TOPOLOGY_PASSWORD;
const enabled = Boolean(
  testUrl && channelPassword && pulsoPassword && sofiaPassword && auditPassword && lumenPassword && topologyPassword
);

describe.skipIf(!enabled)("NATS service ACLs", () => {
  let channel: NatsConnection;
  let pulso: NatsConnection;
  let sofia: NatsConnection;
  let audit: NatsConnection;
  let lumen: NatsConnection;
  let topology: NatsConnection;

  beforeAll(async () => {
    [channel, pulso, sofia, audit, lumen, topology] = await Promise.all([
      connect({
        servers: testUrl!,
        user: "channel",
        pass: channelPassword!,
        inboxPrefix: "_INBOX.channel",
        name: "channel-acl-integration-test",
        timeout: 5_000
      }),
      connect({
        servers: testUrl!,
        user: "pulso",
        pass: pulsoPassword!,
        inboxPrefix: "_INBOX.pulso",
        name: "pulso-acl-integration-test",
        timeout: 5_000
      }),
      connect({
        servers: testUrl!,
        user: "sofia",
        pass: sofiaPassword!,
        inboxPrefix: "_INBOX.sofia",
        name: "sofia-acl-integration-test",
        timeout: 5_000
      }),
      connect({
        servers: testUrl!,
        user: "audit",
        pass: auditPassword!,
        inboxPrefix: "_INBOX.audit",
        name: "audit-acl-integration-test",
        timeout: 5_000
      }),
      connect({
        servers: testUrl!,
        user: "lumen",
        pass: lumenPassword!,
        inboxPrefix: "_INBOX.lumen",
        name: "lumen-acl-integration-test",
        timeout: 5_000
      }),
      connect({
        servers: testUrl!,
        user: "topology",
        pass: topologyPassword!,
        inboxPrefix: "_INBOX.topology",
        name: "topology-acl-integration-test",
        timeout: 5_000
      })
    ]);
  });

  afterAll(async () => {
    await Promise.all(
      [channel, pulso, sofia, audit, lumen, topology].map(async (connection) => {
        if (!connection?.isClosed()) await connection.close();
      })
    );
  });

  it("rejects a subscription to another service inbox namespace", async () => {
    const subject = "_INBOX.sofia.>";
    const subscription = channel.subscribe(subject);
    await channel.flush();

    const closure = await within(subscription.closed, 2_000);
    expect(closure).toBeInstanceOf(PermissionViolationError);
    expect(closure).toMatchObject({
      name: "PermissionViolationError",
      operation: "subscription",
      subject
    });
  });

  it("rejects publishing another service event subject", async () => {
    await expectPublishDenied(channel, "hyperion.events.sofia.audit.event.record.v1", "acl-denied-channel-sofia-audit");
  });

  it("allows Channel to publish its durable audit contract", async () => {
    await expectPublishAllowed(
      channel,
      "hyperion.events.channel.audit.event.record.v1",
      `acl-allowed-channel-audit-${Date.now()}`
    );
  });

  it("allows Channel to publish both contracts during the explicit v1-to-v2 rollout", async () => {
    await expectPublishAllowed(
      channel,
      "hyperion.events.channel.inbound.received.v1",
      `acl-allowed-channel-v1-${Date.now()}`
    );
    await expectPublishAllowed(
      channel,
      "hyperion.events.channel.inbound.received.v2",
      `acl-allowed-channel-v2-${Date.now()}`
    );
  });

  it("allows PULSO to pull and ACK Channel delivery while denying topology's direct pull API", async () => {
    const subject = "hyperion.events.channel.delivery.updated.v1";
    const messageId = `acl-allowed-channel-delivery-${Date.now()}`;
    await expectPublishAllowed(channel, subject, messageId);

    await expectRequestPublishDenied(topology, "$JS.API.CONSUMER.MSG.NEXT.HYPERION_EVENTS.pulso_channel_delivery_v1");

    const consumer = await jetstream(pulso, { timeout: 2_000 }).consumers.get(
      "HYPERION_EVENTS",
      "pulso_channel_delivery_v1"
    );
    const message = await consumer.next({ expires: 2_000 });
    expect(message).not.toBeNull();
    expect(message?.subject).toBe(subject);
    await expect(message!.ackAck()).resolves.toBe(true);
  });

  it("allows PULSO to publish the delivery DLQ but not the Channel-owned delivery event", async () => {
    await expectPublishAllowed(
      pulso,
      "hyperion.dlq.channel.delivery.updated.v1",
      `acl-allowed-pulso-channel-delivery-dlq-${Date.now()}`
    );
    await expectPublishDenied(
      pulso,
      "hyperion.events.channel.delivery.updated.v1",
      "acl-denied-pulso-channel-delivery"
    );
    await expectPublishDenied(channel, "hyperion.dlq.channel.delivery.updated.v1", "acl-denied-channel-delivery-dlq");
  });

  it("rejects topology publishing a domain event", async () => {
    await expectPublishDenied(topology, "hyperion.events.channel.inbound.received.v1", "acl-denied-topology-domain");
  });

  it("rejects PULSO publishing a Channel-owned event", async () => {
    await expectPublishDenied(pulso, "hyperion.events.channel.inbound.received.v1", "acl-denied-pulso-channel");
  });

  it("allows PULSO to publish both message contracts during the explicit v1-to-v2 rollout", async () => {
    await expectPublishAllowed(
      pulso,
      "hyperion.events.pulso.message.received.v1",
      `acl-allowed-pulso-v1-${Date.now()}`
    );
    await expectPublishAllowed(
      pulso,
      "hyperion.events.pulso.message.received.v2",
      `acl-allowed-pulso-v2-${Date.now()}`
    );
    await expectPublishAllowed(
      pulso,
      "hyperion.events.pulso.audit.event.record.v1",
      `acl-allowed-pulso-audit-${Date.now()}`
    );
  });

  it("allows each Audit producer only its source-scoped subject", async () => {
    await expectPublishAllowed(
      sofia,
      "hyperion.events.sofia.audit.event.record.v1",
      `acl-allowed-sofia-audit-${Date.now()}`
    );
    await expectPublishAllowed(
      lumen,
      "hyperion.events.lumen.audit.event.record.v1",
      `acl-allowed-lumen-audit-${Date.now()}`
    );

    await expectPublishDenied(sofia, "hyperion.events.lumen.audit.event.record.v1", "acl-denied-sofia-as-lumen");
    await expectPublishDenied(lumen, "hyperion.events.sofia.audit.event.record.v1", "acl-denied-lumen-as-sofia");
    await expectPublishDenied(pulso, "hyperion.events.sofia.audit.event.record.v1", "acl-denied-pulso-as-sofia");
    await expectPublishDenied(channel, "hyperion.events.pulso.audit.event.record.v1", "acl-denied-channel-as-pulso");
  });

  it("rejects the removed ambiguous Audit subject for every runtime identity", async () => {
    for (const [connection, identity] of [
      [sofia, "sofia"],
      [lumen, "lumen"],
      [audit, "audit"]
    ] as const) {
      await expectPublishDenied(connection, "hyperion.events.audit.event.record.v1", `acl-denied-${identity}-legacy`);
    }
  });
});

async function expectPublishAllowed(connection: NatsConnection, subject: string, messageId: string): Promise<void> {
  const client = jetstream(connection, { timeout: 2_000 });
  await expect(
    client.publish(subject, new Uint8Array([1]), {
      msgID: messageId,
      expect: { streamName: "HYPERION_EVENTS" }
    })
  ).resolves.toMatchObject({ stream: "HYPERION_EVENTS" });
}

async function expectPublishDenied(connection: NatsConnection, subject: string, messageId: string): Promise<void> {
  const client = jetstream(connection, { timeout: 2_000 });
  let rejection: unknown;
  try {
    await client.publish(subject, new Uint8Array([1]), {
      msgID: messageId,
      expect: { streamName: "HYPERION_EVENTS" }
    });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(RequestError);
  const permissionViolation = (rejection as Error | undefined)?.cause;
  expect(permissionViolation).toBeInstanceOf(PermissionViolationError);
  expect(permissionViolation).toMatchObject({
    name: "PermissionViolationError",
    operation: "publish",
    subject
  });
}

async function expectRequestPublishDenied(connection: NatsConnection, subject: string): Promise<void> {
  let rejection: unknown;
  try {
    await connection.request(subject, new TextEncoder().encode('{"batch":1,"expires":1000000000}'), {
      timeout: 2_000
    });
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(RequestError);
  const permissionViolation = (rejection as Error | undefined)?.cause;
  expect(permissionViolation).toBeInstanceOf(PermissionViolationError);
  expect(permissionViolation).toMatchObject({
    name: "PermissionViolationError",
    operation: "publish",
    subject
  });
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("acl_assertion_timeout")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
