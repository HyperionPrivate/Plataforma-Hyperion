import {
  envelope,
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
import { parseBody, readUuidParam, requireTenantDb } from "./shared.js";

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
};
