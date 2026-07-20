import type { HttpOutboxFetch, JetStreamSessionFactory } from "@hyperion/durable-events";
import { describe, expect, it, vi } from "vitest";
import {
  AccessTenantProjectionReconciler,
  PostgresAccessTenantProjectionOutbox,
  backfillAccessTenantSnapshots,
  createAccessTenantProjectionHttpDispatcher,
  createAccessTenantProjectionJetStreamDispatcher,
  enqueueAccessTenantSnapshot,
  readAccessTenantProjectionConfiguration,
  reconcileAccessTenantSnapshots,
  replayCurrentAccessTenantProjection,
  redriveAccessTenantProjectionDeadLetter
} from "./access-tenant-projections.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_UPDATED_AT = "2026-07-18T12:00:00.000Z";
const HTTP_TOKEN = "access-tenant-http-token-0001";
const CHANNEL_TOKEN = "access-to-channel-token-0001";
const PULSO_TOKEN = "access-to-pulso-token-00002";
const SOFIA_TOKEN = "access-to-sofia-token-00003";
const INTEGRATION_TOKEN = "access-to-integration-token-04";
const KNOWLEDGE_TOKEN = "access-to-knowledge-token-005";
const MULTI_EDGE_HTTP_URL =
  "http://whatsapp-channel-service:8089/internal/v1/events/access-tenant-snapshots,http://pulso-iris-service:8088/internal/v1/events/access-tenant-snapshots,http://agent-service:8083/internal/v1/events/access-tenant-snapshots,http://integration-service:8087/internal/v1/events/access-tenant-snapshots,http://knowledge-service:8085/internal/v1/events/access-tenant-snapshots";
const MULTI_EDGE_TOKENS = {
  ACCESS_TO_CHANNEL_TOKEN: CHANNEL_TOKEN,
  ACCESS_TO_PULSO_TOKEN: PULSO_TOKEN,
  ACCESS_TO_SOFIA_TOKEN: SOFIA_TOKEN,
  ACCESS_TO_INTEGRATION_TOKEN: INTEGRATION_TOKEN,
  ACCESS_TO_KNOWLEDGE_TOKEN: KNOWLEDGE_TOKEN
} as const;

