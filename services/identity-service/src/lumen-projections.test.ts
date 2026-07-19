import type { DatabaseClient, DatabaseTransaction } from "@hyperion/database";
import type { HttpOutboxFetch, JetStreamSessionFactory } from "@hyperion/durable-events";
import { describe, expect, it } from "vitest";
import {
  ACCESS_LUMEN_OPERATOR_GRANT_EVENT,
  AccessLumenProjectionReconciler,
  PostgresAccessLumenProjectionOutbox,
  backfillAccessLumenProjections,
  createAccessLumenProjectionDispatcher,
  createAccessLumenProjectionJetStreamDispatcher,
  enqueueAccessLumenOperatorProjections,
  mutateLumenGrantWithProjection,
  replayCurrentAccessLumenProjection,
  redriveAccessLumenProjectionDeadLetter,
  readAccessLumenProjectionConfiguration
} from "./lumen-projections.js";
import {
  LUMEN_PROJECTION_REDRIVE_CONFIRMATION,
  LUMEN_PROJECTION_REPLAY_CONFIRMATION,
  parseLumenProjectionOperation,
  runLumenProjectionOperation
} from "./lumen-projection-operations.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";
const initialSourceVersion = Date.parse("2026-07-18T12:00:00.000Z") + 1;

describe("Access→LUMEN projection transport gate", () => {
  it("is opt-in, keeps HTTP as fallback, and requires an explicit Access JetStream identity", () => {
    expect(readAccessLumenProjectionConfiguration({})).toEqual({ transport: "disabled" });
    expect(() =>
      readAccessLumenProjectionConfiguration({
        ACCESS_LUMEN_PROJECTION_TRANSPORT: "http",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        ACCESS_TO_LUMEN_TOKEN: "test-token",
        LUMEN_SERVICE_URL: "http://lumen:8090"
      })
    ).toThrow(/HTTP delivery requires DURABLE_EVENT_TRANSPORT=http/);
    expect(() => readAccessLumenProjectionConfiguration({ ACCESS_LUMEN_PROJECTION_TRANSPORT: "jetstream" })).toThrow(
      /DURABLE_EVENT_TRANSPORT=jetstream/
    );
    expect(
      readAccessLumenProjectionConfiguration({
        ACCESS_LUMEN_PROJECTION_TRANSPORT: "jetstream",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_USERNAME: "access",
        NATS_PASSWORD: "access-test-password-000001"
      })
    ).toEqual({
      transport: "jetstream",
      natsUrl: "nats://nats:4222",
      authentication: { username: "access", password: "access-test-password-000001" },
      deliveryEnabled: true,
      backfillLimit: 100,
      reconcileIntervalMs: 60_000
    });
  });
});

describe("Access-owned LUMEN projection transaction", () => {
  it("commits the grant and an inactive/review-free event together on revoke", async () => {
    const model = new ProjectionDatabase();

    await mutateLumenGrantWithProjection(model.database, { tenantId, operatorId }, async (transaction) => {
      await transaction.query("test:set-grant-active", [false, "2026-07-18T12:01:00.000Z"]);
      return { rowCount: 1 };
    });

    expect(model.state.grant.active).toBe(false);
    const grantEvent = model.state.outbox.find((event) => event.eventType === ACCESS_LUMEN_OPERATOR_GRANT_EVENT);
    expect(grantEvent?.payload).toMatchObject({
      tenantId,
      operatorId,
      isActive: false,
      canReview: false,
      sourceVersion: Date.parse("2026-07-18T12:01:00.000Z") + 1
    });
  });

  it("rolls the mutation back when projection persistence fails", async () => {
    const model = new ProjectionDatabase();

    await expect(
      mutateLumenGrantWithProjection(
        model.database,
        { tenantId, operatorId },
        async (transaction) => {
          await transaction.query("test:set-grant-active", [false, "2026-07-18T12:01:00.000Z"]);
          return { rowCount: 1 };
        },
        () => true,
        async () => {
          throw new Error("outbox unavailable");
        }
      )
    ).rejects.toThrow("outbox unavailable");

    expect(model.state.grant.active).toBe(true);
    expect(model.state.outbox).toHaveLength(0);
  });

  it("immediately refreshes every LUMEN grant when the operator state changes", async () => {
    const model = new ProjectionDatabase();

    await model.database.transaction(async (transaction) => {
      await transaction.query("test:set-operator-active", [false, "2026-07-18T12:01:00.000Z"]);
      await enqueueAccessLumenOperatorProjections(transaction, operatorId);
    });

    const grantEvent = model.state.outbox.find((event) => event.eventType === ACCESS_LUMEN_OPERATOR_GRANT_EVENT);
    expect(grantEvent?.payload).toMatchObject({ tenantId, operatorId, isActive: false, canReview: false });
  });
});

