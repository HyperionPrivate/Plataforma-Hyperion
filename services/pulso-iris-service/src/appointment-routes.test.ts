import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppointmentRoutes } from "./appointment-routes.js";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const PATIENT_ID = "10000000-0000-4000-8000-000000000002";
const SITE_ID = "10000000-0000-4000-8000-000000000003";
const PROFESSIONAL_ID = "10000000-0000-4000-8000-000000000004";
const APPOINTMENT_TYPE_ID = "10000000-0000-4000-8000-000000000005";
const HOLD_ID = "10000000-0000-4000-8000-000000000006";
const APPOINTMENT_ID = "10000000-0000-4000-8000-000000000007";

const ACTIVE_SETTINGS = {
  mode: "internal" as const,
  bookingHorizonDays: 90,
  holdDurationMinutes: 15,
  maxAlternatives: 3,
  maxReschedules: 2,
  externalConfirmationSlaMinutes: 60,
  externalReferenceRequired: false,
  status: "active" as const
};

const APPOINTMENT_ROW = {
  id: APPOINTMENT_ID,
  tenantId: TENANT_ID,
  patientId: PATIENT_ID,
  conversationId: null,
  siteId: SITE_ID,
  professionalId: PROFESSIONAL_ID,
  payerId: null,
  appointmentTypeId: APPOINTMENT_TYPE_ID,
  appointmentType: null,
  scheduledAt: "2026-08-01T14:00:00.000Z",
  status: "verified",
  origin: "advisor",
  holdId: HOLD_ID,
  idempotencyKey: "book-1",
  previousAppointmentId: null,
  externalReference: null,
  externalSlaDueAt: null,
  metadata: {},
  createdAt: "2026-07-23T12:00:00.000Z",
  updatedAt: "2026-07-23T12:00:00.000Z"
};

let transactionActive = false;
let reserveInTransaction = false;
let verifyInTransaction = false;

vi.mock("./internal-agenda-provider.js", () => ({
  InternalAgendaProvider: class {
    async reserve() {
      reserveInTransaction = transactionActive;
      return {
        hold: { id: HOLD_ID, tenantId: TENANT_ID },
        idempotent: false,
        expiredHolds: []
      };
    }

    async verify() {
      verifyInTransaction = transactionActive;
      return {
        appointment: { id: APPOINTMENT_ID },
        idempotent: false
      };
    }
  }
}));

describe("POST /appointments without holdId", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    reserveInTransaction = false;
    verifyInTransaction = false;
    transactionActive = false;
  });

  it("reserves and completes inside a single database transaction", async () => {
    const transaction = vi.fn(async (work: (client: { query: typeof query }) => Promise<unknown>) => {
      transactionActive = true;
      try {
        return await work({ query });
      } finally {
        transactionActive = false;
      }
    });
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.toLowerCase();
      if (normalized.includes("pulso_iris.tenant_snapshots")) {
        return { rows: [{ status: "active", sourceVersion: "1" }] };
      }
      if (normalized.includes("from pulso_iris.agenda_settings")) {
        return { rows: [ACTIVE_SETTINGS] };
      }
      if (normalized.includes("select exists(")) {
        return { rows: [{ exists: true }] };
      }
      if (normalized.includes("from pulso_iris.professional_payer_exclusions")) {
        return { rows: [{ exists: false }] };
      }
      if (normalized.includes("from pulso_iris.appointments where tenant_id")) {
        return { rows: [APPOINTMENT_ROW] };
      }
      return { rows: [], rowCount: 0 };
    });

    const app = Fastify();
    apps.push(app);
    await registerAppointmentRoutes(
      app,
      {
        db: { query, transaction, close: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
      } as never
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/appointments`,
      payload: {
        patientId: PATIENT_ID,
        siteId: SITE_ID,
        professionalId: PROFESSIONAL_ID,
        appointmentTypeId: APPOINTMENT_TYPE_ID,
        scheduledAt: "2026-08-01T14:00:00.000Z",
        idempotencyKey: "book-1"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reserveInTransaction).toBe(true);
    expect(verifyInTransaction).toBe(true);
  });
});