describe("Access tenant snapshot producer", () => {
  it("locks each tenant and persists the outbox before its monotonic watermark", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const transaction = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql: normalizeSql(sql), values });
        if (sql.includes("from platform.tenants tenant")) {
          return { rows: [{ tenantId: TENANT_ID, status: "paused", sourceUpdatedAt: SOURCE_UPDATED_AT }] };
        }
        if (sql.includes("from access_runtime.tenant_projection_state")) {
          return { rows: [{ sourceVersion: "41", payloadHash: "0".repeat(64) }] };
        }
        return { rows: [] };
      })
    };

    await expect(enqueueAccessTenantSnapshot(transaction as never, TENANT_ID)).resolves.toEqual({ eventsEnqueued: 1 });

    const lock = calls.find((call) => call.sql.includes("pg_advisory_xact_lock"));
    expect(lock?.values).toEqual([`access:tenant-snapshot:${TENANT_ID}`]);
    const outboxIndex = calls.findIndex((call) =>
      call.sql.startsWith("insert into access_runtime.tenant_projection_outbox")
    );
    const stateIndex = calls.findIndex((call) => call.sql.startsWith("update access_runtime.tenant_projection_state"));
    expect(outboxIndex).toBeGreaterThan(0);
    expect(stateIndex).toBeGreaterThan(outboxIndex);
    expect(calls[outboxIndex]?.values?.slice(1, 5)).toEqual([TENANT_ID, 42, "access.tenant.snapshot.v1", 1]);
    expect(JSON.parse(String(calls[outboxIndex]?.values?.[5]))).toEqual({
      tenantId: TENANT_ID,
      status: "paused",
      sourceVersion: 42,
      sourceUpdatedAt: SOURCE_UPDATED_AT
    });
  });

  it("advances only the observed watermark when the strict payload is unchanged", async () => {
    let storedHash: string | undefined;
    const first = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("from platform.tenants tenant")) {
          return { rows: [{ tenantId: TENANT_ID, status: "active", sourceUpdatedAt: SOURCE_UPDATED_AT }] };
        }
        if (sql.includes("from access_runtime.tenant_projection_state")) return { rows: [] };
        if (sql.startsWith("insert into access_runtime.tenant_projection_state")) {
          storedHash = String(values?.[3]);
        }
        return { rows: [] };
      })
    };
    await enqueueAccessTenantSnapshot(first as never, TENANT_ID);

    const calls: string[] = [];
    const unchanged = {
      query: vi.fn(async (sql: string) => {
        calls.push(normalizeSql(sql));
        if (sql.includes("from platform.tenants tenant")) {
          return {
            rows: [{ tenantId: TENANT_ID, status: "active", sourceUpdatedAt: "2026-07-18T12:01:00.000Z" }]
          };
        }
        return sql.includes("from access_runtime.tenant_projection_state")
          ? { rows: [{ sourceVersion: "99", payloadHash: storedHash }] }
          : { rows: [] };
      })
    };
    await expect(enqueueAccessTenantSnapshot(unchanged as never, TENANT_ID)).resolves.toEqual({ eventsEnqueued: 0 });
    expect(calls.some((sql) => sql.startsWith("insert into access_runtime.tenant_projection_outbox"))).toBe(false);
    expect(calls.some((sql) => sql.includes("greatest(source_updated_at"))).toBe(true);
  });

  it("selects every stale customer tenant while excluding the Access bootstrap registry", async () => {
    const sql: string[] = [];
    let transactionCount = 0;
    const db = {
      query,
      transaction: async (work: (transaction: { query: typeof query }) => Promise<unknown>) => {
        transactionCount += 1;
        return work({ query });
      }
    };
    async function query(text: string, values?: unknown[]) {
      sql.push(normalizeSql(text));
      if (text.includes("left join access_runtime.tenant_projection_state")) {
        return {
          rows: [{ tenantId: TENANT_ID }, { tenantId: "33333333-3333-4333-8333-333333333333" }]
        };
      }
      if (text.includes("from platform.tenants tenant")) {
        return {
          rows: [
            {
              tenantId: String(values?.[0]),
              status: values?.[0] === TENANT_ID ? "active" : "archived",
              sourceUpdatedAt: SOURCE_UPDATED_AT
            }
          ]
        };
      }
      if (text.includes("from access_runtime.tenant_projection_state")) return { rows: [] };
      return { rows: [] };
    }

    await expect(reconcileAccessTenantSnapshots(db as never, 2)).resolves.toEqual({
      candidatesProcessed: 2,
      eventsEnqueued: 2,
      hasMore: false
    });
    expect(sql[0]).toContain("not exists ( select 1 from access_runtime.bootstrap_tenants bootstrap");
    expect(sql[0]).not.toContain("product_grants");
    expect(sql.filter((statement) => statement.includes("pg_advisory_xact_lock"))).toHaveLength(2);
    expect(transactionCount).toBe(2);
  });

  it("re-reads current tenant state after the lock instead of emitting a stale candidate snapshot", async () => {
    const outboxPayloads: unknown[] = [];
    const transaction = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("from platform.tenants tenant")) {
          return {
            rows: [
              {
                tenantId: TENANT_ID,
                status: "archived",
                sourceUpdatedAt: "2026-07-18T13:00:00.000Z"
              }
            ]
          };
        }
        if (sql.includes("from access_runtime.tenant_projection_state")) {
          return { rows: [{ sourceVersion: "8", payloadHash: "0".repeat(64) }] };
        }
        if (normalizeSql(sql).startsWith("insert into access_runtime.tenant_projection_outbox")) {
          outboxPayloads.push(JSON.parse(String(values?.[5])));
        }
        return { rows: [] };
      })
    };

    await expect(enqueueAccessTenantSnapshot(transaction as never, TENANT_ID)).resolves.toEqual({
      eventsEnqueued: 1
    });
    expect(outboxPayloads).toEqual([
      expect.objectContaining({ tenantId: TENANT_ID, status: "archived", sourceVersion: 9 })
    ]);
  });

  it("serializes reentrant reconciliation and bounds immediate follow-up pages", async () => {
    let release!: () => void;
    const firstPage = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstPage;
        return { candidatesProcessed: 2, eventsEnqueued: 2, hasMore: true };
      })
      .mockResolvedValueOnce({ candidatesProcessed: 1, eventsEnqueued: 0, hasMore: false });
    const reconciler = new AccessTenantProjectionReconciler({} as never, 10, 60_000, reconcile);

    const first = reconciler.reconcileOnce();
    const reentrant = reconciler.reconcileOnce();
    expect(reentrant).toBe(first);
    release();
    await expect(first).resolves.toEqual({ candidatesProcessed: 3, eventsEnqueued: 2, hasMore: false });
    expect(reconcile).toHaveBeenCalledTimes(2);
    await reconciler.stop();
  });
});