describe("Access→LUMEN bounded reconciliation", () => {
  it("persists each changed delivery intent before advancing its producer watermark", async () => {
    const model = new ProjectionDatabase();

    await backfillAccessLumenProjections(model.database, 10);

    const firstOutboxWrite = model.queryLog.findIndex((sql) =>
      sql.startsWith("insert into access_runtime.lumen_projection_outbox")
    );
    const firstWatermarkWrite = model.queryLog.findIndex((sql) =>
      sql.startsWith("insert into access_runtime.lumen_projection_state")
    );
    expect(firstOutboxWrite).toBeGreaterThan(-1);
    expect(firstWatermarkWrite).toBeGreaterThan(firstOutboxWrite);
  });

  it("rolls back projection state when delivery intent persistence fails", async () => {
    const model = new ProjectionDatabase();
    model.failNextOutboxInsert = true;

    await expect(backfillAccessLumenProjections(model.database, 10)).rejects.toThrow("synthetic outbox failure");

    expect(model.state.projections.size).toBe(0);
    expect(model.state.outbox).toHaveLength(0);
  });

  it("is reentrant, idempotent, and advances only changed payload versions", async () => {
    const model = new ProjectionDatabase();

    await expect(backfillAccessLumenProjections(model.database, 10)).resolves.toEqual({
      candidatesProcessed: 1,
      eventsEnqueued: 2,
      hasMore: false
    });
    await expect(backfillAccessLumenProjections(model.database, 10)).resolves.toEqual({
      candidatesProcessed: 0,
      eventsEnqueued: 0,
      hasMore: false
    });
    expect(model.state.outbox).toHaveLength(2);

    await mutateLumenGrantWithProjection(model.database, { tenantId, operatorId }, async (transaction) => {
      await transaction.query("test:set-grant-active", [false, "2026-07-18T12:02:00.000Z"]);
      return { rowCount: 1 };
    });
    await mutateLumenGrantWithProjection(model.database, { tenantId, operatorId }, async (transaction) => {
      await transaction.query("test:set-grant-active", [false, "2026-07-18T12:03:00.000Z"]);
      return { rowCount: 1 };
    });

    const grantEvents = model.state.outbox.filter((event) => event.eventType === ACCESS_LUMEN_OPERATOR_GRANT_EVENT);
    expect(grantEvents.map((event) => event.payload.sourceVersion)).toEqual([
      initialSourceVersion,
      Date.parse("2026-07-18T12:02:00.000Z") + 1
    ]);
    expect(grantEvents[1]?.payload).toMatchObject({ isActive: false, canReview: false });
    expect(model.state.outbox).toHaveLength(3);
  });

  it("serializes periodic runs and waits for in-flight reconciliation during shutdown", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconciler = new AccessLumenProjectionReconciler({} as DatabaseClient, 10, 1_000, async () => {
      calls += 1;
      await pending;
      return { candidatesProcessed: 1, eventsEnqueued: 2, hasMore: false };
    });

    const first = reconciler.reconcileOnce();
    const concurrent = reconciler.reconcileOnce();
    expect(concurrent).toBe(first);
    await Promise.resolve();
    const stopping = reconciler.stop();
    expect(calls).toBe(1);
    release!();
    await expect(stopping).resolves.toBeUndefined();
    await expect(first).resolves.toEqual({ candidatesProcessed: 1, eventsEnqueued: 2, hasMore: false });
    await expect(reconciler.reconcileOnce()).resolves.toEqual({
      candidatesProcessed: 0,
      eventsEnqueued: 0,
      hasMore: false
    });
  });

  it("does not turn a reported reconciliation failure into a shutdown failure", async () => {
    const reconciler = new AccessLumenProjectionReconciler({} as DatabaseClient, 10, 1_000, async () => {
      throw new Error("temporary database outage");
    });
    const failed = reconciler.reconcileOnce();
    await expect(failed).rejects.toThrow("temporary database outage");
    await expect(reconciler.stop()).resolves.toBeUndefined();
  });
});

