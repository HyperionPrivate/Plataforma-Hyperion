import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEmitter } from "./audit-client.js";
import { registerOperationsRoutes } from "./operations-routes.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const HANDOFF_ID = "30000000-0000-4000-8000-000000000001";
const NOW = "2026-07-14T12:00:00.000Z";
const apps: Array<ReturnType<typeof Fastify>> = [];
const originalNodeEnvironment = process.env.NODE_ENV;
const originalHyperionEnvironment = process.env.HYPERION_ENVIRONMENT;

describe("operations route audit transactions", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnvironment;
    if (originalHyperionEnvironment === undefined) delete process.env.HYPERION_ENVIRONMENT;
    else process.env.HYPERION_ENVIRONMENT = originalHyperionEnvironment;
  });

  it("hides simulation routes in canonical production even when NODE_ENV is test", async () => {
    process.env.NODE_ENV = "test";
    process.env.HYPERION_ENVIRONMENT = "production";
    const directQuery = vi.fn();
    const transaction = vi.fn();
    const emitAudit: AuditEmitter = vi.fn();
    const app = await createApp({ directQuery, transaction, emitAudit });

    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/simulation/appointments`,
      payload: { origin: "advisor" }
    });

    expect(response.statusCode).toBe(404);
    expect(directQuery).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(emitAudit).not.toHaveBeenCalled();
  });

  it("uses the exact mutation transaction executor for handoff audit enqueue", async () => {
    let committedStatus = "open";
    const transactionExecutor = {
      query: vi.fn(async () => ({ rows: [handoffRow("assigned")], rowCount: 1 }))
    };
    const transaction = vi.fn(async (work: (tx: typeof transactionExecutor) => Promise<unknown>) => {
      const result = await work(transactionExecutor);
      committedStatus = "assigned";
      return result;
    });
    const directQuery = vi.fn();
    const emitAudit: AuditEmitter = vi.fn(async (event, executor) => {
      expect(executor).toBe(transactionExecutor);
      expect(event).toMatchObject({
        tenantId: TENANT_ID,
        actorId: "operator-handoff",
        eventType: "handoff.assigned",
        entityId: HANDOFF_ID
      });
    });
    const app = await createApp({ directQuery, transaction, emitAudit });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/handoffs/${HANDOFF_ID}`,
      headers: { "x-operator-id": "operator-handoff" },
      payload: { status: "assigned" }
    });

    expect(response.statusCode).toBe(200);
    expect(committedStatus).toBe("assigned");
    expect(transaction).toHaveBeenCalledOnce();
    expect(transactionExecutor.query).toHaveBeenCalledOnce();
    expect(directQuery).not.toHaveBeenCalled();
    expect(emitAudit).toHaveBeenCalledOnce();
  });

  it("rolls back the handoff mutation when audit enqueue fails", async () => {
    let committedStatus = "open";
    let rolledBack = false;
    const transactionExecutor = {
      query: vi.fn(async () => ({ rows: [handoffRow("assigned")], rowCount: 1 }))
    };
    const transaction = vi.fn(async (work: (tx: typeof transactionExecutor) => Promise<unknown>) => {
      const pendingStatus = "assigned";
      try {
        const result = await work(transactionExecutor);
        committedStatus = pendingStatus;
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    const emitAudit: AuditEmitter = vi.fn(async (_event, executor) => {
      expect(executor).toBe(transactionExecutor);
      throw new Error("audit enqueue failed");
    });
    const app = await createApp({ directQuery: vi.fn(), transaction, emitAudit });

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/handoffs/${HANDOFF_ID}`,
      payload: { status: "assigned" }
    });

    expect(response.statusCode).toBe(500);
    expect(rolledBack).toBe(true);
    expect(committedStatus).toBe("open");
    expect(emitAudit).toHaveBeenCalledOnce();
  });

  it("rolls back appointment creation and its RPA action when audit enqueue fails", async () => {
    let appointmentCommitted = false;
    let rolledBack = false;
    const transactionExecutor = {
      query: vi.fn(async (sqlValue: unknown) => {
        const sql = String(sqlValue);
        if (sql.includes("insert into pulso_iris.appointments")) {
          return { rows: [appointmentRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    const transaction = vi.fn(async (work: (tx: typeof transactionExecutor) => Promise<unknown>) => {
      try {
        const result = await work(transactionExecutor);
        appointmentCommitted = true;
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    const emitAudit: AuditEmitter = vi.fn(async (event, executor) => {
      expect(executor).toBe(transactionExecutor);
      expect(event).toMatchObject({ eventType: "appointment.registered", entityId: HANDOFF_ID });
      throw new Error("audit enqueue failed");
    });
    const directQuery = vi.fn();
    const app = await createApp({ directQuery, transaction, emitAudit });

    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/simulation/appointments`,
      payload: { origin: "advisor" }
    });

    expect(response.statusCode).toBe(500);
    expect(rolledBack).toBe(true);
    expect(appointmentCommitted).toBe(false);
    expect(transactionExecutor.query).toHaveBeenCalledTimes(3);
    expect(directQuery).not.toHaveBeenCalled();
    expect(emitAudit).toHaveBeenCalledOnce();
  });
});

async function createApp(options: {
  directQuery: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  emitAudit: AuditEmitter;
}): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (String(sql).includes("pulso_iris.tenant_snapshots")) {
      return { rows: [{ status: "active", sourceVersion: "1" }], rowCount: 1 };
    }
    return options.directQuery(sql, params);
  });
  await registerOperationsRoutes(
    app,
    {
      db: {
        query,
        transaction: options.transaction,
        close: vi.fn()
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    } as never,
    options.emitAudit
  );
  apps.push(app);
  return app;
}

function handoffRow(status: "open" | "assigned") {
  return {
    id: HANDOFF_ID,
    tenantId: TENANT_ID,
    patientId: null,
    conversationId: null,
    triggerCode: "caso_sensible",
    priority: "medium",
    status,
    summary: "Caso de prueba",
    slaDueAt: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function appointmentRow() {
  return {
    id: HANDOFF_ID,
    tenantId: TENANT_ID,
    patientId: null,
    conversationId: null,
    siteId: null,
    professionalId: null,
    payerId: null,
    appointmentTypeId: null,
    appointmentType: null,
    origin: "advisor",
    status: "registered",
    scheduledAt: null,
    legacyReference: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}