describe("Access tenant snapshot delivery configuration", () => {
  it("defaults to durable production with delivery disabled", () => {
    expect(readAccessTenantProjectionConfiguration({})).toEqual({
      transport: "disabled",
      reconcileLimit: 100,
      reconcileIntervalMs: 60_000
    });
  });

  it("validates exact HTTP endpoints and bounded reconciliation settings", () => {
    const configuration = readAccessTenantProjectionConfiguration({
      ACCESS_TENANT_SNAPSHOT_TRANSPORT: "http",
      ACCESS_TENANT_SNAPSHOT_HTTP_URL: "https://projection-consumer.example/internal/v1/events/access-tenants",
      ACCESS_TENANT_SNAPSHOT_HTTP_TOKEN: HTTP_TOKEN,
      DURABLE_EVENT_TRANSPORT: "http",
      ACCESS_TENANT_SNAPSHOT_RECONCILE_LIMIT: "25",
      ACCESS_TENANT_SNAPSHOT_RECONCILE_INTERVAL_MS: "5000"
    });
    expect(configuration).toMatchObject({ transport: "http", reconcileLimit: 25, reconcileIntervalMs: 5_000 });
    if (configuration.transport !== "http") throw new Error("expected http configuration");
    expect(configuration.destinationTokens.get(configuration.destinations[0]!)).toBe(HTTP_TOKEN);
    expect(() =>
      readAccessTenantProjectionConfiguration({
        ACCESS_TENANT_SNAPSHOT_TRANSPORT: "http",
        ACCESS_TENANT_SNAPSHOT_HTTP_URL: "https://projection-consumer.example/?token=secret",
        ACCESS_TENANT_SNAPSHOT_HTTP_TOKEN: HTTP_TOKEN
      })
    ).toThrow("exact HTTPS endpoint");
    expect(() =>
      readAccessTenantProjectionConfiguration({
        ACCESS_TENANT_SNAPSHOT_TRANSPORT: "disabled",
        ACCESS_TENANT_SNAPSHOT_RECONCILE_LIMIT: "1001"
      })
    ).toThrow("between 1 and 1000");
  });

  it("parses comma-separated HTTP destinations with distinct per-edge tokens", () => {
    const configuration = readAccessTenantProjectionConfiguration({
      ACCESS_TENANT_SNAPSHOT_TRANSPORT: "http",
      ACCESS_TENANT_SNAPSHOT_HTTP_URL: MULTI_EDGE_HTTP_URL,
      ...MULTI_EDGE_TOKENS,
      ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP: "true",
      HYPERION_ENVIRONMENT: "ci"
    });
    expect(configuration).toMatchObject({
      transport: "http",
      destinations: [
        "http://whatsapp-channel-service:8089/internal/v1/events/access-tenant-snapshots",
        "http://pulso-iris-service:8088/internal/v1/events/access-tenant-snapshots",
        "http://agent-service:8083/internal/v1/events/access-tenant-snapshots",
        "http://integration-service:8087/internal/v1/events/access-tenant-snapshots",
        "http://knowledge-service:8085/internal/v1/events/access-tenant-snapshots"
      ]
    });
    if (configuration.transport !== "http") throw new Error("expected http configuration");
    expect(configuration.destinationTokens.get(configuration.destinations[0]!)).toBe(CHANNEL_TOKEN);
    expect(configuration.destinationTokens.get(configuration.destinations[1]!)).toBe(PULSO_TOKEN);
    expect(configuration.destinationTokens.get(configuration.destinations[2]!)).toBe(SOFIA_TOKEN);
    expect(configuration.destinationTokens.get(configuration.destinations[3]!)).toBe(INTEGRATION_TOKEN);
    expect(configuration.destinationTokens.get(configuration.destinations[4]!)).toBe(KNOWLEDGE_TOKEN);
  });

  it("rejects reused destination tokens and shared fallback for multi-edge fan-out", () => {
    expect(() =>
      readAccessTenantProjectionConfiguration({
        ACCESS_TENANT_SNAPSHOT_TRANSPORT: "http",
        ACCESS_TENANT_SNAPSHOT_HTTP_URL: MULTI_EDGE_HTTP_URL,
        ACCESS_TO_CHANNEL_TOKEN: CHANNEL_TOKEN,
        ACCESS_TO_PULSO_TOKEN: CHANNEL_TOKEN,
        ACCESS_TO_SOFIA_TOKEN: SOFIA_TOKEN,
        ACCESS_TO_INTEGRATION_TOKEN: INTEGRATION_TOKEN,
        ACCESS_TO_KNOWLEDGE_TOKEN: KNOWLEDGE_TOKEN,
        ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP: "true",
        HYPERION_ENVIRONMENT: "ci"
      })
    ).toThrow("distinct secrets");
    expect(() =>
      readAccessTenantProjectionConfiguration({
        ACCESS_TENANT_SNAPSHOT_TRANSPORT: "http",
        ACCESS_TENANT_SNAPSHOT_HTTP_URL: MULTI_EDGE_HTTP_URL,
        ACCESS_TENANT_SNAPSHOT_HTTP_TOKEN: HTTP_TOKEN,
        ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP: "true",
        HYPERION_ENVIRONMENT: "ci"
      })
    ).toThrow("ACCESS_TO_CHANNEL_TOKEN");
  });

  it("allows plaintext only for an explicitly enabled private local or CI destination", () => {
    expect(
      readAccessTenantProjectionConfiguration({
        ACCESS_TENANT_SNAPSHOT_TRANSPORT: "http",
        ACCESS_TENANT_SNAPSHOT_HTTP_URL:
          "http://whatsapp-channel-service:8089/internal/v1/events/access-tenant-snapshots",
        ACCESS_TO_CHANNEL_TOKEN: CHANNEL_TOKEN,
        ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP: "true",
        HYPERION_ENVIRONMENT: "ci"
      })
    ).toMatchObject({ transport: "http", allowPrivateHttp: true });

    for (const invalidEnvironment of [
      {
        ACCESS_TENANT_SNAPSHOT_HTTP_URL:
          "http://whatsapp-channel-service:8089/internal/v1/events/access-tenant-snapshots",
        ACCESS_TO_CHANNEL_TOKEN: CHANNEL_TOKEN,
        HYPERION_ENVIRONMENT: "local"
      },
      {
        ACCESS_TENANT_SNAPSHOT_HTTP_URL:
          "http://projection-consumer.example/internal/v1/events/access-tenant-snapshots",
        ACCESS_TENANT_SNAPSHOT_HTTP_TOKEN: HTTP_TOKEN,
        ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP: "true",
        HYPERION_ENVIRONMENT: "ci"
      },
      {
        ACCESS_TENANT_SNAPSHOT_HTTP_URL:
          "https://projection-consumer.example/internal/v1/events/access-tenant-snapshots",
        ACCESS_TENANT_SNAPSHOT_HTTP_TOKEN: HTTP_TOKEN,
        ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP: "true",
        HYPERION_ENVIRONMENT: "production"
      }
    ]) {
      expect(() =>
        readAccessTenantProjectionConfiguration({
          ACCESS_TENANT_SNAPSHOT_TRANSPORT: "http",
          ...invalidEnvironment
        })
      ).toThrow();
    }
  });

  it("requires an authenticated credential-free JetStream configuration", () => {
    expect(
      readAccessTenantProjectionConfiguration({
        ACCESS_TENANT_SNAPSHOT_TRANSPORT: "jetstream",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_USERNAME: "access",
        NATS_PASSWORD: "access-jetstream-password-0001"
      })
    ).toMatchObject({ transport: "jetstream", natsUrl: "nats://nats:4222" });
    expect(() =>
      readAccessTenantProjectionConfiguration({
        ACCESS_TENANT_SNAPSHOT_TRANSPORT: "jetstream",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://user:secret@nats:4222",
        NATS_USERNAME: "access",
        NATS_PASSWORD: "access-jetstream-password-0001"
      })
    ).toThrow("credential-free");
  });
});