describe("Access→LUMEN dead-letter replay", () => {
  it("requeues only an exact terminal event and preserves its id and payload", async () => {
    const model = new ProjectionDatabase();
    await backfillAccessLumenProjections(model.database, 10);
    const deadLetter = model.forceDeadLetter(0);
    const originalPayload = { ...deadLetter.payload };

    await expect(
      redriveAccessLumenProjectionDeadLetter(model.database, {
        eventId: deadLetter.id,
        tenantId: deadLetter.tenantId,
        projectionKind: deadLetter.projectionKind as "tenant_snapshot" | "operator_grant"
      })
    ).resolves.toEqual({
      eventId: deadLetter.id,
      tenantId: deadLetter.tenantId,
      projectionKind: deadLetter.projectionKind,
      sourceVersion: String(deadLetter.sourceVersion)
    });

    expect(deadLetter).toMatchObject({ status: "queued", attemptCount: 0, retryDue: true, payload: originalPayload });
    await expect(
      redriveAccessLumenProjectionDeadLetter(model.database, {
        eventId: deadLetter.id,
        tenantId: deadLetter.tenantId,
        projectionKind: deadLetter.projectionKind as "tenant_snapshot" | "operator_grant"
      })
    ).resolves.toBeUndefined();
  });

  it("fails closed for invalid selectors and never requeues another tenant", async () => {
    const model = new ProjectionDatabase();
    await backfillAccessLumenProjections(model.database, 10);
    const deadLetter = model.forceDeadLetter(0);

    await expect(
      redriveAccessLumenProjectionDeadLetter(model.database, {
        eventId: deadLetter.id,
        tenantId: "33333333-3333-4333-8333-333333333333",
        projectionKind: deadLetter.projectionKind as "tenant_snapshot" | "operator_grant"
      })
    ).resolves.toBeUndefined();
    await expect(
      redriveAccessLumenProjectionDeadLetter(model.database, {
        eventId: "not-a-uuid",
        tenantId,
        projectionKind: "tenant_snapshot"
      })
    ).rejects.toThrow(/event id must be a UUID/);
    expect(deadLetter.status).toBe("dead_letter");
  });

  it("exposes explicit, bounded reconcile and confirmation-gated redrive operations", async () => {
    expect(parseLumenProjectionOperation(["reconcile", "--limit", "25"])).toEqual({
      command: "reconcile",
      limit: 25
    });
    expect(() =>
      parseLumenProjectionOperation([
        "redrive",
        "--event-id",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "--tenant-id",
        tenantId,
        "--projection",
        "tenant_snapshot",
        "--confirm",
        "yes"
      ])
    ).toThrow(/--confirm must equal/);

    const model = new ProjectionDatabase();
    await backfillAccessLumenProjections(model.database, 10);
    const deadLetter = model.forceDeadLetter(0);
    let boundaryChecked = false;
    let closed = false;
    const operation = parseLumenProjectionOperation([
      "redrive",
      "--event-id",
      deadLetter.id,
      "--tenant-id",
      deadLetter.tenantId,
      "--projection",
      deadLetter.projectionKind,
      "--confirm",
      LUMEN_PROJECTION_REDRIVE_CONFIRMATION
    ]);
    const database: DatabaseClient = {
      ...model.database,
      close: async () => {
        closed = true;
      }
    };
    await expect(
      runLumenProjectionOperation(
        operation,
        { DATABASE_URL: "postgresql://runtime-redacted/access" },
        {
          createDatabase: () => database,
          assertRuntimeBoundary: async () => {
            boundaryChecked = true;
          }
        }
      )
    ).resolves.toMatchObject({ command: "redrive", status: "queued", eventId: deadLetter.id });
    expect(boundaryChecked).toBe(true);
    expect(closed).toBe(true);
  });

  it("checks the Access runtime boundary before changing a dead letter", async () => {
    const model = new ProjectionDatabase();
    await backfillAccessLumenProjections(model.database, 10);
    const deadLetter = model.forceDeadLetter(0);
    let closed = false;

    await expect(
      runLumenProjectionOperation(
        {
          command: "redrive",
          eventId: deadLetter.id,
          tenantId: deadLetter.tenantId,
          projectionKind: deadLetter.projectionKind as "tenant_snapshot" | "operator_grant",
          confirmation: LUMEN_PROJECTION_REDRIVE_CONFIRMATION
        },
        { DATABASE_URL: "postgresql://admin-redacted/access" },
        {
          createDatabase: () => ({ ...model.database, close: async () => void (closed = true) }),
          assertRuntimeBoundary: async () => {
            throw new Error("connected as hyperion_access_migrator");
          }
        }
      )
    ).rejects.toThrow("connected as hyperion_access_migrator");
    expect(deadLetter.status).toBe("dead_letter");
    expect(closed).toBe(true);
  });
});

