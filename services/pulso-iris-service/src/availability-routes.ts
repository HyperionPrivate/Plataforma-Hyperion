import { envelope, pulsoIrisAvailabilitySlotQuerySchema } from "@hyperion/contracts";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { listAvailabilitySlots } from "./availability-engine.js";
import { requireTenantDb } from "./shared.js";

const MAX_SLOT_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

export const registerAvailabilityRoutes: RouteRegistrar = (app, context) => {
  const base = "/v1/tenants/:tenantId/pulso-iris";

  app.get(`${base}/availability/slots`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const parsed = pulsoIrisAvailabilitySlotQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send(
        envelope(
          {
            error: "Invalid query",
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message
            }))
          },
          request.id
        )
      );
    }

    const from = parsed.data.from ? new Date(parsed.data.from) : new Date();
    let to = parsed.data.to ? new Date(parsed.data.to) : addDays(from, 14);
    const settings = await scope.db.query<{
      bookingHorizonDays: number;
      status: string;
      mode: string;
    }>(
      `select booking_horizon_days as "bookingHorizonDays", status, mode
       from pulso_iris.agenda_settings
       where tenant_id = $1`,
      [scope.tenantId]
    );
    const agenda = settings.rows[0];
    if (!agenda) {
      return reply.code(409).send(envelope({ error: "Agenda settings are not configured" }, request.id));
    }
    if (agenda.status !== "active") {
      return reply.code(409).send(envelope({ error: "Agenda is paused" }, request.id));
    }
    if (agenda.mode === "legacy_integrated") {
      return reply.code(409).send(envelope({ error: "Legacy integrated mode requires a real provider" }, request.id));
    }

    const horizonEnd = addDays(new Date(), agenda.bookingHorizonDays);
    if (!parsed.data.to && to > horizonEnd) {
      to = horizonEnd;
    }

    if (to.getTime() <= from.getTime()) {
      return reply.code(400).send(envelope({ error: "to must be after from" }, request.id));
    }

    if (to.getTime() - from.getTime() > MAX_SLOT_RANGE_MS) {
      return reply.code(400).send(envelope({ error: "Slot query range cannot exceed 31 days" }, request.id));
    }

    if (from.getTime() >= horizonEnd.getTime() || to.getTime() > horizonEnd.getTime()) {
      return reply.code(400).send(envelope({ error: "Slot query exceeds booking horizon" }, request.id));
    }

    const slots = await listAvailabilitySlots(scope.db, {
      tenantId: scope.tenantId,
      from,
      to,
      siteId: parsed.data.siteId,
      professionalId: parsed.data.professionalId,
      appointmentTypeId: parsed.data.appointmentTypeId,
      payerId: parsed.data.payerId,
      includeFull: parsed.data.includeFull
    });

    return envelope(slots, request.id);
  });
};

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
