import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelInboundEventSchema, registerChannelInboundEventRoutes } from "./channel-inbound-events.js";

const INTERNAL_TOKEN = "test-internal-token-with-enough-entropy";
const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const INBOUND_EVENT_ID = "30000000-0000-4000-8000-000000000001";
const THREAD_BINDING_ID = "40000000-0000-4000-8000-000000000001";

const inboundEvent = {
  id: EVENT_ID,
  type: "channel.inbound.received.v1" as const,
  version: 1 as const,
  occurredAt: "2026-07-13T16:30:00.000Z",
  tenantId: TENANT_ID,
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
    await registerChannelInboundEventRoutes(app, {
      config: {
        serviceName: "pulso-iris-service",
        environment: "test",
        host: "127.0.0.1",
        port: 8088,
        serviceVersion: "test",
        corsAllowedOrigins: [],
        internalServiceToken: INTERNAL_TOKEN
      },
      db: db as never,
      logger: logger as never
    });
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
      outboxEventType: "pulso.message.received.v1"
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
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload
    });
  }
});

interface FakeInboxRow {
  eventId: string;
  tenantId: string;
  payloadHash: string;
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

interface FakeState {
  inbox: FakeInboxRow[];
  threads: FakeThreadRow[];
  patients: FakePatientRow[];
  conversations: FakeConversationRow[];
  messages: FakeMessageRow[];
  outbox: FakeOutboxRow[];
}

class TransactionalFakeDatabase {
  state: FakeState = emptyState();
  executedSql: string[] = [];
  transactionCalls = 0;
  failWhenSqlIncludes: string | undefined;
  private nextId = 1;

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

    if (sql.startsWith("insert into pulso_iris.inbox_events")) {
      const eventId = stringParam(params, 0);
      if (state.inbox.some((row) => row.eventId === eventId)) return rows<T>([]);
      state.inbox.push({
        eventId,
        tenantId: stringParam(params, 1),
        payloadHash: stringParam(params, 4),
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
          conversationId: null
        };
        state.threads.push(thread);
      } else {
        thread.phoneHash = stringParam(params, 4);
        thread.phoneMasked = stringParam(params, 5);
      }
      return rows<T>([{ id: thread.id, patientId: thread.patientId, conversationId: thread.conversationId }]);
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
      if (thread) {
        thread.phoneHash = stringParam(params, 3);
        thread.phoneMasked = stringParam(params, 4);
        thread.patientId = stringParam(params, 5);
        thread.conversationId = stringParam(params, 6);
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
      if (inbox) inbox.result = JSON.parse(stringParam(params, 2));
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
  return { inbox: [], threads: [], patients: [], conversations: [], messages: [], outbox: [] };
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").toLowerCase();
}

function stringParam(params: unknown[], index: number): string {
  const value = params[index];
  if (typeof value !== "string") throw new Error(`Expected string parameter at index ${index}`);
  return value;
}

function rows<T extends Record<string, unknown>>(items: Record<string, unknown>[]): { rows: T[] } {
  return { rows: items as T[] };
}

function isActive(conversation: FakeConversationRow): boolean {
  return conversation.status === "active" || conversation.status === "handoff_required";
}