describe("Access→LUMEN exact current replay", () => {
  it.each(["tenant_snapshot", "operator_grant"] as const)(
    "requeues the current %s row without changing its logical identity",
    async (projectionKind) => {
      const model = new ProjectionDatabase();
      await backfillAccessLumenProjections(model.database, 10);
      const current = model.publish(projectionKind);
      const original = {
        id: current.id,
        aggregateId: current.aggregateId,
        eventType: current.eventType,
        eventVersion: current.eventVersion,
        payload: { ...current.payload },
        sourceVersion: current.sourceVersion
      };

      await expect(
        replayCurrentAccessLumenProjection(model.database, {
          eventId: current.id,
          tenantId: current.tenantId,
          projectionKind
        })
      ).resolves.toEqual({
        eventId: current.id,
        tenantId: current.tenantId,
        projectionKind,
        aggregateId: current.aggregateId,
        sourceVersion: String(current.sourceVersion),
        eventType: current.eventType,
        eventVersion: 1
      });

      expect(current).toMatchObject({
        ...original,
        status: "retry_scheduled",
        attemptCount: 0,
        retryDue: true,
        payload: original.payload
      });
      await expect(
        replayCurrentAccessLumenProjection(model.database, {
          eventId: current.id,
          tenantId: current.tenantId,
          projectionKind
        })
      ).resolves.toBeUndefined();
    }
  );

  it("fails closed when the selected event is no longer the provider watermark", async () => {
    const model = new ProjectionDatabase();
    await backfillAccessLumenProjections(model.database, 10);
    const stale = model.publish("operator_grant");
    await mutateLumenGrantWithProjection(model.database, { tenantId, operatorId }, async (transaction) => {
      await transaction.query("test:set-grant-active", [false, "2026-07-18T12:02:00.000Z"]);
      return { rowCount: 1 };
    });

    await expect(
      replayCurrentAccessLumenProjection(model.database, {
        eventId: stale.id,
        tenantId,
        projectionKind: "operator_grant"
      })
    ).resolves.toBeUndefined();
    expect(stale.status).toBe("published");
  });

  it("exposes a confirmation-gated exact replay operation", async () => {
    expect(
      parseLumenProjectionOperation([
        "replay",
        "--event-id",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "--tenant-id",
        tenantId,
        "--projection",
        "operator_grant",
        "--confirm",
        LUMEN_PROJECTION_REPLAY_CONFIRMATION
      ])
    ).toEqual({
      command: "replay",
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tenantId,
      projectionKind: "operator_grant",
      confirmation: LUMEN_PROJECTION_REPLAY_CONFIRMATION
    });
    expect(() =>
      parseLumenProjectionOperation([
        "replay",
        "--event-id",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "--tenant-id",
        tenantId,
        "--projection",
        "operator_grant",
        "--confirm",
        LUMEN_PROJECTION_REDRIVE_CONFIRMATION
      ])
    ).toThrow(/--confirm must equal REPLAY ACCESS LUMEN PROJECTION/);

    const model = new ProjectionDatabase();
    await backfillAccessLumenProjections(model.database, 10);
    const current = model.publish("operator_grant");
    let boundaryChecked = false;
    let closed = false;
    const operation = {
      command: "replay" as const,
      eventId: current.id,
      tenantId,
      projectionKind: "operator_grant" as const,
      confirmation: LUMEN_PROJECTION_REPLAY_CONFIRMATION
    };
    const dependencies = {
      createDatabase: () => ({ ...model.database, close: async () => void (closed = true) }),
      assertRuntimeBoundary: async () => void (boundaryChecked = true)
    };
    await expect(
      runLumenProjectionOperation(operation, { DATABASE_URL: "postgresql://runtime-redacted/access" }, dependencies)
    ).resolves.toMatchObject({ command: "replay", status: "queued", eventId: current.id });
    await expect(
      runLumenProjectionOperation(operation, { DATABASE_URL: "postgresql://runtime-redacted/access" }, dependencies)
    ).rejects.toThrow(/Exact current published LUMEN projection was not found/);
    expect(boundaryChecked).toBe(true);
    expect(closed).toBe(true);
  });
});