describe("Access tenant snapshot durable dispatch", () => {
  it("delivers the strict envelope over HTTP with the Identity workload assertion", async () => {
    const model = outboxDatabase();
    const destination = "https://consumer.example/internal/v1/events/access-tenants";
    const fetch: HttpOutboxFetch = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-hyperion-caller")).toBe("identity-service");
      expect(headers.get("authorization")).toBe(`Bearer ${HTTP_TOKEN}`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        id: EVENT_ID,
        type: "access.tenant.snapshot.v1",
        tenantId: TENANT_ID,
        payload: { tenantId: TENANT_ID, status: "active", sourceVersion: 7 }
      });
      return new Response(undefined, { status: 204 });
    });
    const workerId = "access-tenant-http-worker";
    const outbox = new PostgresAccessTenantProjectionOutbox(model.database as never, workerId, destination);
    const dispatcher = createAccessTenantProjectionHttpDispatcher(
      outbox,
      workerId,
      new Map([[destination, HTTP_TOKEN]]),
      fetch
    );

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(model.completed).toEqual([EVENT_ID]);
  });

  it("publishes the generic provider event to its exact JetStream subject", async () => {
    const model = outboxDatabase();
    const subjects: string[] = [];
    const sessionFactory: JetStreamSessionFactory = async () => ({
      publish: async (subject) => {
        subjects.push(subject);
        return { stream: "HYPERION_EVENTS", seq: 1, duplicate: false };
      },
      close: async () => undefined
    });
    const configuration = readAccessTenantProjectionConfiguration({
      ACCESS_TENANT_SNAPSHOT_TRANSPORT: "jetstream",
      DURABLE_EVENT_TRANSPORT: "jetstream",
      NATS_URL: "nats://nats:4222",
      NATS_USERNAME: "access",
      NATS_PASSWORD: "access-jetstream-password-0001"
    });
    if (configuration.transport !== "jetstream") throw new Error("expected JetStream configuration");
    const workerId = "access-tenant-js-worker";
    const outbox = new PostgresAccessTenantProjectionOutbox(model.database as never, workerId);
    const dispatcher = createAccessTenantProjectionJetStreamDispatcher(outbox, workerId, configuration, sessionFactory);

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(subjects).toEqual(["hyperion.events.access.tenant.snapshot.v1"]);
    await dispatcher.stop();
  });
});

