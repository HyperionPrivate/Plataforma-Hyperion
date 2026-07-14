import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelInboundEventSchema,
  registerChannelInboundEventRoutesWithCompatibility
} from "./channel-inbound-events.js";

const INTERNAL_TOKEN = "test-internal-token-with-enough-entropy";
const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const INBOUND_EVENT_ID = "30000000-0000-4000-8000-000000000001";
const THREAD_BINDING_ID = "40000000-0000-4000-8000-000000000001";

const inboundEvent = {
  id: EVENT_ID,
  type: "channel.inbound.received.v2" as const,
  version: 2 as const,
  occurredAt: "2026-07-13T16:30:00.000Z",
  tenantId: TENANT_ID,
  streamId: THREAD_BINDING_ID,
  streamSequence: 1,
  payload: {
    inboundEventId: INBOUND_EVENT_ID,
    threadBindingId: THREAD_BINDING_ID,
    provider: "whatsapp_web_test" as const,
    externalThreadId: "573001234567@s.whatsapp.net",
    externalMessageId: "message-001",
    phoneHash: "a".repeat(64),
    phoneMasked: "********4567",
    body: "Necesito una cita",
    receivedAt: "2026-07-13T16:29:59.000Z"
  }
};

describe("durable Channel -> PULSO event consumer", () => {
  let app: ReturnType<typeof Fastify>;
  let db: TransactionalFakeDatabase;
  let channelThreads: {
    getThread: ReturnType<typeof vi.fn>;
    bindThread: ReturnType<typeof vi.fn>;
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  };

  beforeEach(async () => {
    db = new TransactionalFakeDatabase();
    app = Fastify();
    vi.clearAllMocks();
    channelThreads = {
      getThread: vi.fn(),
      bindThread: vi.fn(async () => undefined)
    };
    await registerChannelInboundEventRoutesWithCompatibility(
      app,
      {
        config: {
          serviceName: "pulso-iris-service",
          environment: "test",
          host: "127.0.0.1",
          port: 8088,
          serviceVersion: "test",
          corsAllowedOrigins: []
        },
        db: db as never,
        logger: logger as never
      },
      { allowLegacyV1: false, channelCredential: INTERNAL_TOKEN, channelThreads }
    );
  });

  afterEach(async () => {
    await app.close();
  });

  it("requires the internal bearer token before opening a transaction", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/internal/v1/events/channel-inbound",
      payload: inboundEvent
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/internal/v1/events/channel-inbound",
      headers: { authorization: "Bearer incorrect" },
      payload: inboundEvent
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(db.transactionCalls).toBe(0);
  });

  it("accepts a new event and commits inbox, local projections and outbox together", async () => {
    const response = await send(inboundEvent);

    expect(response.statusCode).toBe(202);
    expect(response.json().data).toMatchObject({
      eventId: EVENT_ID,
      outboxEventType: "pulso.message.received.v2"
    });
    expect(db.state.inbox).toHaveLength(1);
    expect(db.state.threads).toHaveLength(1);
    expect(db.state.patients).toHaveLength(1);
    expect(db.state.conversations).toHaveLength(1);
    expect(db.state.messages).toHaveLength(1);
    expect(db.state.outbox).toHaveLength(1);
    expect(db.state.inbox[0]?.result).toEqual(response.json().data);
    expect(db.state.conversations[0]?.sofiaStatus).toBe("queued");
    expect(db.state.outbox[0]?.payload).toMatchObject({
      inboundEventId: INBOUND_EVENT_ID,
      threadBindingId: THREAD_BINDING_ID,
      patientId: response.json().data.patientId,
      conversationId: response.json().data.conversationId,
      messageId: response.json().data.messageId,
      occurredAt: inboundEvent.occurredAt
    });
    expect(db.state.threads[0]?.lastInboundSequence).toBe(1);
    expect(channelThreads.bindThread).toHaveBeenCalledWith(
      TENANT_ID,
      THREAD_BINDING_ID,
      expect.objectContaining({
        patientId: response.json().data.patientId,
        conversationId: response.json().data.conversationId,
        externalMessageId: "message-001",
        messageId: response.json().data.messageId
      })
    );
  });

  it("binds the Channel-owned thread after a successful projection and again on replay", async () => {
    const accepted = await send(inboundEvent);
    const replayed = await send(inboundEvent);

    expect(accepted.statusCode).toBe(202);
    expect(replayed.statusCode).toBe(200);
    expect(channelThreads.bindThread).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Channel bind is unavailable after projection", async () => {
    channelThreads.bindThread.mockRejectedValueOnce(new Error("thread_binding_not_found"));
    const response = await send(inboundEvent);

    expect(response.statusCode).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      "failed to bind Channel-owned thread after inbound projection",
      expect.objectContaining({
        tenantId: TENANT_ID,
        threadBindingId: THREAD_BINDING_ID
      })
    );
  });

  it("does not contact Channel upstream when the tenant bind credential is missing", async () => {
    await app.close();
    app = Fastify();
    await registerChannelInboundEventRoutesWithCompatibility(
      app,
      {
        config: {
          serviceName: "pulso-iris-service",
          environment: "test",
          host: "127.0.0.1",
          port: 8088,
          serviceVersion: "test",
          corsAllowedOrigins: []
        },
        db: db as never,
        logger: logger as never
      },
      { allowLegacyV1: false, channelCredential: INTERNAL_TOKEN }
    );

    const response = await send(inboundEvent);
    expect(response.statusCode).toBe(500);
    expect(channelThreads.bindThread).not.toHaveBeenCalled();
  });

  it("accepts PostgreSQL RFC3339 offsets and canonicalizes them to UTC before hashing", async () => {
    const postgresPayload = {
      ...inboundEvent,
      occurredAt: "2026-07-13T16:30:00+00:00",
      payload: {
        ...inboundEvent.payload,
        receivedAt: "2026-07-13T16:29:59+00:00"
      }
    };

    const parsed = channelInboundEventSchema.parse(postgresPayload);
    const response = await send(postgresPayload);

    expect(parsed.occurredAt).toBe("2026-07-13T16:30:00.000Z");
    expect(parsed.payload.receivedAt).toBe("2026-07-13T16:29:59.000Z");
    expect(response.statusCode).toBe(202);
    expect(db.state.outbox[0]?.payload.occurredAt).toBe("2026-07-13T16:30:00.000Z");
  });

  it("returns the stored result for a replay without duplicating projections", async () => {
    const accepted = await send(inboundEvent);
    const replayed = await send(inboundEvent);

    expect(accepted.statusCode).toBe(202);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().data).toEqual(accepted.json().data);
    expect(db.state.inbox).toHaveLength(1);
    expect(db.state.messages).toHaveLength(1);
    expect(db.state.outbox).toHaveLength(1);
  });

  it("replays a historical v1 result while every new outbox write remains v2", async () => {
    const accepted = await send(inboundEvent);
    const historicalResult = {
      ...accepted.json().data,
      outboxEventType: "pulso.message.received.v1"
    };
    db.state.inbox[0]!.result = historicalResult;

    const replayed = await send(inboundEvent);

    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().data).toEqual(historicalResult);
    expect(db.state.outbox).toHaveLength(1);
    expect(db.state.outbox[0]?.eventType).toBe("pulso.message.received.v2");
  });

  it("rolls back gaps, then advances only contiguous positions and rejects sequence reuse", async () => {
    const second = {
      ...inboundEvent,
      id: "10000000-0000-4000-8000-000000000002",
      streamSequence: 2,
      payload: {
        ...inboundEvent.payload,
        inboundEventId: "30000000-0000-4000-8000-000000000002",
        externalMessageId: "message-002",
        body: "Segundo mensaje"
      }
    };
    const third = {
      ...second,
      id: "10000000-0000-4000-8000-000000000003",
      streamSequence: 3,
      payload: {
        ...second.payload,
        inboundEventId: "30000000-0000-4000-8000-000000000003",
        externalMessageId: "message-003",
        body: "Tercer mensaje"
      }
    };

    const firstGap = await send(second);
    expect(firstGap.statusCode).toBe(409);
    expect(firstGap.json().data).toMatchObject({ expectedSequence: 1, receivedSequence: 2 });
    expect(db.state.inbox).toHaveLength(0);
    expect(db.state.threads).toHaveLength(0);

    expect((await send(inboundEvent)).statusCode).toBe(202);
    const laterGap = await send(third);
    expect(laterGap.statusCode).toBe(409);
    expect(laterGap.json().data).toMatchObject({ expectedSequence: 2, receivedSequence: 3 });
    expect(db.state.threads[0]?.lastInboundSequence).toBe(1);

    expect((await send(second)).statusCode).toBe(202);
    expect(db.state.threads[0]?.lastInboundSequence).toBe(2);

    const reused = await send({
      ...second,
      id: "10000000-0000-4000-8000-000000000004",
      payload: {
        ...second.payload,
        inboundEventId: "30000000-0000-4000-8000-000000000004",
        externalMessageId: "message-004"
      }
    });
    expect(reused.statusCode).toBe(409);
    expect(db.state.inbox).toHaveLength(2);
    expect(db.state.messages).toHaveLength(2);
  });

  it("requires the ordered stream id to match the payload thread binding", async () => {
    const response = await send({
      ...inboundEvent,
      streamId: "40000000-0000-4000-8000-000000000099"
    });

    expect(response.statusCode).toBe(400);
    expect(db.transactionCalls).toBe(0);
  });

  it("keeps v1 strict and disabled by default, then accepts it only in an explicit audited rollout window", async () => {
    const legacy = {
      id: inboundEvent.id,
      type: "channel.inbound.received.v1" as const,
      version: 1 as const,
      occurredAt: inboundEvent.occurredAt,
      tenantId: inboundEvent.tenantId,
      payload: inboundEvent.payload
    };
    const disabled = await send(legacy);
    expect(disabled.statusCode).toBe(400);
    expect(db.transactionCalls).toBe(0);

    await app.close();
    app = Fastify();
    await registerChannelInboundEventRoutesWithCompatibility(
      app,
      {
        config: {
          serviceName: "pulso-iris-service",
          environment: "test",
          host: "127.0.0.1",
          port: 8088,
          serviceVersion: "test",
          corsAllowedOrigins: []
        },
        db: db as never,
        logger: logger as never
      },
      {
        allowLegacyV1: true,
        channelCredential: INTERNAL_TOKEN,
        channelThreads,
        resolveLegacyPosition: (event) => db.resolveChannelPosition(event.payload.inboundEventId)
      }
    );

    db.setChannelPosition(INBOUND_EVENT_ID, THREAD_BINDING_ID, 1);
    const accepted = await send(legacy);
    expect(accepted.statusCode).toBe(202);
    expect(db.state.threads[0]?.lastInboundSequence).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("legacy Channel event accepted"),
      expect.objectContaining({ eventId: legacy.id, compatibilityMode: "channel_inbound_v1" })
    );

    const orderedSecond = {
      ...inboundEvent,
      id: "10000000-0000-4000-8000-000000000012",
      streamSequence: 2,
      payload: {
        ...inboundEvent.payload,
        inboundEventId: "30000000-0000-4000-8000-000000000012",
        externalMessageId: "message-012"
      }
    };
    expect((await send(orderedSecond)).statusCode).toBe(202);

    const rolledBackV1 = {
      id: "10000000-0000-4000-8000-000000000013",
      type: "channel.inbound.received.v1" as const,
      version: 1 as const,
      occurredAt: inboundEvent.occurredAt,
      tenantId: inboundEvent.tenantId,
      payload: {
        ...inboundEvent.payload,
        inboundEventId: "30000000-0000-4000-8000-000000000013",
        externalMessageId: "message-013"
      }
    };
    db.setChannelPosition(rolledBackV1.payload.inboundEventId, THREAD_BINDING_ID, 3);
    expect((await send(rolledBackV1)).statusCode).toBe(202);
    expect(db.state.threads[0]?.lastInboundSequence).toBe(3);
  });

  it("retries a v1 successor delivered before an earlier v2 event, then advances 1 to 2", async () => {
    await app.close();
    app = Fastify();
    await registerChannelInboundEventRoutesWithCompatibility(
      app,
      {
        config: {
          serviceName: "pulso-iris-service",
          environment: "test",
          host: "127.0.0.1",
          port: 8088,
          serviceVersion: "test",
          corsAllowedOrigins: []
        },
        db: db as never,
        logger: logger as never
      },
      {
        allowLegacyV1: true,
        channelCredential: INTERNAL_TOKEN,
        channelThreads,
        resolveLegacyPosition: (event) => db.resolveChannelPosition(event.payload.inboundEventId)
      }
    );

    const legacySecond = {
      id: "10000000-0000-4000-8000-000000000022",
      type: "channel.inbound.received.v1" as const,
      version: 1 as const,
      occurredAt: "2026-07-13T16:31:00.000Z",
      tenantId: TENANT_ID,
      payload: {
        ...inboundEvent.payload,
        inboundEventId: "30000000-0000-4000-8000-000000000022",
        externalMessageId: "message-022",
        body: "Segundo mensaje legado",
        receivedAt: "2026-07-13T16:30:59.000Z"
      }
    };
    db.setChannelPosition(legacySecond.payload.inboundEventId, THREAD_BINDING_ID, 2);

    const premature = await send(legacySecond);
    expect(premature.statusCode).toBe(409);
    expect(premature.json().data).toMatchObject({ expectedSequence: 1, receivedSequence: 2 });
    expect(db.state.inbox).toHaveLength(0);
    expect(db.state.messages).toHaveLength(0);

    expect((await send(inboundEvent)).statusCode).toBe(202);
    expect((await send(legacySecond)).statusCode).toBe(202);
    expect(db.state.threads[0]?.lastInboundSequence).toBe(2);
    expect(db.state.messages).toHaveLength(2);
  });

  it("rejects the same event id with a different canonical payload", async () => {
    await send(inboundEvent);
    const conflict = await send({
      ...inboundEvent,
      payload: { ...inboundEvent.payload, body: "Contenido diferente" }
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().data).toMatchObject({ eventId: EVENT_ID });
    expect(db.state.messages).toHaveLength(1);
    expect(db.state.outbox).toHaveLength(1);
  });

  it.each([
    {
      label: "thread binding id",
      streamId: "40000000-0000-4000-8000-000000000099",
      phoneHash: inboundEvent.payload.phoneHash
    },
    {
      label: "phone identity",
      streamId: THREAD_BINDING_ID,
      phoneHash: "b".repeat(64)
    }
  ])("fails closed when the existing external thread conflicts by $label", async ({ streamId, phoneHash }) => {
    expect((await send(inboundEvent)).statusCode).toBe(202);

    const conflict = await send({
      ...inboundEvent,
      id: "10000000-0000-4000-8000-000000000099",
      streamId,
      streamSequence: streamId === THREAD_BINDING_ID ? 2 : 1,
      payload: {
        ...inboundEvent.payload,
        inboundEventId: "30000000-0000-4000-8000-000000000099",
        threadBindingId: streamId,
        externalMessageId: "message-conflicting-thread",
        phoneHash
      }
    });

    expect(conflict.statusCode).toBe(409);
    expect(db.state.threads).toHaveLength(1);
    expect(db.state.threads[0]).toMatchObject({
      id: THREAD_BINDING_ID,
      phoneHash: inboundEvent.payload.phoneHash,
      lastInboundSequence: 1
    });
    expect(db.state.messages).toHaveLength(1);
  });

  it("rolls back the inbox and every projection when the outbox write fails", async () => {
    db.failWhenSqlIncludes = "insert into pulso_iris.outbox_events";

    const failed = await send(inboundEvent);

    expect(failed.statusCode).toBe(500);
    expect(db.state.inbox).toHaveLength(0);
    expect(db.state.threads).toHaveLength(0);
    expect(db.state.patients).toHaveLength(0);
    expect(db.state.conversations).toHaveLength(0);
    expect(db.state.messages).toHaveLength(0);
    expect(db.state.outbox).toHaveLength(0);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(inboundEvent.payload.body);

    db.failWhenSqlIncludes = undefined;
    const retried = await send(inboundEvent);
    expect(retried.statusCode).toBe(202);
    expect(db.state.inbox).toHaveLength(1);
  });

  it("never issues SQL against the Channel-owned schema", async () => {
    const response = await send(inboundEvent);

    expect(response.statusCode).toBe(202);
    expect(db.executedSql.length).toBeGreaterThan(0);
    expect(db.executedSql.join("\n").toLowerCase()).not.toContain("channel_runtime");
    expect(db.executedSql.every((sql) => !sql.includes("platform."))).toBe(true);
  });

  async function send(payload: unknown) {
    return app.inject({
      method: "POST",
      url: "/internal/v1/events/channel-inbound",
      headers: {
        authorization: `Bearer ${INTERNAL_TOKEN}`,
        "x-hyperion-caller": "whatsapp-channel-service"
      },
      payload
    });
  }
});

