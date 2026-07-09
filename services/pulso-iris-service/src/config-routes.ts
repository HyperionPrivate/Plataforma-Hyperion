import {
  envelope,
  pulsoIrisAgendaBlockInputSchema,
  pulsoIrisAgendaBlockListSchema,
  pulsoIrisAvailabilityRuleInputSchema,
  pulsoIrisAvailabilityRuleListSchema,
  pulsoIrisAppointmentTypeInputSchema,
  pulsoIrisAppointmentTypeListSchema,
  pulsoIrisPayerInputSchema,
  pulsoIrisPayerListSchema,
  pulsoIrisProfessionalInputSchema,
  pulsoIrisProfessionalListSchema,
  pulsoIrisSiteInputSchema,
  pulsoIrisSiteListSchema
} from "@hyperion/contracts";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import type { FastifyReply } from "fastify";
import {
  ensureTenantReferences,
  mapDatabaseError,
  parseBody,
  readUuidParam,
  requireTenantDb,
  sendReferenceError
} from "./shared.js";

const SITE_COLUMNS = `
  id,
  tenant_id as "tenantId",
  name,
  city,
  address,
  phone,
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const PROFESSIONAL_COLUMNS = `
  id,
  tenant_id as "tenantId",
  name,
  professional_type as "professionalType",
  subspecialty,
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const PAYER_COLUMNS = `
  id,
  tenant_id as "tenantId",
  name,
  payer_group as "group",
  requires_authorization as "requiresAuthorization",
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const APPOINTMENT_TYPE_COLUMNS = `
  id,
  tenant_id as "tenantId",
  name,
  category,
  duration_min as "durationMin",
  preparation_text as "preparationText",
  bookable_by_ia as "bookableByIa",
  slot_priority as "slotPriority",
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const AVAILABILITY_RULE_COLUMNS = `
  id,
  tenant_id as "tenantId",
  site_id as "siteId",
  professional_id as "professionalId",
  appointment_type_id as "appointmentTypeId",
  weekday::int as weekday,
  to_char(starts_at, 'HH24:MI:SS') as "startsAt",
  to_char(ends_at, 'HH24:MI:SS') as "endsAt",
  slot_duration_min as "slotDurationMin",
  capacity,
  timezone,
  effective_from::text as "effectiveFrom",
  effective_to::text as "effectiveTo",
  status,
  notes,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const AGENDA_BLOCK_COLUMNS = `
  id,
  tenant_id as "tenantId",
  site_id as "siteId",
  professional_id as "professionalId",
  appointment_type_id as "appointmentTypeId",
  starts_at as "startsAt",
  ends_at as "endsAt",
  reason,
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export const registerConfigRoutes: RouteRegistrar = (app, context) => {
  const base = "/v1/tenants/:tenantId/pulso-iris/config";

  // ----- Sedes -----

  app.get(`${base}/sites`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select ${SITE_COLUMNS} from pulso_iris.sites where tenant_id = $1 order by name`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisSiteListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/sites`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisSiteInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.sites (tenant_id, name, city, address, phone, status)
       values ($1, $2, $3, $4, $5, coalesce($6, 'active'))
       returning ${SITE_COLUMNS}`,
      [scope.tenantId, input.name, input.city ?? null, input.address ?? null, input.phone ?? null, input.status ?? null]
    );
    return reply.code(201).send(envelope(pulsoIrisSiteListSchema.parse(result.rows)[0], request.id));
  });

  app.patch(`${base}/sites/:siteId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const siteId = readUuidParam(request.params, "siteId");
    if (!siteId) {
      return reply.code(400).send(envelope({ error: "siteId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisSiteInputSchema.partial(), request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.sites set
         name = coalesce($3, name),
         city = coalesce($4, city),
         address = coalesce($5, address),
         phone = coalesce($6, phone),
         status = coalesce($7, status),
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning ${SITE_COLUMNS}`,
      [
        scope.tenantId,
        siteId,
        input.name ?? null,
        input.city ?? null,
        input.address ?? null,
        input.phone ?? null,
        input.status ?? null
      ]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Site not found" }, request.id));
    }
    return envelope(pulsoIrisSiteListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Profesionales -----

  app.get(`${base}/professionals`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select ${PROFESSIONAL_COLUMNS} from pulso_iris.professionals where tenant_id = $1 order by name`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisProfessionalListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/professionals`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisProfessionalInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.professionals (tenant_id, name, professional_type, subspecialty, status)
       values ($1, $2, $3, $4, coalesce($5, 'active'))
       returning ${PROFESSIONAL_COLUMNS}`,
      [scope.tenantId, input.name, input.professionalType, input.subspecialty ?? null, input.status ?? null]
    );
    return reply.code(201).send(envelope(pulsoIrisProfessionalListSchema.parse(result.rows)[0], request.id));
  });

  app.patch(`${base}/professionals/:professionalId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const professionalId = readUuidParam(request.params, "professionalId");
    if (!professionalId) {
      return reply.code(400).send(envelope({ error: "professionalId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisProfessionalInputSchema.partial(), request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.professionals set
         name = coalesce($3, name),
         professional_type = coalesce($4, professional_type),
         subspecialty = coalesce($5, subspecialty),
         status = coalesce($6, status),
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning ${PROFESSIONAL_COLUMNS}`,
      [
        scope.tenantId,
        professionalId,
        input.name ?? null,
        input.professionalType ?? null,
        input.subspecialty ?? null,
        input.status ?? null
      ]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Professional not found" }, request.id));
    }
    return envelope(pulsoIrisProfessionalListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Convenios -----

  app.get(`${base}/payers`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select ${PAYER_COLUMNS} from pulso_iris.payers where tenant_id = $1 order by payer_group, name`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisPayerListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/payers`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisPayerInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.payers (tenant_id, name, payer_group, requires_authorization, status)
       values ($1, $2, $3, coalesce($4, false), coalesce($5, 'active'))
       returning ${PAYER_COLUMNS}`,
      [scope.tenantId, input.name, input.group, input.requiresAuthorization ?? null, input.status ?? null]
    );
    return reply.code(201).send(envelope(pulsoIrisPayerListSchema.parse(result.rows)[0], request.id));
  });

  app.patch(`${base}/payers/:payerId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const payerId = readUuidParam(request.params, "payerId");
    if (!payerId) {
      return reply.code(400).send(envelope({ error: "payerId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisPayerInputSchema.partial(), request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.payers set
         name = coalesce($3, name),
         payer_group = coalesce($4, payer_group),
         requires_authorization = coalesce($5, requires_authorization),
         status = coalesce($6, status),
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning ${PAYER_COLUMNS}`,
      [
        scope.tenantId,
        payerId,
        input.name ?? null,
        input.group ?? null,
        input.requiresAuthorization ?? null,
        input.status ?? null
      ]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Payer not found" }, request.id));
    }
    return envelope(pulsoIrisPayerListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Tipos de cita -----

  app.get(`${base}/appointment-types`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select ${APPOINTMENT_TYPE_COLUMNS}
       from pulso_iris.appointment_types
       where tenant_id = $1
       order by category, slot_priority, name`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisAppointmentTypeListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/appointment-types`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisAppointmentTypeInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.appointment_types
         (tenant_id, name, category, duration_min, preparation_text, bookable_by_ia, slot_priority, status)
       values ($1, $2, $3, coalesce($4, 20), $5, coalesce($6, true), coalesce($7, 50), coalesce($8, 'active'))
       returning ${APPOINTMENT_TYPE_COLUMNS}`,
      [
        scope.tenantId,
        input.name,
        input.category,
        input.durationMin ?? null,
        input.preparationText ?? null,
        input.bookableByIa ?? null,
        input.slotPriority ?? null,
        input.status ?? null
      ]
    );
    return reply.code(201).send(envelope(pulsoIrisAppointmentTypeListSchema.parse(result.rows)[0], request.id));
  });

  app.patch(`${base}/appointment-types/:appointmentTypeId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const appointmentTypeId = readUuidParam(request.params, "appointmentTypeId");
    if (!appointmentTypeId) {
      return reply.code(400).send(envelope({ error: "appointmentTypeId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisAppointmentTypeInputSchema.partial(), request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.appointment_types set
         name = coalesce($3, name),
         category = coalesce($4, category),
         duration_min = coalesce($5, duration_min),
         preparation_text = coalesce($6, preparation_text),
         bookable_by_ia = coalesce($7, bookable_by_ia),
         slot_priority = coalesce($8, slot_priority),
         status = coalesce($9, status),
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning ${APPOINTMENT_TYPE_COLUMNS}`,
      [
        scope.tenantId,
        appointmentTypeId,
        input.name ?? null,
        input.category ?? null,
        input.durationMin ?? null,
        input.preparationText ?? null,
        input.bookableByIa ?? null,
        input.slotPriority ?? null,
        input.status ?? null
      ]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Appointment type not found" }, request.id));
    }
    return envelope(pulsoIrisAppointmentTypeListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Disponibilidad y capacidad -----

  app.get(`${base}/availability-rules`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select ${AVAILABILITY_RULE_COLUMNS}
       from pulso_iris.availability_rules
       where tenant_id = $1
       order by weekday, starts_at, created_at`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisAvailabilityRuleListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/availability-rules`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisAvailabilityRuleInputSchema, request, reply);
    if (!input) return;

    if (!isTimeRange(input.startsAt, input.endsAt)) {
      return reply.code(400).send(envelope({ error: "endsAt must be after startsAt" }, request.id));
    }

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.siteId, table: "pulso_iris.sites", label: "siteId" },
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
    ]);
    if (referenceError) {
      return sendReferenceError(reply, request, referenceError.label);
    }

    try {
      const result = await scope.db.query(
        `insert into pulso_iris.availability_rules
           (tenant_id, site_id, professional_id, appointment_type_id, weekday, starts_at, ends_at,
            slot_duration_min, capacity, timezone, effective_from, effective_to, status, notes)
         values ($1, $2, $3, $4, $5, $6::time, $7::time, coalesce($8, 20), coalesce($9, 1),
           coalesce($10, 'America/Bogota'), $11::date, $12::date, coalesce($13, 'active'), $14)
         returning ${AVAILABILITY_RULE_COLUMNS}`,
        [
          scope.tenantId,
          input.siteId,
          input.professionalId,
          input.appointmentTypeId,
          input.weekday,
          input.startsAt,
          input.endsAt,
          input.slotDurationMin ?? null,
          input.capacity ?? null,
          input.timezone ?? null,
          input.effectiveFrom ?? null,
          input.effectiveTo ?? null,
          input.status ?? null,
          input.notes ?? null
        ]
      );
      return reply.code(201).send(envelope(pulsoIrisAvailabilityRuleListSchema.parse(result.rows)[0], request.id));
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  app.patch(`${base}/availability-rules/:ruleId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const ruleId = readUuidParam(request.params, "ruleId");
    if (!ruleId) {
      return reply.code(400).send(envelope({ error: "ruleId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisAvailabilityRuleInputSchema.partial(), request, reply);
    if (!input) return;

    if (input.startsAt && input.endsAt && !isTimeRange(input.startsAt, input.endsAt)) {
      return reply.code(400).send(envelope({ error: "endsAt must be after startsAt" }, request.id));
    }

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.siteId, table: "pulso_iris.sites", label: "siteId" },
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
    ]);
    if (referenceError) {
      return sendReferenceError(reply, request, referenceError.label);
    }

    try {
      const result = await scope.db.query(
        `update pulso_iris.availability_rules set
           site_id = coalesce($3, site_id),
           professional_id = coalesce($4, professional_id),
           appointment_type_id = coalesce($5, appointment_type_id),
           weekday = coalesce($6, weekday),
           starts_at = coalesce($7::time, starts_at),
           ends_at = coalesce($8::time, ends_at),
           slot_duration_min = coalesce($9, slot_duration_min),
           capacity = coalesce($10, capacity),
           timezone = coalesce($11, timezone),
           effective_from = coalesce($12::date, effective_from),
           effective_to = coalesce($13::date, effective_to),
           status = coalesce($14, status),
           notes = coalesce($15, notes),
           updated_at = now()
         where tenant_id = $1 and id = $2
         returning ${AVAILABILITY_RULE_COLUMNS}`,
        [
          scope.tenantId,
          ruleId,
          input.siteId ?? null,
          input.professionalId ?? null,
          input.appointmentTypeId ?? null,
          input.weekday ?? null,
          input.startsAt ?? null,
          input.endsAt ?? null,
          input.slotDurationMin ?? null,
          input.capacity ?? null,
          input.timezone ?? null,
          input.effectiveFrom ?? null,
          input.effectiveTo ?? null,
          input.status ?? null,
          input.notes ?? null
        ]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send(envelope({ error: "Availability rule not found" }, request.id));
      }
      return envelope(pulsoIrisAvailabilityRuleListSchema.parse(result.rows)[0], request.id);
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  // ----- Bloqueos y excepciones de agenda -----

  app.get(`${base}/agenda-blocks`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select ${AGENDA_BLOCK_COLUMNS}
       from pulso_iris.agenda_blocks
       where tenant_id = $1
       order by starts_at desc
       limit 200`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisAgendaBlockListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/agenda-blocks`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisAgendaBlockInputSchema, request, reply);
    if (!input) return;

    if (!isDateTimeRange(input.startsAt, input.endsAt)) {
      return reply.code(400).send(envelope({ error: "endsAt must be after startsAt" }, request.id));
    }

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.siteId, table: "pulso_iris.sites", label: "siteId" },
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
    ]);
    if (referenceError) {
      return sendReferenceError(reply, request, referenceError.label);
    }

    try {
      const result = await scope.db.query(
        `insert into pulso_iris.agenda_blocks
           (tenant_id, site_id, professional_id, appointment_type_id, starts_at, ends_at, reason, status)
         values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, coalesce($8, 'active'))
         returning ${AGENDA_BLOCK_COLUMNS}`,
        [
          scope.tenantId,
          input.siteId ?? null,
          input.professionalId ?? null,
          input.appointmentTypeId ?? null,
          input.startsAt,
          input.endsAt,
          input.reason,
          input.status ?? null
        ]
      );
      return reply.code(201).send(envelope(pulsoIrisAgendaBlockListSchema.parse(result.rows)[0], request.id));
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  app.patch(`${base}/agenda-blocks/:blockId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const blockId = readUuidParam(request.params, "blockId");
    if (!blockId) {
      return reply.code(400).send(envelope({ error: "blockId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisAgendaBlockInputSchema.partial(), request, reply);
    if (!input) return;

    if (input.startsAt && input.endsAt && !isDateTimeRange(input.startsAt, input.endsAt)) {
      return reply.code(400).send(envelope({ error: "endsAt must be after startsAt" }, request.id));
    }

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.siteId, table: "pulso_iris.sites", label: "siteId" },
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
    ]);
    if (referenceError) {
      return sendReferenceError(reply, request, referenceError.label);
    }

    try {
      const result = await scope.db.query(
        `update pulso_iris.agenda_blocks set
           site_id = coalesce($3, site_id),
           professional_id = coalesce($4, professional_id),
           appointment_type_id = coalesce($5, appointment_type_id),
           starts_at = coalesce($6::timestamptz, starts_at),
           ends_at = coalesce($7::timestamptz, ends_at),
           reason = coalesce($8, reason),
           status = coalesce($9, status),
           updated_at = now()
         where tenant_id = $1 and id = $2
         returning ${AGENDA_BLOCK_COLUMNS}`,
        [
          scope.tenantId,
          blockId,
          input.siteId ?? null,
          input.professionalId ?? null,
          input.appointmentTypeId ?? null,
          input.startsAt ?? null,
          input.endsAt ?? null,
          input.reason ?? null,
          input.status ?? null
        ]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send(envelope({ error: "Agenda block not found" }, request.id));
      }
      return envelope(pulsoIrisAgendaBlockListSchema.parse(result.rows)[0], request.id);
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });
};

function isTimeRange(startsAt: string, endsAt: string): boolean {
  return toMinutes(endsAt) > toMinutes(startsAt);
}

function toMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function isDateTimeRange(startsAt: string, endsAt: string): boolean {
  return new Date(endsAt).getTime() > new Date(startsAt).getTime();
}

function sendDatabaseConfigError(error: unknown, reply: FastifyReply, requestId: string) {
  const mapped = mapDatabaseError(error);
  if (mapped) {
    return reply.code(mapped.statusCode).send(envelope({ error: mapped.message }, requestId));
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code?: unknown }).code) === "23514"
  ) {
    return reply.code(400).send(envelope({ error: "Invalid availability rule range or capacity" }, requestId));
  }
  throw error;
}