describe("Access→LUMEN HTTP delivery", () => {
  it("keeps failed deliveries pending and drains them with the Access caller credential", async () => {
    const model = new ProjectionDatabase();
    await backfillAccessLumenProjections(model.database, 10);

    let networkDown = true;
    const callers: Array<string | null> = [];
    const fetchImplementation: HttpOutboxFetch = async (_input, init) => {
      callers.push(new Headers(init?.headers).get("x-hyperion-caller"));
      if (networkDown) throw new Error("LUMEN unavailable");
      return new Response(null, { status: 202 });
    };
    const workerId = "access-lumen-test-worker";
    const outbox = new PostgresAccessLumenProjectionOutbox(model.database, workerId, "http://lumen:8090/");
    const dispatcher = createAccessLumenProjectionDispatcher(
      outbox,
      workerId,
      "access-lumen-test-token",
      fetchImplementation
    );

    const failed = await dispatcher.drainOnce();
    expect(failed).toMatchObject({ claimed: 2, completed: 0, failed: 2 });
    expect(model.state.outbox.every((event) => event.status === "retry_scheduled")).toBe(true);

    model.makeRetriesDue();
    networkDown = false;
    const drained = await dispatcher.drainOnce();
    expect(drained).toMatchObject({ claimed: 2, completed: 2, failed: 0 });
    expect(model.state.outbox.every((event) => event.status === "published")).toBe(true);
    expect(callers).toEqual(["identity-service", "identity-service", "identity-service", "identity-service"]);
  });
});

describe("Access→LUMEN JetStream delivery", () => {
  it("publishes only the two provider-owned projection subjects and drains the same durable outbox", async () => {
    const model = new ProjectionDatabase();
    await backfillAccessLumenProjections(model.database, 10);
    const subjects: string[] = [];
    const sessionFactory: JetStreamSessionFactory = async () => ({
      publish: async (subject) => {
        subjects.push(subject);
        return { stream: "HYPERION_EVENTS", seq: subjects.length, duplicate: false };
      },
      close: async () => undefined
    });
    const configuration = readAccessLumenProjectionConfiguration({
      ACCESS_LUMEN_PROJECTION_TRANSPORT: "jetstream",
      DURABLE_EVENT_TRANSPORT: "jetstream",
      NATS_URL: "nats://nats:4222",
      NATS_USERNAME: "access",
      NATS_PASSWORD: "access-test-password-000001"
    });
    if (configuration.transport !== "jetstream") throw new Error("expected JetStream test configuration");
    const workerId = "access-lumen-jetstream-test";
    const outbox = new PostgresAccessLumenProjectionOutbox(model.database, workerId);
    const dispatcher = createAccessLumenProjectionJetStreamDispatcher(outbox, workerId, configuration, sessionFactory);

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 2, completed: 2, failed: 0 });
    expect(new Set(subjects)).toEqual(
      new Set(["hyperion.events.access.lumen.tenant-snapshot.v1", "hyperion.events.access.lumen.operator-grant.v1"])
    );
    expect(model.state.outbox.every((event) => event.status === "published")).toBe(true);
    await dispatcher.stop();
  });
});

