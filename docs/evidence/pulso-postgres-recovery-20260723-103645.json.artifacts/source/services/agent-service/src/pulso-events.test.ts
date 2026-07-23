import type { DatabaseClient } from "@hyperion/database";
import { createService } from "@hyperion/service-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { PulsoEventPosition } from "./pulso-position-client.js";
import {
  consumePulsoMessageEvent,
  pulsoMessageEventSchema,
  registerPulsoEventRoutes,
  type LegacyPulsoMessageEvent,
  type OrderedPulsoMessageEvent
} from "./pulso-events.js";

const POSITION: PulsoEventPosition = {
  streamId: "00000000-0000-4000-8000-000000000206",
  streamSequence: 1,
  sourceStreamId: "00000000-0000-4000-8000-000000000204",
  sourceStreamSequence: 8
};

const EVENT: OrderedPulsoMessageEvent = {
  id: "00000000-0000-4000-8000-000000000201",
  type: "pulso.message.received.v2",
  version: 2,
  occurredAt: "2026-07-13T12:00:00.000Z",
  tenantId: "00000000-0000-4000-8000-000000000202",
  streamId: POSITION.streamId,
  streamSequence: POSITION.streamSequence,
  payload: {
    inboundEventId: "00000000-0000-4000-8000-000000000203",
    threadBindingId: POSITION.sourceStreamId,
    patientId: "00000000-0000-4000-8000-000000000205",
    conversationId: POSITION.streamId,
    messageId: "00000000-0000-4000-8000-000000000207",
    occurredAt: "2026-07-13T12:00:00.000Z",
    sourceStreamId: POSITION.sourceStreamId,
    sourceStreamSequence: POSITION.sourceStreamSequence
  }
};

const LEGACY_EVENT: LegacyPulsoMessageEvent = {
  id: EVENT.id,
  type: "pulso.message.received.v1",
  version: 1,
  occurredAt: EVENT.occurredAt,
  tenantId: EVENT.tenantId,
  payload: {
    inboundEventId: EVENT.payload.inboundEventId,
    threadBindingId: EVENT.payload.threadBindingId,
    patientId: EVENT.payload.patientId,
    conversationId: EVENT.payload.conversationId,
    messageId: EVENT.payload.messageId,
    occurredAt: EVENT.payload.occurredAt
  }
};

