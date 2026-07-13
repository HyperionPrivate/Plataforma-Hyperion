import { createService, type ServiceContext, type ServiceHandle } from "@hyperion/service-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const TEST_TOKEN = "test-internal-token";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT_ID = "33333333-3333-4333-8333-333333333333";

type DatabaseClient = NonNullable<ServiceContext["db"]>;
type FakeQuery = (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

interface InboxRecord {
  eventId: string;
  tenantId: string | null;
  sourceService: string;
  eventType: string;
  eventVersion: number;
  payloadHash: string;
  contractHash: string;
  occurredAt: string;
}

interface AuditRecord {
  id: string;
  tenant_id: string | null;
  actor_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  source_event_id: string;
  created_at: string;
}

class FakeTransactionalDatabase {
  inboxEvents = new Map<string, InboxRecord>();
  auditEvents: AuditRecord[] = [];
  transactionCount = 0;
  rollbackCount = 0;
  failAuditInsert = false;

  readonly client = {
    query: async (text: string, params?: unknown[]) => this.execute(text, params, this.inboxEvents, this.auditEvents),
    transaction: async <T>(work: (client: { query: FakeQuery }) => Promise<T>) => {
      this.transactionCount += 1;
      const pendingInbox = new Map(this.inboxEvents);
      const pendingAudit = this.auditEvents.map((event) => ({ ...event }));
      const transactionClient = {
        query: async (text: string, params?: unknown[]) => this.execute(text, params, pendingInbox, pendingAudit)
      };

      try {
        const result = await work(transactionClient);
        this.inboxEvents = pendingInbox;
        this.auditEvents = pendingAudit;
        return result;
      } catch (error) {
        this.rollbackCount += 1;
        throw error;
      }
    },
    close: async () => undefined
  } as unknown as DatabaseClient;

  private async execute(
    text: string,
    params: unknown[] | undefined,
    inboxEvents: Map<string, InboxRecord>,
    auditEvents: AuditRecord[]
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
    const values = params ?? [];

    if (sql.startsWith("insert into audit_runtime.inbox_events")) {
      const eventId = values[0] as string;
      if (inboxEvents.has(eventId)) {
        return queryResult([]);
      }

      inboxEvents.set(eventId, {
        eventId,
        tenantId: values[1] as string | null,
        sourceService: values[2] as string,
        eventType: values[3] as string,
        eventVersion: values[4] as number,
        payloadHash: values[5] as string,
        contractHash: values[6] as string,
        occurredAt: values[7] as string
      });
      return queryResult([{ event_id: eventId }]);
    }

    if (sql.startsWith("select contract_hash, occurred_at from audit_runtime.inbox_events")) {
      const record = inboxEvents.get(values[0] as string);
      return queryResult(record ? [{ contract_hash: record.contractHash, occurred_at: record.occurredAt }] : []);
    }

    if (sql.startsWith("insert into platform.audit_events")) {
      if (this.failAuditInsert) {
        throw new Error("simulated audit insert failure");
      }

      const sourceEventId = values[6] as string;
      const record: AuditRecord = {
        id: `audit-${auditEvents.length + 1}`,
        tenant_id: values[0] as string | null,
        actor_id: values[1] as string | null,
        event_type: values[2] as string,
        entity_type: values[3] as string,
        entity_id: values[4] as string | null,
        metadata: JSON.parse(values[5] as string) as Record<string, unknown>,
        source_event_id: sourceEventId,
        created_at: "2026-07-13T12:00:01.000Z"
      };
      auditEvents.push(record);
      return queryResult([record]);
    }

    throw new Error(`Unexpected SQL in fake database: ${sql}`);
  }
}

describe("POST /internal/v1/events", () => {
  let app: ServiceHandle["app"];
  let database: FakeTransactionalDatabase;

  beforeEach(async () => {
    process.env.DATABASE_URL = "postgresql://unused/audit-tests";
    process.env.INTERNAL_SERVICE_TOKEN = TEST_TOKEN;
    database = new FakeTransactionalDatabase();
    const handle = await createService({
      serviceName: "audit-service",
      databaseRequired: true,
      createDatabase: () => database.client,
      registerRoutes
    });
    app = handle.app;
  });

  afterEach(async () => {
    await app.close();
    delete process.env.DATABASE_URL;
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("requires the configured internal bearer token before touching the database", async () => {
    const missingToken = await app.inject({
      method: "POST",
      url: "/internal/v1/events",
      payload: buildEnvelope()
    });
    const wrongToken = await app.inject({
      method: "POST",
      url: "/internal/v1/events",
      headers: { authorization: "Bearer wrong-token" },
      payload: buildEnvelope()
    });

    expect(missingToken.statusCode).toBe(401);
    expect(wrongToken.statusCode).toBe(401);
    expect(database.transactionCount).toBe(0);
  });

  it("accepts a new event and commits its inbox and audit rows once", async () => {
    const response = await postEvent(app, buildEnvelope());

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ status: "accepted", eventId: EVENT_ID });
    expect(database.inboxEvents.get(EVENT_ID)).toMatchObject({
      tenantId: TENANT_ID,
      sourceService: "sofia-automation",
      eventType: "sofia.audit.event.record.v1",
      eventVersion: 1
    });
    expect(database.inboxEvents.get(EVENT_ID)?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(database.inboxEvents.get(EVENT_ID)?.contractHash).toMatch(/^[0-9a-f]{64}$/);
    expect(database.auditEvents).toHaveLength(1);
    expect(database.auditEvents[0]).toMatchObject({
      tenant_id: TENANT_ID,
      event_type: "appointment.registered",
      entity_type: "appointment",
      source_event_id: EVENT_ID
    });
  });

  it("rejects an event when the envelope and payload identify different tenants", async () => {
    const event = buildEnvelope();
    event.payload.tenantId = OTHER_TENANT_ID;

    const response = await postEvent(app, event);

    expect(response.statusCode).toBe(400);
    expect(response.json().data).toMatchObject({
      error: "Invalid event envelope",
      issues: ["tenantId must match payload.tenantId"]
    });
    expect(database.transactionCount).toBe(0);
    expect(database.inboxEvents).toHaveLength(0);
    expect(database.auditEvents).toHaveLength(0);
  });

  it("rejects an event when only the envelope identifies a tenant", async () => {
    const event = buildEnvelope();
    const { tenantId: _tenantId, ...payloadWithoutTenant } = event.payload;

    const response = await postEvent(app, { ...event, payload: payloadWithoutTenant });

    expect(response.statusCode).toBe(400);
    expect(response.json().data.issues).toContain("tenantId must match payload.tenantId");
    expect(database.transactionCount).toBe(0);
  });

  it("rejects an event when only the payload identifies a tenant", async () => {
    const response = await postEvent(app, { ...buildEnvelope(), tenantId: null });

    expect(response.statusCode).toBe(400);
    expect(response.json().data.issues).toContain("tenantId must match payload.tenantId");
    expect(database.transactionCount).toBe(0);
  });

  it("accepts equivalent UUID representations across envelope and payload", async () => {
    const event = buildEnvelope();
    event.tenantId = TENANT_ID.toUpperCase();

    const response = await postEvent(app, event);

    expect(response.statusCode).toBe(201);
    expect(database.transactionCount).toBe(1);
  });

  it("returns duplicate for a replay with the same canonical payload without a second audit row", async () => {
    const first = await postEvent(app, buildEnvelope({ metadata: { zeta: { second: 2, first: 1 }, alpha: true } }));
    const replay = await postEvent(app, buildEnvelope({ metadata: { alpha: true, zeta: { first: 1, second: 2 } } }));

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual({ status: "duplicate", eventId: EVENT_ID });
    expect(database.inboxEvents).toHaveLength(1);
    expect(database.auditEvents).toHaveLength(1);
  });

  it("returns conflict when an event id is reused with a different payload", async () => {
    const first = await postEvent(app, buildEnvelope({ metadata: { attempt: 1 } }));
    const conflict = await postEvent(app, buildEnvelope({ metadata: { attempt: 2 } }));

    expect(first.statusCode).toBe(201);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().data).toMatchObject({ eventId: EVENT_ID });
    expect(database.inboxEvents).toHaveLength(1);
    expect(database.auditEvents).toHaveLength(1);
  });

  it("binds idempotency to source and event type, not only to the payload", async () => {
    const first = await postEvent(app, buildEnvelope());
    const conflictingOrigin = await postEvent(app, {
      ...buildEnvelope(),
      type: "lumen.audit.event.record.v1"
    });

    expect(first.statusCode).toBe(201);
    expect(conflictingOrigin.statusCode).toBe(409);
    expect(database.inboxEvents.get(EVENT_ID)).toMatchObject({
      sourceService: "sofia-automation",
      eventType: "sofia.audit.event.record.v1"
    });
    expect(database.auditEvents).toHaveLength(1);
  });

  it("records the source declared by a valid LUMEN HTTP contract instead of using a default", async () => {
    // The shared HTTP bearer token authenticates an internal caller but cannot
    // attest which service sent it. The strict type/source mapping is therefore
    // declarative here; JetStream subject ACLs provide the stronger guarantee.
    const response = await postEvent(app, {
      ...buildEnvelope(),
      type: "lumen.audit.event.record.v1"
    });

    expect(response.statusCode).toBe(201);
    expect(database.inboxEvents.get(EVENT_ID)).toMatchObject({
      sourceService: "lumen-service",
      eventType: "lumen.audit.event.record.v1"
    });
  });

  it("rejects the ambiguous legacy wrapper event type", async () => {
    const response = await postEvent(app, {
      ...buildEnvelope(),
      type: "audit.event.record.v1"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().data.issues[0]).toContain("type must be one of");
    expect(database.transactionCount).toBe(0);
  });

  it("rolls back the inbox claim when the audit insert fails and allows a clean retry", async () => {
    database.failAuditInsert = true;
    const failed = await postEvent(app, buildEnvelope());

    expect(failed.statusCode).toBe(500);
    expect(failed.json().data).toEqual({ error: "Failed to persist audit event" });
    expect(database.inboxEvents).toHaveLength(0);
    expect(database.auditEvents).toHaveLength(0);
    expect(database.rollbackCount).toBe(1);

    database.failAuditInsert = false;
    const retried = await postEvent(app, buildEnvelope());

    expect(retried.statusCode).toBe(201);
    expect(database.inboxEvents).toHaveLength(1);
    expect(database.auditEvents).toHaveLength(1);
  });
});

function buildEnvelope(metadataOverride?: { metadata: Record<string, unknown> }) {
  return {
    id: EVENT_ID,
    type: "sofia.audit.event.record.v1",
    version: 1,
    occurredAt: "2026-07-13T12:00:00.000Z",
    tenantId: TENANT_ID,
    payload: {
      tenantId: TENANT_ID,
      actorId: "sofia-agent",
      eventType: "appointment.registered",
      entityType: "appointment",
      entityId: "appointment-123",
      metadata: metadataOverride?.metadata ?? { channel: "whatsapp" }
    }
  };
}

async function postEvent(app: ServiceHandle["app"], payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/internal/v1/events",
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    payload
  });
}

function queryResult<T>(rows: T[]) {
  return { rows, rowCount: rows.length };
}