interface FakeInboxRow {
  eventId: string;
  tenantId: string;
  payloadHash: string;
  streamId: string;
  streamSequence: number | null;
  result: unknown;
}

interface FakeThreadRow {
  id: string;
  tenantId: string;
  provider: string;
  externalThreadId: string;
  phoneHash: string;
  phoneMasked: string;
  patientId: string | null;
  conversationId: string | null;
  lastInboundSequence: number;
}

interface FakePatientRow {
  id: string;
  tenantId: string;
  phoneHash: string;
  phoneMasked: string;
}

interface FakeConversationRow {
  id: string;
  tenantId: string;
  patientId: string;
  provider: string;
  status: string;
  sofiaStatus: string;
}

interface FakeMessageRow {
  id: string;
  tenantId: string;
  conversationId: string;
  provider: string;
  externalMessageId: string;
  body: string;
}

interface FakeOutboxRow {
  tenantId: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

interface FakeChannelPosition {
  tenantId: string;
  eventId: string;
  streamId: string;
  streamSequence: number;
}

interface FakeState {
  inbox: FakeInboxRow[];
  threads: FakeThreadRow[];
  patients: FakePatientRow[];
  conversations: FakeConversationRow[];
  messages: FakeMessageRow[];
  outbox: FakeOutboxRow[];
  channelPositions: FakeChannelPosition[];
}

class TransactionalFakeDatabase {
  state: FakeState = emptyState();
  executedSql: string[] = [];
  transactionCalls = 0;
  failWhenSqlIncludes: string | undefined;
  private nextId = 1;