describe("consumePulsoMessageEvent", () => {
  it("creates the SOFIA job, audit outbox and checkpoint in one transaction", async () => {
    const jobId = "00000000-0000-4000-8000-000000000208";
    const db = acceptedDatabase(jobId);

    await expect(consumePulsoMessageEvent(db.client, EVENT)).resolves.toEqual({ status: "accepted", jobId });

    expect(db.transactions).toBe(1);
    expect(db.calls.some((call) => call.sql.includes("insert into agent_runtime.inbox_events"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("insert into agent_runtime.jobs"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("'sofia.audit.event.record.v1'"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("update agent_runtime.pulso_stream_positions"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("pulso_iris.") || call.sql.includes("channel_runtime."))).toBe(
      false
    );
  });

  it("replays the stored result without creating a second job", async () => {
    const jobId = "00000000-0000-4000-8000-000000000208";
    const accepted = acceptedDatabase(jobId);
    await consumePulsoMessageEvent(accepted.client, EVENT);
    const payloadHash = insertedInboxHash(accepted.calls);
    const replay = scriptedDatabase([[activeSofiaSnapshot()], [existingInbox(payloadHash, jobId)]]);

    await expect(consumePulsoMessageEvent(replay.client, EVENT)).resolves.toEqual({ status: "duplicate", jobId });
    expect(replay.calls).toHaveLength(2);
  });

  it("normalizes an owner-resolved v1 replay to the same v2 contract", async () => {
    const jobId = "00000000-0000-4000-8000-000000000208";
    const accepted = acceptedDatabase(jobId);
    await consumePulsoMessageEvent(accepted.client, EVENT);
    const payloadHash = insertedInboxHash(accepted.calls);
    const replay = scriptedDatabase([[activeSofiaSnapshot()], [existingInbox(payloadHash, jobId)]]);

    await expect(consumePulsoMessageEvent(replay.client, LEGACY_EVENT, POSITION)).resolves.toEqual({
      status: "duplicate",
      jobId
    });
    expect(replay.calls).toHaveLength(2);
  });

  it("fails closed when v1 has no owner-resolved position", async () => {
    const db = scriptedDatabase([[activeSofiaSnapshot()]]);
    await expect(consumePulsoMessageEvent(db.client, LEGACY_EVENT)).rejects.toThrow("owner-resolved stream position");
    expect(db.transactions).toBe(0);
  });

  it("rejects a source stream that does not own the declared thread binding", async () => {
    const conflicting = {
      ...EVENT,
      payload: {
        ...EVENT.payload,
        sourceStreamId: "00000000-0000-4000-8000-000000000299"
      }
    };

    expect(pulsoMessageEventSchema.safeParse(conflicting).success).toBe(false);
  });

  it("reports a gap before inserting inbox or job state", async () => {
    const gapEvent: OrderedPulsoMessageEvent = {
      ...EVENT,
      id: "00000000-0000-4000-8000-000000000211",
      streamSequence: 2
    };
    const db = scriptedDatabase([[activeSofiaSnapshot()], [], [], [], [], [{ lastSequence: 0 }]]);

    await expect(consumePulsoMessageEvent(db.client, gapEvent)).resolves.toEqual({
      status: "gap",
      streamId: POSITION.streamId,
      expectedSequence: 1,
      receivedSequence: 2
    });
    expect(db.calls.some((call) => call.sql.includes("insert into agent_runtime.inbox_events"))).toBe(false);
  });

  it("rejects event-id reuse with another envelope or stream position", async () => {
    const db = scriptedDatabase([
      [activeSofiaSnapshot()],
      [existingInbox("f".repeat(64), "00000000-0000-4000-8000-000000000208")]
    ]);
    await expect(consumePulsoMessageEvent(db.client, EVENT)).resolves.toEqual({ status: "conflict" });
    expect(db.calls).toHaveLength(2);
  });

  it("fails closed when the local Access→SOFIA snapshot is missing", async () => {
    const db = scriptedDatabase([[]]);
    await expect(consumePulsoMessageEvent(db.client, EVENT)).rejects.toThrow(
      "Tenant snapshot not found; bootstrap required"
    );
    expect(db.transactions).toBe(0);
  });
});

describe("PULSO to SOFIA workload identity", () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.PULSO_TO_SOFIA_TOKEN;
    delete process.env.PULSO_MESSAGE_V1_COMPATIBILITY;
  });

  it("rejects impersonation before starting a database transaction", async () => {
    process.env.DATABASE_URL = "postgresql://unused/agent-events-test";
    process.env.PULSO_TO_SOFIA_TOKEN = "pulso-to-sofia-controlled-token";
    const db = scriptedDatabase([]);
    const handle = await createService({
      serviceName: "agent-service",
      databaseRequired: true,
      createDatabase: () => db.client,
      registerRoutes: registerPulsoEventRoutes
    });
    try {
      const response = await handle.app.inject({
        method: "POST",
        url: "/internal/v1/events/pulso-message-received",
        headers: {
          authorization: "Bearer pulso-to-sofia-controlled-token",
          "x-hyperion-caller": "lumen-service"
        },
        payload: EVENT
      });

      expect(response.statusCode).toBe(403);
      expect(db.transactions).toBe(0);
    } finally {
      await handle.app.close();
    }
  });
});

function acceptedDatabase(jobId: string) {
  return scriptedDatabase([
    [activeSofiaSnapshot()],
    [],
    [],
    [],
    [],
    [{ lastSequence: 0 }],
    [],
    [],
    [{ id: jobId }],
    [],
    [],
    [{}]
  ]);
}

function activeSofiaSnapshot() {
  return { status: "active" as const, sourceVersion: "1" };
}

function existingInbox(payloadHash: string, jobId: string) {
  return {
    payloadHash,
    streamId: POSITION.streamId,
    streamSequence: POSITION.streamSequence,
    sourceStreamId: POSITION.sourceStreamId,
    sourceStreamSequence: POSITION.sourceStreamSequence,
    result: { jobId }
  };
}

function insertedInboxHash(calls: Array<{ sql: string; params?: unknown[] }>): string {
  const insertion = calls.find((call) => call.sql.includes("insert into agent_runtime.inbox_events"));
  return String(insertion?.params?.[3]);
}

function scriptedDatabase(results: unknown[][]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let transactions = 0;
  const client: DatabaseClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      const rows = results.shift() ?? [];
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as never;
    },
    async transaction(work) {
      transactions += 1;
      return work(client as never);
    },
    async close() {}
  };
  return {
    calls,
    client,
    get transactions() {
      return transactions;
    }
  };
}