interface ProjectionState {
  sourceVersion: number;
  sourceUpdatedAt: string;
  payloadHash: string;
}

interface StoredOutboxEvent {
  id: string;
  tenantId: string;
  projectionKind: string;
  aggregateId: string;
  sourceVersion: number;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
  occurredAt: string;
  status: "queued" | "processing" | "retry_scheduled" | "published" | "dead_letter";
  attemptCount: number;
  retryDue: boolean;
  lockedBy?: string;
  lastErrorCode?: string;
}

interface ModelState {
  tenant: {
    id: string;
    status: "active" | "paused" | "archived";
    isDemo: boolean;
    updatedAt: string;
  };
  grant: {
    tenantId: string;
    operatorId: string;
    roles: string[];
    capabilities: string[];
    active: boolean;
    operatorActive: boolean;
    grantUpdatedAt: string;
    operatorUpdatedAt: string;
  };
  projections: Map<string, ProjectionState>;
  outbox: StoredOutboxEvent[];
}

interface ModelQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

class ProjectionDatabase {
  readonly queryLog: string[] = [];
  failNextOutboxInsert = false;
  state: ModelState = {
    tenant: {
      id: tenantId,
      status: "active",
      isDemo: true,
      updatedAt: "2026-07-18T12:00:00.000Z"
    },
    grant: {
      tenantId,
      operatorId,
      roles: ["advisor"],
      capabilities: ["lumen:read", "lumen:write"],
      active: true,
      operatorActive: true,
      grantUpdatedAt: "2026-07-18T12:00:00.000Z",
      operatorUpdatedAt: "2026-07-18T12:00:00.000Z"
    },
    projections: new Map(),
    outbox: []
  };

  readonly database: DatabaseClient = {
    query: ((sql: string, values?: unknown[]) => this.execute(this.state, sql, values)) as DatabaseClient["query"],
    transaction: async <T>(work: (transaction: DatabaseTransaction) => Promise<T>) => {
      const candidate = cloneState(this.state);
      const transaction = {
        query: ((sql: string, values?: unknown[]) =>
          this.execute(candidate, sql, values)) as DatabaseTransaction["query"]
      } as DatabaseTransaction;
      const result = await work(transaction);
      this.state = candidate;
      return result;
    },
    close: async () => undefined
  };

  makeRetriesDue(): void {
    for (const event of this.state.outbox) event.retryDue = true;
  }

  forceDeadLetter(index: number): StoredOutboxEvent {
    const event = this.state.outbox[index];
    if (!event) throw new Error("Synthetic projection event is missing");
    event.status = "dead_letter";
    event.attemptCount = 20;
    event.retryDue = false;
    event.lastErrorCode = "synthetic_failure";
    delete event.lockedBy;
    return event;
  }

  publish(projectionKind: "tenant_snapshot" | "operator_grant"): StoredOutboxEvent {
    const event = this.state.outbox.find((candidate) => candidate.projectionKind === projectionKind);
    if (!event) throw new Error("Synthetic projection event is missing");
    event.status = "published";
    event.retryDue = false;
    return event;
  }