  setChannelPosition(eventId: string, streamId: string, streamSequence: number): void {
    this.state.channelPositions.push({ tenantId: TENANT_ID, eventId, streamId, streamSequence });
  }

  async resolveChannelPosition(eventId: string): Promise<{ streamId: string; streamSequence: number }> {
    const position = this.state.channelPositions.find((row) => row.tenantId === TENANT_ID && row.eventId === eventId);
    if (!position) throw new Error("Channel position is unavailable");
    return { streamId: position.streamId, streamSequence: position.streamSequence };
  }

  async transaction<T>(work: (transaction: { query: TransactionalFakeDatabase["query"] }) => Promise<T>) {
    this.transactionCalls += 1;
    const draft = structuredClone(this.state);
    const result = await work({ query: (sql, params) => this.query(sql, params, draft) });
    this.state = draft;
    return result;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sqlValue: string,
    params: unknown[] = [],
    state = this.state
  ): Promise<{ rows: T[] }> {
    const sql = normalizeSql(sqlValue);
    this.executedSql.push(sql);
    if (this.failWhenSqlIncludes && sql.includes(this.failWhenSqlIncludes)) {
      throw new Error("injected transactional failure");
    }

    if (sql.startsWith('select position.stream_id as "streamid"')) {
      const position = state.channelPositions.find(
        (row) => row.tenantId === stringParam(params, 0) && row.eventId === stringParam(params, 1)
      );
      return rows<T>(position ? [{ streamId: position.streamId, streamSequence: position.streamSequence }] : []);
    }

    if (sql.startsWith("insert into pulso_iris.inbox_events")) {
      const eventId = stringParam(params, 0);
      if (state.inbox.some((row) => row.eventId === eventId)) return rows<T>([]);
      const streamId = stringParam(params, 6);
      const streamSequence = nullableNumberParam(params, 7);
      if (
        streamSequence !== null &&
        state.inbox.some(
          (row) =>
            row.tenantId === stringParam(params, 1) &&
            row.streamId === streamId &&
            row.streamSequence === streamSequence
        )
      ) {
        const error = new Error("duplicate stream position") as Error & { code: string; constraint: string };
        error.code = "23505";
        error.constraint = "uq_pulso_channel_inbox_stream_sequence";
        throw error;
      }
      state.inbox.push({
        eventId,
        tenantId: stringParam(params, 1),
        payloadHash: stringParam(params, 4),
        streamId,
        streamSequence,
        result: null
      });
      return rows<T>([{ eventId }]);
    }

    if (sql.startsWith('select payload_hash as "payloadhash"')) {
      const inbox = state.inbox.find((row) => row.eventId === stringParam(params, 0));
      return rows<T>(inbox ? [{ payloadHash: inbox.payloadHash, result: inbox.result }] : []);
    }

    if (sql.startsWith("insert into pulso_iris.channel_threads")) {
      const tenantId = stringParam(params, 1);
      const provider = stringParam(params, 2);
      const externalThreadId = stringParam(params, 3);
      let thread = state.threads.find(
        (row) => row.tenantId === tenantId && row.provider === provider && row.externalThreadId === externalThreadId
      );
      if (!thread) {
        thread = {
          id: stringParam(params, 0),
          tenantId,
          provider,
          externalThreadId,
          phoneHash: stringParam(params, 4),
          phoneMasked: stringParam(params, 5),
          patientId: null,
          conversationId: null,
          lastInboundSequence: 0
        };
        state.threads.push(thread);
      } else {
        if (thread.id !== stringParam(params, 0) || thread.phoneHash !== stringParam(params, 4)) {
          return rows<T>([]);
        }
        thread.phoneHash = stringParam(params, 4);
        thread.phoneMasked = stringParam(params, 5);
      }
      return rows<T>([
        {
          id: thread.id,
          patientId: thread.patientId,
          conversationId: thread.conversationId,
          lastInboundSequence: thread.lastInboundSequence
        }
      ]);
    }

    if (sql.startsWith("insert into pulso_iris.administrative_patients")) {
      const tenantId = stringParam(params, 0);
      const phoneHash = stringParam(params, 1);
      let patient = state.patients.find((row) => row.tenantId === tenantId && row.phoneHash === phoneHash);
      if (!patient) {
        patient = {
          id: this.uuid(),
          tenantId,
          phoneHash,
          phoneMasked: stringParam(params, 2)
        };
        state.patients.push(patient);
      } else {
        patient.phoneMasked = stringParam(params, 2);
      }
      return rows<T>([{ id: patient.id }]);
    }

    if (sql.startsWith("select id from pulso_iris.conversations")) {
      const tenantId = stringParam(params, 0);
      const conversation = sql.includes("id = $2::uuid")
        ? state.conversations.find(
            (row) => row.tenantId === tenantId && row.id === stringParam(params, 1) && isActive(row)
          )
        : state.conversations.find(
            (row) =>
              row.tenantId === tenantId &&
              row.patientId === stringParam(params, 1) &&
              row.provider === stringParam(params, 2) &&
              isActive(row)
          );
      return rows<T>(conversation ? [{ id: conversation.id }] : []);
    }

    if (sql.startsWith("insert into pulso_iris.conversations")) {
      const conversation: FakeConversationRow = {
        id: this.uuid(),
        tenantId: stringParam(params, 0),
        patientId: stringParam(params, 1),
        provider: stringParam(params, 2),
        status: "active",
        sofiaStatus: "queued"
      };
      state.conversations.push(conversation);
      return rows<T>([{ id: conversation.id }]);
    }

    if (sql.startsWith("insert into pulso_iris.messages")) {
      const tenantId = stringParam(params, 0);
      const provider = stringParam(params, 3);
      const externalMessageId = stringParam(params, 4);
      if (
        state.messages.some(
          (row) => row.tenantId === tenantId && row.provider === provider && row.externalMessageId === externalMessageId
        )
      ) {
        return rows<T>([]);
      }
      const message: FakeMessageRow = {
        id: this.uuid(),
        tenantId,
        conversationId: stringParam(params, 1),
        body: stringParam(params, 2),
        provider,
        externalMessageId
      };
      state.messages.push(message);
      return rows<T>([{ id: message.id, conversationId: message.conversationId }]);
    }

    if (sql.startsWith('select id, conversation_id as "conversationid"')) {
      const message = state.messages.find(
        (row) =>
          row.tenantId === stringParam(params, 0) &&
          row.provider === stringParam(params, 1) &&
          row.externalMessageId === stringParam(params, 2)
      );
      return rows<T>(message ? [{ id: message.id, conversationId: message.conversationId }] : []);
    }

    if (sql.startsWith("update pulso_iris.channel_threads")) {
      const thread = state.threads.find(
        (row) =>
          row.tenantId === stringParam(params, 0) &&
          row.provider === stringParam(params, 1) &&
          row.externalThreadId === stringParam(params, 2)
      );
      if (thread && thread.lastInboundSequence === numberParam(params, 9)) {
        thread.phoneHash = stringParam(params, 3);
        thread.phoneMasked = stringParam(params, 4);
        thread.patientId = stringParam(params, 5);
        thread.conversationId = stringParam(params, 6);
        thread.lastInboundSequence = numberParam(params, 8);
        return rows<T>([{ id: thread.id }]);
      }
      return rows<T>([]);
    }

    if (sql.startsWith("update pulso_iris.conversations")) {
      const conversation = state.conversations.find(
        (row) => row.tenantId === stringParam(params, 0) && row.id === stringParam(params, 1)
      );
      if (conversation) {
        conversation.patientId = stringParam(params, 2);
        conversation.sofiaStatus = "queued";
      }
      return rows<T>([]);
    }

    if (sql.startsWith("insert into pulso_iris.outbox_events")) {
      const candidate: FakeOutboxRow = {
        tenantId: stringParam(params, 0),
        eventType: stringParam(params, 1),
        aggregateId: stringParam(params, 3),
        payload: JSON.parse(stringParam(params, 4)) as Record<string, unknown>
      };
      if (
        !state.outbox.some(
          (row) =>
            row.tenantId === candidate.tenantId &&
            row.eventType === candidate.eventType &&
            row.aggregateId === candidate.aggregateId
        )
      ) {
        state.outbox.push(candidate);
      }
      return rows<T>([]);
    }

    if (sql.startsWith("update pulso_iris.inbox_events")) {
      const inbox = state.inbox.find(
        (row) => row.eventId === stringParam(params, 0) && row.tenantId === stringParam(params, 1)
      );
      if (inbox) {
        const streamId = stringParam(params, 3);
        const streamSequence = numberParam(params, 4);
        if (
          state.inbox.some(
            (row) =>
              row !== inbox &&
              row.tenantId === inbox.tenantId &&
              row.streamId === streamId &&
              row.streamSequence === streamSequence
          )
        ) {
          const error = new Error("duplicate stream position") as Error & { code: string; constraint: string };
          error.code = "23505";
          error.constraint = "uq_pulso_channel_inbox_stream_sequence";
          throw error;
        }
        inbox.result = JSON.parse(stringParam(params, 2));
        inbox.streamId = streamId;
        inbox.streamSequence = streamSequence;
      }
      return rows<T>([]);
    }

    throw new Error(`Unexpected SQL in fake database: ${sql}`);
  }

  async close() {}

  private uuid(): string {
    const suffix = String(this.nextId++).padStart(12, "0");
    return `90000000-0000-4000-8000-${suffix}`;
  }
}

function emptyState(): FakeState {
  return {
    inbox: [],
    threads: [],
    patients: [],
    conversations: [],
    messages: [],
    outbox: [],
    channelPositions: []
  };
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").toLowerCase();
}

function stringParam(params: unknown[], index: number): string {
  const value = params[index];
  if (typeof value !== "string") throw new Error(`Expected string parameter at index ${index}`);
  return value;
}

function numberParam(params: unknown[], index: number): number {
  const value = params[index];
  if (typeof value !== "number") throw new Error(`Expected number parameter at index ${index}`);
  return value;
}

function nullableNumberParam(params: unknown[], index: number): number | null {
  const value = params[index];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Expected nullable number parameter at index ${index}`);
  return value;
}

function rows<T extends Record<string, unknown>>(items: Record<string, unknown>[]): { rows: T[] } {
  return { rows: items as T[] };
}

function isActive(conversation: FakeConversationRow): boolean {
  return conversation.status === "active" || conversation.status === "handoff_required";
}