describe("Access tenant snapshot dead-letter redrive", () => {
  it("requeues only the exact event and tenant without regenerating the payload", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [
        {
          eventId: EVENT_ID,
          tenantId: TENANT_ID,
          sourceVersion: "7",
          eventType: "access.tenant.snapshot.v1"
        }
      ]
    }));

    await expect(
      redriveAccessTenantProjectionDeadLetter({ query } as never, {
        eventId: EVENT_ID,
        tenantId: TENANT_ID
      })
    ).resolves.toEqual({
      eventId: EVENT_ID,
      tenantId: TENANT_ID,
      sourceVersion: 7,
      eventType: "access.tenant.snapshot.v1"
    });
    expect(normalizeSql(String(query.mock.calls[0]?.[0]))).toContain(
      "where id = $1 and tenant_id = $2 and status = 'dead_letter'"
    );
    expect(query.mock.calls[0]?.[1]).toEqual([EVENT_ID, TENANT_ID]);
    expect(normalizeSql(String(query.mock.calls[0]?.[0]))).not.toContain("payload =");
  });

  it("does not broaden a missing exact selector", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    await expect(
      redriveAccessTenantProjectionDeadLetter({ query } as never, {
        eventId: EVENT_ID,
        tenantId: TENANT_ID
      })
    ).resolves.toBeUndefined();
  });
});