  private async execute(state: ModelState, sql: string, values: unknown[] = []): Promise<ModelQueryResult> {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    this.queryLog.push(normalized);

    if (normalized === "test:set-grant-active") {
      state.grant.active = Boolean(values[0]);
      state.grant.grantUpdatedAt = String(values[1]);
      return { rows: [], rowCount: 1 };
    }
    if (normalized === "test:set-operator-active") {
      state.grant.operatorActive = Boolean(values[0]);
      state.grant.operatorUpdatedAt = String(values[1]);
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith('select tenant_id as "tenantid"') &&
      normalized.includes("where operator_id = $1 and product_id = $2")
    ) {
      return {
        rows: state.grant.operatorId === values[0] ? [{ tenantId: state.grant.tenantId }] : [],
        rowCount: state.grant.operatorId === values[0] ? 1 : 0
      };
    }
    if (normalized.startsWith("select grant_row.tenant_id") && normalized.includes("tenant_state")) {
      const tenantProjection = state.projections.get(projectionKey("tenant_snapshot", tenantId, tenantId));
      const operatorProjection = state.projections.get(projectionKey("operator_grant", tenantId, operatorId));
      const operatorSourceUpdatedAt = maximumDate(state.grant.grantUpdatedAt, state.grant.operatorUpdatedAt);
      const stale =
        !tenantProjection ||
        tenantProjection.sourceUpdatedAt < state.tenant.updatedAt ||
        !operatorProjection ||
        operatorProjection.sourceUpdatedAt < operatorSourceUpdatedAt;
      return {
        rows: stale ? [{ tenantId, operatorId }].slice(0, Number(values[1])) : [],
        rowCount: stale ? 1 : 0
      };
    }
    if (normalized.includes("from platform.tenants tenant") && normalized.includes("where tenant.id = $1")) {
      return {
        rows: [
          {
            tenantId: state.tenant.id,
            status: state.tenant.status,
            isDemo: state.tenant.isDemo,
            sourceUpdatedAt: state.tenant.updatedAt
          }
        ],
        rowCount: 1
      };
    }
    if (normalized.includes("from access_runtime.product_grants grant_row") && normalized.includes("greatest")) {
      return {
        rows: [
          {
            tenantId: state.grant.tenantId,
            operatorId: state.grant.operatorId,
            roles: state.grant.roles,
            capabilities: state.grant.capabilities,
            isActive: state.grant.active && state.grant.operatorActive,
            sourceUpdatedAt: maximumDate(state.grant.grantUpdatedAt, state.grant.operatorUpdatedAt)
          }
        ],
        rowCount: 1
      };
    }
    if (normalized.startsWith("select pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
    if (normalized.startsWith("select source_version::text")) {
      const stateRow = state.projections.get(projectionKey(String(values[0]), String(values[1]), String(values[2])));
      return {
        rows: stateRow ? [{ sourceVersion: String(stateRow.sourceVersion), payloadHash: stateRow.payloadHash }] : [],
        rowCount: stateRow ? 1 : 0
      };
    }
    if (normalized.startsWith("insert into access_runtime.lumen_projection_state")) {
      state.projections.set(projectionKey(String(values[0]), String(values[1]), String(values[2])), {
        sourceVersion: Number(values[3]),
        sourceUpdatedAt: String(values[4]),
        payloadHash: String(values[5])
      });
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith("update access_runtime.lumen_projection_state") &&
      normalized.includes("set source_updated_at = greatest")
    ) {
      const row = state.projections.get(projectionKey(String(values[0]), String(values[1]), String(values[2])))!;
      row.sourceUpdatedAt = maximumDate(row.sourceUpdatedAt, String(values[3]));
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith("update access_runtime.lumen_projection_state") &&
      normalized.includes("set source_version = $4")
    ) {
      state.projections.set(projectionKey(String(values[0]), String(values[1]), String(values[2])), {
        sourceVersion: Number(values[3]),
        sourceUpdatedAt: String(values[4]),
        payloadHash: String(values[5])
      });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("insert into access_runtime.lumen_projection_outbox")) {
      if (this.failNextOutboxInsert) {
        this.failNextOutboxInsert = false;
        throw new Error("synthetic outbox failure");
      }
      state.outbox.push({
        id: String(values[0]),
        tenantId: String(values[1]),
        projectionKind: String(values[2]),
        aggregateId: String(values[3]),
        sourceVersion: Number(values[4]),
        eventType: String(values[5]),
        eventVersion: 1,
        payload: JSON.parse(String(values[6])) as Record<string, unknown>,
        occurredAt: String(values[7]),
        status: "queued",
        attemptCount: 0,
        retryDue: true
      });
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith("update access_runtime.lumen_projection_outbox") &&
      normalized.includes("set status = 'queued'") &&
      normalized.includes("and status = 'dead_letter'")
    ) {
      const event = state.outbox.find(
        (candidate) =>
          candidate.id === values[0] &&
          candidate.tenantId === values[1] &&
          candidate.projectionKind === values[2] &&
          candidate.status === "dead_letter"
      );
      if (!event) return { rows: [], rowCount: 0 };
      event.status = "queued";
      event.attemptCount = 0;
      event.retryDue = true;
      delete event.lockedBy;
      delete event.lastErrorCode;
      return {
        rows: [
          {
            eventId: event.id,
            tenantId: event.tenantId,
            projectionKind: event.projectionKind,
            sourceVersion: String(event.sourceVersion)
          }
        ],
        rowCount: 1
      };
    }
    if (
      normalized.startsWith("update access_runtime.lumen_projection_outbox event_row") &&
      normalized.includes("from access_runtime.lumen_projection_state state_row")
    ) {
      const event = state.outbox.find(
        (candidate) =>
          candidate.id === values[0] &&
          candidate.tenantId === values[1] &&
          candidate.projectionKind === values[2] &&
          candidate.status === "published"
      );
      const currentState = event
        ? state.projections.get(projectionKey(event.projectionKind, event.tenantId, event.aggregateId))
        : undefined;
      if (!event || currentState?.sourceVersion !== event.sourceVersion) return { rows: [], rowCount: 0 };
      event.status = "retry_scheduled";
      event.attemptCount = 0;
      event.retryDue = true;
      delete event.lockedBy;
      delete event.lastErrorCode;
      return {
        rows: [
          {
            eventId: event.id,
            tenantId: event.tenantId,
            projectionKind: event.projectionKind,
            aggregateId: event.aggregateId,
            sourceVersion: String(event.sourceVersion),
            eventType: event.eventType,
            eventVersion: event.eventVersion
          }
        ],
        rowCount: 1
      };
    }
    if (normalized.startsWith("with terminalized as") && normalized.includes("event_row.payload")) {
      const workerId = String(values[0]);
      const limit = Number(values[1]);
      const claimed = state.outbox
        .filter((event) => event.status === "queued" || (event.status === "retry_scheduled" && event.retryDue))
        .slice(0, limit);
      for (const event of claimed) {
        event.status = "processing";
        event.attemptCount += 1;
        event.lockedBy = workerId;
      }
      return {
        rows: claimed.map((event) => ({
          id: event.id,
          tenantId: event.tenantId,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          occurredAt: event.occurredAt,
          payload: event.payload
        })),
        rowCount: claimed.length
      };
    }
    if (
      normalized.startsWith("update access_runtime.lumen_projection_outbox") &&
      normalized.includes("set status = 'published'")
    ) {
      const event = state.outbox.find(
        (candidate) =>
          candidate.id === values[0] && candidate.status === "processing" && candidate.lockedBy === values[1]
      );
      if (event) {
        event.status = "published";
        delete event.lockedBy;
      }
      return { rows: [], rowCount: event ? 1 : 0 };
    }
    if (
      normalized.startsWith("update access_runtime.lumen_projection_outbox") &&
      normalized.includes("set status = case")
    ) {
      const event = state.outbox.find(
        (candidate) =>
          candidate.id === values[0] && candidate.status === "processing" && candidate.lockedBy === values[1]
      );
      if (event) {
        event.status = "retry_scheduled";
        event.retryDue = false;
        delete event.lockedBy;
      }
      return { rows: [], rowCount: event ? 1 : 0 };
    }

    throw new Error(`Unexpected SQL in projection model: ${normalized}`);
  }
}

function projectionKey(kind: string, scopedTenantId: string, aggregateId: string): string {
  return `${kind}:${scopedTenantId}:${aggregateId}`;
}

function maximumDate(left: string, right: string): string {
  return left >= right ? left : right;
}

function cloneState(state: ModelState): ModelState {
  return {
    tenant: { ...state.tenant },
    grant: {
      ...state.grant,
      roles: [...state.grant.roles],
      capabilities: [...state.grant.capabilities]
    },
    projections: new Map([...state.projections].map(([key, value]) => [key, { ...value }])),
    outbox: state.outbox.map((event) => ({ ...event, payload: { ...event.payload } }))
  };
}