describe("Access tenant snapshot backfill", () => {
  it("pages every customer tenant, enqueues gaps, and replays published current rows", async () => {
    const sql: string[] = [];
    let transactionCount = 0;
    const secondTenantId = "33333333-3333-4333-8333-333333333333";
    const db = {
      query: async (text: string, values?: unknown[]) => {
        sql.push(normalizeSql(text));
        if (text.includes("from platform.tenants tenant") && text.includes("order by tenant.updated_at")) {
          return { rows: [{ tenantId: TENANT_ID }, { tenantId: secondTenantId }] };
        }
        if (normalizeSql(text).includes("event_row.status = 'published'")) {
          return values?.[0] === TENANT_ID
            ? {
                rows: [
                  {
                    eventId: EVENT_ID,
                    tenantId: TENANT_ID,
                    sourceVersion: "7",
                    eventType: "access.tenant.snapshot.v1"
                  }
                ]
              }
            : { rows: [] };
        }
        return { rows: [] };
      },
      transaction: async (work: (transaction: { query: typeof query }) => Promise<unknown>) => {
        transactionCount += 1;
        return work({ query });
      }
    };
    async function query(text: string, values?: unknown[]) {
      sql.push(normalizeSql(text));
      if (text.includes("from platform.tenants tenant") && text.includes("tenant.id = $1")) {
        return {
          rows: [
            {
              tenantId: String(values?.[0]),
              status: "active",
              sourceUpdatedAt: SOURCE_UPDATED_AT
            }
          ]
        };
      }
      if (text.includes("from access_runtime.tenant_projection_state")) return { rows: [] };
      return { rows: [] };
    }

    await expect(backfillAccessTenantSnapshots(db as never, 2)).resolves.toEqual({
      candidatesProcessed: 2,
      eventsEnqueued: 2,
      replayed: 1,
      hasMore: false
    });
    expect(sql[0]).toContain("not exists ( select 1 from access_runtime.bootstrap_tenants bootstrap");
    expect(sql[0]).not.toContain("projection.source_updated_at < tenant.updated_at");
    expect(transactionCount).toBe(2);
    expect(sql.some((statement) => statement.includes("event_row.status = 'published'"))).toBe(true);
  });
});

describe("Access tenant snapshot recovery replay", () => {
  it("requeues only the current published event after the broker dedupe safety window", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rows: [
        {
          eventId: EVENT_ID,
          tenantId: TENANT_ID,
          sourceVersion: "7",
          eventType: "access.tenant.snapshot.v1"
        }
      ]
    }));

    await expect(replayCurrentAccessTenantProjection({ query } as never, { tenantId: TENANT_ID })).resolves.toEqual({
      eventId: EVENT_ID,
      tenantId: TENANT_ID,
      sourceVersion: 7,
      eventType: "access.tenant.snapshot.v1"
    });
    const sql = normalizeSql(String(query.mock.calls[0]?.[0]));
    expect(sql).toContain("state_row.source_version = event_row.source_version");
    expect(sql).toContain("event_row.status = 'published'");
    expect(sql).toContain("event_row.published_at <= now() - interval '3 minutes'");
    expect(sql).toContain("published_at = null");
    expect(sql).not.toContain("payload =");
    expect(query.mock.calls[0]?.[1]).toEqual([TENANT_ID]);
  });

  it("fails closed when no exact replayable current event exists", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    await expect(
      replayCurrentAccessTenantProjection({ query } as never, { tenantId: TENANT_ID })
    ).resolves.toBeUndefined();
  });
});

function outboxDatabase() {
  const completed: string[] = [];
  let claimed = false;
  return {
    completed,
    database: {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        const normalized = normalizeSql(sql);
        if (normalized.startsWith("with terminalized as")) {
          if (claimed) return { rows: [] };
          claimed = true;
          return {
            rows: [
              {
                id: EVENT_ID,
                tenantId: TENANT_ID,
                sourceVersion: "7",
                eventType: "access.tenant.snapshot.v1",
                eventVersion: 1,
                occurredAt: SOURCE_UPDATED_AT,
                payload: {
                  tenantId: TENANT_ID,
                  status: "active",
                  sourceVersion: 7,
                  sourceUpdatedAt: SOURCE_UPDATED_AT
                }
              }
            ]
          };
        }
        if (
          normalized.startsWith("update access_runtime.tenant_projection_outbox") &&
          normalized.includes("status = 'published'")
        ) {
          completed.push(String(values?.[0]));
        }
        return { rows: [] };
      })
    }
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}
