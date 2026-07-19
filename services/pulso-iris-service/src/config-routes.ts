import {
  pulsoIrisAgendaBlockInputSchema,
  pulsoIrisAgendaBlockListSchema,
  pulsoIrisAgendaSettingsPatchSchema,
  pulsoIrisAgendaSettingsSchema,
  pulsoIrisAgendaStatusSchema,
  pulsoIrisAvailabilityRuleInputSchema,
  pulsoIrisAvailabilityRuleListSchema,
  pulsoIrisAppointmentTypeInputSchema,
  pulsoIrisAppointmentTypeListSchema,
  pulsoIrisConfigurationImportApplyInputSchema,
  pulsoIrisConfigurationImportApplyResultSchema,
  pulsoIrisConfigurationImportPreviewInputSchema,
  pulsoIrisConfigurationImportPreviewSchema,
  pulsoIrisHolidayInputSchema,
  pulsoIrisHolidayListSchema,
  pulsoIrisPayerExclusionInputSchema,
  pulsoIrisPayerExclusionListSchema,
  pulsoIrisPayerInputSchema,
  pulsoIrisPayerListSchema,
  pulsoIrisProfessionalInputSchema,
  pulsoIrisProfessionalListSchema,
  pulsoIrisProfessionalAppointmentTypeInputSchema,
  pulsoIrisProfessionalAppointmentTypeListSchema,
  pulsoIrisProfessionalSiteInputSchema,
  pulsoIrisProfessionalSiteListSchema,
  pulsoIrisSiteInputSchema,
  pulsoIrisSiteListSchema
} from "@hyperion/pulso-contracts";
import { envelope } from "@hyperion/platform-contracts";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AgendaCsvError,
  agendaImportTemplate,
  applyAgendaImport,
  exportAgendaResource,
  parseAgendaImportResource,
  previewAgendaImport
} from "./agenda-config-csv.js";
import { ensureAgendaSettingsExist } from "./agenda-settings.js";
import type { AuditEmitter } from "./audit-client.js";
import { readOperatorId } from "./audit-client.js";
import {
  ensureTenantReferences,
  mapDatabaseError,
  parseBody,
  readUuidParam,
  requireTenantDb,
  sendReferenceError
} from "./shared.js";

type Database = NonNullable<ServiceContext["db"]>;
type TransactionExecutor = Parameters<Parameters<Database["transaction"]>[0]>[0];

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
  is_pilot as "isPilot",
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
  block_type as "blockType",
  reason,
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const HOLIDAY_COLUMNS = `
  id,
  tenant_id as "tenantId",
  holiday_date::text as "holidayDate",
  name,
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const PAYER_EXCLUSION_COLUMNS = `
  id,
  tenant_id as "tenantId",
  professional_id as "professionalId",
  payer_id as "payerId",
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const AGENDA_SETTINGS_COLUMNS = `
  tenant_id as "tenantId",
  mode,
  timezone,
  booking_horizon_days as "bookingHorizonDays",
  hold_duration_minutes as "holdDurationMinutes",
  max_alternatives as "maxAlternatives",
  max_reschedules as "maxReschedules",
  external_confirmation_sla_minutes as "externalConfirmationSlaMinutes",
  external_reference_required as "externalReferenceRequired",
  capacity_policy as "capacityPolicy",
  status,
  updated_by as "updatedBy",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const PROFESSIONAL_SITE_COLUMNS = `
  id,
  tenant_id as "tenantId",
  professional_id as "professionalId",
  site_id as "siteId",
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const PROFESSIONAL_APPOINTMENT_TYPE_COLUMNS = `
  id,
  tenant_id as "tenantId",
  professional_id as "professionalId",
  appointment_type_id as "appointmentTypeId",
  status,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const relationPatchSchema = z.object({ status: pulsoIrisAgendaStatusSchema });

export async function registerConfigRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  emitAudit: AuditEmitter = async () => undefined
): Promise<void> {
  const base = "/v1/tenants/:tenantId/pulso-iris/config";

  const emitConfigUpdated = async (
    request: { id: string; headers: Record<string, unknown> | { [key: string]: unknown } },
    tenantId: string,
    entityType: string,
    entityId: string,
    transaction: TransactionExecutor
  ) => {
    await emitAudit(
      {
        tenantId,
        actorId: readOperatorId(request.headers as Record<string, unknown>),
        eventType: "config.updated",
        entityType,
        entityId,
        metadata: { requestId: request.id }
      },
      transaction
    );
  };

  // ----- Configuracion general de agenda -----

  app.get(`${base}/agenda-settings`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const settings = await ensureAgendaSettings(scope.db, scope.tenantId);
    return envelope(pulsoIrisAgendaSettingsSchema.parse(settings), request.id);
  });

  app.patch(`${base}/agenda-settings`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisAgendaSettingsPatchSchema, request, reply);
    if (!input) return;

    const current = await ensureAgendaSettings(scope.db, scope.tenantId);
    const effective = { ...current, ...input };
    if (!isValidTimeZone(effective.timezone)) {
      return reply.code(400).send(envelope({ error: "timezone must be a valid IANA timezone" }, request.id));
    }
    if (effective.mode === "hybrid_manual" && !effective.externalReferenceRequired) {
      return reply.code(422).send(envelope({ error: "hybrid_manual requires an external reference" }, request.id));
    }
    if (effective.mode === "legacy_integrated" && effective.status === "active") {
      return reply
        .code(422)
        .send(
          envelope(
            { error: "legacy_integrated cannot be active until a real agenda provider is configured" },
            request.id
          )
        );
    }

    const operatorId = readOperatorId(request.headers as Record<string, unknown>);
    const result = await scope.db.transaction(async (transaction) => {
      const updateResult = await transaction.query<AgendaSettingsRow>(
        `update pulso_iris.agenda_settings set
           mode = $3,
           timezone = $4,
           booking_horizon_days = $5,
           hold_duration_minutes = $6,
           max_alternatives = $7,
           max_reschedules = $8,
           external_confirmation_sla_minutes = $9,
           external_reference_required = $10,
           capacity_policy = $11,
           status = $12,
           updated_by = $2,
           updated_at = now()
         where tenant_id = $1
         returning ${AGENDA_SETTINGS_COLUMNS}`,
        [
          scope.tenantId,
          operatorId ?? null,
          effective.mode,
          effective.timezone,
          effective.bookingHorizonDays,
          effective.holdDurationMinutes,
          effective.maxAlternatives,
          effective.maxReschedules,
          effective.externalConfirmationSlaMinutes,
          effective.externalReferenceRequired,
          effective.capacityPolicy,
          effective.status
        ]
      );
      const updated = updateResult.rows[0];
      if (updated) {
        await emitAudit(
          {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: "agenda.settings.updated",
            entityType: "agenda_settings",
            entityId: scope.tenantId,
            metadata: {
              requestId: request.id,
              mode: updated.mode,
              status: updated.status
            }
          },
          transaction
        );
      }
      return updateResult;
    });
    const updated = result.rows[0];
    if (!updated) {
      return reply.code(404).send(envelope({ error: "Agenda settings not found" }, request.id));
    }
    return envelope(pulsoIrisAgendaSettingsSchema.parse(updated), request.id);
  });

  // ----- Relaciones profesional-sede y profesional-tipo de cita -----

  app.get(`${base}/professional-sites`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const result = await scope.db.query(
      `select ${PROFESSIONAL_SITE_COLUMNS}
       from pulso_iris.professional_sites
       where tenant_id = $1
       order by professional_id, site_id`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisProfessionalSiteListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/professional-sites`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisProfessionalSiteInputSchema, request, reply);
    if (!input) return;

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.siteId, table: "pulso_iris.sites", label: "siteId" }
    ]);
    if (referenceError) return sendReferenceError(reply, request, referenceError.label);

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const insertResult = await transaction.query(
          `insert into pulso_iris.professional_sites (tenant_id, professional_id, site_id, status)
           values ($1, $2, $3, coalesce($4, 'active'))
           returning ${PROFESSIONAL_SITE_COLUMNS}`,
          [scope.tenantId, input.professionalId, input.siteId, input.status ?? null]
        );
        const created = insertResult.rows[0] as { id?: string } | undefined;
        if (created?.id) {
          await emitConfigUpdated(request, scope.tenantId, "professional_site", created.id, transaction);
        }
        return insertResult;
      });
      return reply.code(201).send(envelope(pulsoIrisProfessionalSiteListSchema.parse(result.rows)[0], request.id));
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  app.patch(`${base}/professional-sites/:relationId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const relationId = readUuidParam(request.params, "relationId");
    if (!relationId) return reply.code(400).send(envelope({ error: "relationId must be a UUID" }, request.id));
    const input = parseBody(relationPatchSchema, request, reply);
    if (!input) return;

    const result = await scope.db.transaction(async (transaction) => {
      const updateResult = await transaction.query(
        `update pulso_iris.professional_sites
         set status = $3, updated_at = now()
         where tenant_id = $1 and id = $2
         returning ${PROFESSIONAL_SITE_COLUMNS}`,
        [scope.tenantId, relationId, input.status]
      );
      if (updateResult.rows.length > 0) {
        await emitConfigUpdated(request, scope.tenantId, "professional_site", relationId, transaction);
      }
      return updateResult;
    });
    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Professional-site relation not found" }, request.id));
    }
    return envelope(pulsoIrisProfessionalSiteListSchema.parse(result.rows)[0], request.id);
  });

  app.get(`${base}/professional-appointment-types`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const result = await scope.db.query(
      `select ${PROFESSIONAL_APPOINTMENT_TYPE_COLUMNS}
       from pulso_iris.professional_appointment_types
       where tenant_id = $1
       order by professional_id, appointment_type_id`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisProfessionalAppointmentTypeListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/professional-appointment-types`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisProfessionalAppointmentTypeInputSchema, request, reply);
    if (!input) return;

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
    ]);
    if (referenceError) return sendReferenceError(reply, request, referenceError.label);

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const insertResult = await transaction.query(
          `insert into pulso_iris.professional_appointment_types
             (tenant_id, professional_id, appointment_type_id, status)
           values ($1, $2, $3, coalesce($4, 'active'))
           returning ${PROFESSIONAL_APPOINTMENT_TYPE_COLUMNS}`,
          [scope.tenantId, input.professionalId, input.appointmentTypeId, input.status ?? null]
        );
        const created = insertResult.rows[0] as { id?: string } | undefined;
        if (created?.id) {
          await emitConfigUpdated(request, scope.tenantId, "professional_appointment_type", created.id, transaction);
        }
        return insertResult;
      });
      return reply
        .code(201)
        .send(envelope(pulsoIrisProfessionalAppointmentTypeListSchema.parse(result.rows)[0], request.id));
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  app.patch(`${base}/professional-appointment-types/:relationId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const relationId = readUuidParam(request.params, "relationId");
    if (!relationId) return reply.code(400).send(envelope({ error: "relationId must be a UUID" }, request.id));
    const input = parseBody(relationPatchSchema, request, reply);
    if (!input) return;

    const result = await scope.db.transaction(async (transaction) => {
      const updateResult = await transaction.query(
        `update pulso_iris.professional_appointment_types
         set status = $3, updated_at = now()
         where tenant_id = $1 and id = $2
         returning ${PROFESSIONAL_APPOINTMENT_TYPE_COLUMNS}`,
        [scope.tenantId, relationId, input.status]
      );
      if (updateResult.rows.length > 0) {
        await emitConfigUpdated(request, scope.tenantId, "professional_appointment_type", relationId, transaction);
      }
      return updateResult;
    });
    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Professional-appointment-type relation not found" }, request.id));
    }
    return envelope(pulsoIrisProfessionalAppointmentTypeListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Importacion y exportacion CSV -----

  app.get(`${base}/import/:resource/template`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const resource = readImportResource(request.params);
    if (!resource) return reply.code(404).send(envelope({ error: "Unsupported import resource" }, request.id));
    return envelope(agendaImportTemplate(resource), request.id);
  });

  app.post(`${base}/import/:resource/preview`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const resource = readImportResource(request.params);
    if (!resource) return reply.code(404).send(envelope({ error: "Unsupported import resource" }, request.id));
    const input = parseBody(pulsoIrisConfigurationImportPreviewInputSchema, request, reply);
    if (!input) return;

    try {
      const preview = await previewAgendaImport(scope.db, scope.tenantId, resource, input.csv);
      return envelope(pulsoIrisConfigurationImportPreviewSchema.parse(preview), request.id);
    } catch (error) {
      return sendAgendaCsvError(error, reply, request.id);
    }
  });

  app.post(`${base}/import/:resource/apply`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const resource = readImportResource(request.params);
    if (!resource) return reply.code(404).send(envelope({ error: "Unsupported import resource" }, request.id));
    const input = parseBody(pulsoIrisConfigurationImportApplyInputSchema, request, reply);
    if (!input) return;
    const operatorId = readOperatorId(request.headers as Record<string, unknown>);

    try {
      const applied = await scope.db.transaction(async (transaction) => {
        const importResult = await applyAgendaImport({
          db: asTransactionalDatabase(transaction),
          tenantId: scope.tenantId,
          resource,
          csv: input.csv,
          idempotencyKey: input.idempotencyKey,
          operatorId
        });
        if (!importResult.idempotent) {
          await emitAudit(
            {
              tenantId: scope.tenantId,
              actorId: operatorId,
              eventType: "agenda.configuration.imported",
              entityType: "configuration_import",
              entityId: importResult.importId,
              metadata: {
                requestId: request.id,
                resource,
                applied: importResult.applied,
                rejected: importResult.summary.rejected
              }
            },
            transaction
          );
        }
        return importResult;
      });
      return reply
        .code(applied.idempotent ? 200 : 201)
        .send(envelope(pulsoIrisConfigurationImportApplyResultSchema.parse(applied), request.id));
    } catch (error) {
      return sendAgendaCsvError(error, reply, request.id);
    }
  });

  app.get(`${base}/export/:resource`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const resource = readImportResource(request.params);
    if (!resource) return reply.code(404).send(envelope({ error: "Unsupported export resource" }, request.id));
    return envelope(await exportAgendaResource(scope.db, scope.tenantId, resource), request.id);
  });

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

    const result = await scope.db.transaction(async (transaction) => {
      const insertResult = await transaction.query(
        `insert into pulso_iris.sites (tenant_id, name, city, address, phone, status)
         values ($1, $2, $3, $4, $5, coalesce($6, 'active'))
         returning ${SITE_COLUMNS}`,
        [
          scope.tenantId,
          input.name,
          input.city ?? null,
          input.address ?? null,
          input.phone ?? null,
          input.status ?? null
        ]
      );
      const created = pulsoIrisSiteListSchema.parse(insertResult.rows)[0];
      if (created) {
        await emitConfigUpdated(request, scope.tenantId, "site", created.id, transaction);
      }
      return insertResult;
    });
    const created = pulsoIrisSiteListSchema.parse(result.rows)[0];
    return reply.code(201).send(envelope(created, request.id));
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

    const result = await scope.db.transaction(async (transaction) => {
      const updateResult = await transaction.query(
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
      if (updateResult.rows.length > 0) {
        await emitConfigUpdated(request, scope.tenantId, "site", siteId, transaction);
      }
      return updateResult;
    });

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

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const insertResult = await transaction.query(
          `insert into pulso_iris.professionals (tenant_id, name, professional_type, subspecialty, is_pilot, status)
           values ($1, $2, $3, $4, coalesce($5, false), coalesce($6, 'active'))
           returning ${PROFESSIONAL_COLUMNS}`,
          [
            scope.tenantId,
            input.name,
            input.professionalType,
            input.subspecialty ?? null,
            input.isPilot ?? null,
            input.status ?? null
          ]
        );
        const created = pulsoIrisProfessionalListSchema.parse(insertResult.rows)[0];
        if (created) {
          await emitConfigUpdated(request, scope.tenantId, "professional", created.id, transaction);
        }
        return insertResult;
      });
      const created = pulsoIrisProfessionalListSchema.parse(result.rows)[0];
      return reply.code(201).send(envelope(created, request.id));
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
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

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const updateResult = await transaction.query(
          `update pulso_iris.professionals set
             name = coalesce($3, name),
             professional_type = coalesce($4, professional_type),
             subspecialty = coalesce($5, subspecialty),
             is_pilot = coalesce($6, is_pilot),
             status = coalesce($7, status),
             updated_at = now()
           where tenant_id = $1 and id = $2
           returning ${PROFESSIONAL_COLUMNS}`,
          [
            scope.tenantId,
            professionalId,
            input.name ?? null,
            input.professionalType ?? null,
            input.subspecialty ?? null,
            input.isPilot ?? null,
            input.status ?? null
          ]
        );
        if (updateResult.rows.length > 0) {
          await emitConfigUpdated(request, scope.tenantId, "professional", professionalId, transaction);
        }
        return updateResult;
      });

      if (result.rows.length === 0) {
        return reply.code(404).send(envelope({ error: "Professional not found" }, request.id));
      }
      return envelope(pulsoIrisProfessionalListSchema.parse(result.rows)[0], request.id);
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
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

    const result = await scope.db.transaction(async (transaction) => {
      const insertResult = await transaction.query(
        `insert into pulso_iris.payers (tenant_id, name, payer_group, requires_authorization, status)
         values ($1, $2, $3, coalesce($4, false), coalesce($5, 'active'))
         returning ${PAYER_COLUMNS}`,
        [scope.tenantId, input.name, input.group, input.requiresAuthorization ?? null, input.status ?? null]
      );
      const created = pulsoIrisPayerListSchema.parse(insertResult.rows)[0];
      if (created) {
        await emitConfigUpdated(request, scope.tenantId, "payer", created.id, transaction);
      }
      return insertResult;
    });
    const created = pulsoIrisPayerListSchema.parse(result.rows)[0];
    return reply.code(201).send(envelope(created, request.id));
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

    const result = await scope.db.transaction(async (transaction) => {
      const updateResult = await transaction.query(
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
      if (updateResult.rows.length > 0) {
        await emitConfigUpdated(request, scope.tenantId, "payer", payerId, transaction);
      }
      return updateResult;
    });

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

    const result = await scope.db.transaction(async (transaction) => {
      const insertResult = await transaction.query(
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
      const created = pulsoIrisAppointmentTypeListSchema.parse(insertResult.rows)[0];
      if (created) {
        await emitConfigUpdated(request, scope.tenantId, "appointment_type", created.id, transaction);
      }
      return insertResult;
    });
    const created = pulsoIrisAppointmentTypeListSchema.parse(result.rows)[0];
    return reply.code(201).send(envelope(created, request.id));
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

    if (input.durationMin !== undefined) {
      const conflict = await findSlotDurationConflict(scope.db, scope.tenantId, {
        appointmentTypeId,
        durationMin: input.durationMin
      });
      if (conflict) {
        return reply.code(422).send(
          envelope(
            {
              error: `durationMin ${input.durationMin} breaks active availability rule slotDurationMin ${conflict.slotDurationMin}`
            },
            request.id
          )
        );
      }
    }

    const result = await scope.db.transaction(async (transaction) => {
      const updateResult = await transaction.query(
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
      if (updateResult.rows.length > 0) {
        await emitConfigUpdated(request, scope.tenantId, "appointment_type", appointmentTypeId, transaction);
      }
      return updateResult;
    });

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

    const durationError = await validateRuleSlotDuration(scope.db, scope.tenantId, {
      appointmentTypeId: input.appointmentTypeId,
      slotDurationMin: input.slotDurationMin ?? 20
    });
    if (durationError) {
      return reply.code(422).send(envelope({ error: durationError }, request.id));
    }

    const configurationError = await validateAvailabilityRuleConfiguration(scope.db, scope.tenantId, {
      siteId: input.siteId,
      professionalId: input.professionalId,
      appointmentTypeId: input.appointmentTypeId,
      weekday: input.weekday,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      slotDurationMin: input.slotDurationMin ?? 20,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      status: input.status ?? "active"
    });
    if (configurationError) {
      return reply.code(422).send(envelope({ error: configurationError }, request.id));
    }

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const insertResult = await transaction.query(
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
        const created = pulsoIrisAvailabilityRuleListSchema.parse(insertResult.rows)[0];
        if (created) {
          await emitConfigUpdated(request, scope.tenantId, "availability_rule", created.id, transaction);
        }
        return insertResult;
      });
      const created = pulsoIrisAvailabilityRuleListSchema.parse(result.rows)[0];
      return reply.code(201).send(envelope(created, request.id));
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

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.siteId, table: "pulso_iris.sites", label: "siteId" },
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
    ]);
    if (referenceError) {
      return sendReferenceError(reply, request, referenceError.label);
    }

    const current = await scope.db.query<EffectiveAvailabilityRule>(
      `select site_id as "siteId", professional_id as "professionalId",
              appointment_type_id as "appointmentTypeId", weekday::int as weekday,
              to_char(starts_at, 'HH24:MI:SS') as "startsAt",
              to_char(ends_at, 'HH24:MI:SS') as "endsAt",
              slot_duration_min as "slotDurationMin",
              effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo", status
       from pulso_iris.availability_rules
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, ruleId]
    );
    const existing = current.rows[0];
    if (!existing) {
      return reply.code(404).send(envelope({ error: "Availability rule not found" }, request.id));
    }
    const effective: EffectiveAvailabilityRule = {
      siteId: input.siteId ?? existing.siteId,
      professionalId: input.professionalId ?? existing.professionalId,
      appointmentTypeId: input.appointmentTypeId ?? existing.appointmentTypeId,
      weekday: input.weekday ?? existing.weekday,
      startsAt: input.startsAt ?? existing.startsAt,
      endsAt: input.endsAt ?? existing.endsAt,
      slotDurationMin: input.slotDurationMin ?? existing.slotDurationMin,
      effectiveFrom: input.effectiveFrom ?? existing.effectiveFrom,
      effectiveTo: input.effectiveTo ?? existing.effectiveTo,
      status: input.status ?? existing.status
    };
    if (!isTimeRange(effective.startsAt, effective.endsAt)) {
      return reply.code(400).send(envelope({ error: "endsAt must be after startsAt" }, request.id));
    }
    const configurationError = await validateAvailabilityRuleConfiguration(scope.db, scope.tenantId, effective, ruleId);
    if (configurationError) {
      return reply.code(422).send(envelope({ error: configurationError }, request.id));
    }

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const updateResult = await transaction.query(
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
        if (updateResult.rows.length > 0) {
          await emitConfigUpdated(request, scope.tenantId, "availability_rule", ruleId, transaction);
        }
        return updateResult;
      });

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
      const result = await scope.db.transaction(async (transaction) => {
        const insertResult = await transaction.query(
          `insert into pulso_iris.agenda_blocks
             (tenant_id, site_id, professional_id, appointment_type_id, starts_at, ends_at, block_type, reason, status)
           values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, coalesce($7, 'block'), $8, coalesce($9, 'active'))
           returning ${AGENDA_BLOCK_COLUMNS}`,
          [
            scope.tenantId,
            input.siteId ?? null,
            input.professionalId ?? null,
            input.appointmentTypeId ?? null,
            input.startsAt,
            input.endsAt,
            input.blockType ?? null,
            input.reason,
            input.status ?? null
          ]
        );
        const created = pulsoIrisAgendaBlockListSchema.parse(insertResult.rows)[0];
        if (created) {
          await emitConfigUpdated(request, scope.tenantId, "agenda_block", created.id, transaction);
        }
        return insertResult;
      });
      const created = pulsoIrisAgendaBlockListSchema.parse(result.rows)[0];
      return reply.code(201).send(envelope(created, request.id));
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

    if (input.startsAt !== undefined || input.endsAt !== undefined) {
      const current = await scope.db.query<{ startsAt: Date | string; endsAt: Date | string }>(
        `select starts_at as "startsAt", ends_at as "endsAt"
         from pulso_iris.agenda_blocks where tenant_id = $1 and id = $2`,
        [scope.tenantId, blockId]
      );
      const existing = current.rows[0];
      if (!existing) {
        return reply.code(404).send(envelope({ error: "Agenda block not found" }, request.id));
      }
      const startsAt = input.startsAt ?? new Date(existing.startsAt).toISOString();
      const endsAt = input.endsAt ?? new Date(existing.endsAt).toISOString();
      if (!isDateTimeRange(startsAt, endsAt)) {
        return reply.code(400).send(envelope({ error: "endsAt must be after startsAt" }, request.id));
      }
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
      const result = await scope.db.transaction(async (transaction) => {
        const updateResult = await transaction.query(
          `update pulso_iris.agenda_blocks set
             site_id = coalesce($3, site_id),
             professional_id = coalesce($4, professional_id),
             appointment_type_id = coalesce($5, appointment_type_id),
             starts_at = coalesce($6::timestamptz, starts_at),
             ends_at = coalesce($7::timestamptz, ends_at),
             block_type = coalesce($8, block_type),
             reason = coalesce($9, reason),
             status = coalesce($10, status),
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
            input.blockType ?? null,
            input.reason ?? null,
            input.status ?? null
          ]
        );
        if (updateResult.rows.length > 0) {
          await emitConfigUpdated(request, scope.tenantId, "agenda_block", blockId, transaction);
        }
        return updateResult;
      });

      if (result.rows.length === 0) {
        return reply.code(404).send(envelope({ error: "Agenda block not found" }, request.id));
      }
      return envelope(pulsoIrisAgendaBlockListSchema.parse(result.rows)[0], request.id);
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  // ----- Festivos -----

  app.get(`${base}/holidays`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select ${HOLIDAY_COLUMNS}
       from pulso_iris.holidays
       where tenant_id = $1
       order by holiday_date`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisHolidayListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/holidays`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisHolidayInputSchema, request, reply);
    if (!input) return;

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const insertResult = await transaction.query(
          `insert into pulso_iris.holidays (tenant_id, holiday_date, name, status)
           values ($1, $2::date, $3, coalesce($4, 'active'))
           returning ${HOLIDAY_COLUMNS}`,
          [scope.tenantId, input.holidayDate, input.name, input.status ?? null]
        );
        const created = pulsoIrisHolidayListSchema.parse(insertResult.rows)[0];
        if (created) {
          await emitConfigUpdated(request, scope.tenantId, "holiday", created.id, transaction);
        }
        return insertResult;
      });
      const created = pulsoIrisHolidayListSchema.parse(result.rows)[0];
      return reply.code(201).send(envelope(created, request.id));
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  app.patch(`${base}/holidays/:holidayId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const holidayId = readUuidParam(request.params, "holidayId");
    if (!holidayId) {
      return reply.code(400).send(envelope({ error: "holidayId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisHolidayInputSchema.partial(), request, reply);
    if (!input) return;

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const updateResult = await transaction.query(
          `update pulso_iris.holidays set
             holiday_date = coalesce($3::date, holiday_date),
             name = coalesce($4, name),
             status = coalesce($5, status),
             updated_at = now()
           where tenant_id = $1 and id = $2
           returning ${HOLIDAY_COLUMNS}`,
          [scope.tenantId, holidayId, input.holidayDate ?? null, input.name ?? null, input.status ?? null]
        );
        if (updateResult.rows.length > 0) {
          await emitConfigUpdated(request, scope.tenantId, "holiday", holidayId, transaction);
        }
        return updateResult;
      });

      if (result.rows.length === 0) {
        return reply.code(404).send(envelope({ error: "Holiday not found" }, request.id));
      }
      return envelope(pulsoIrisHolidayListSchema.parse(result.rows)[0], request.id);
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  // ----- Exclusiones profesional x convenio -----

  app.get(`${base}/payer-exclusions`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select ${PAYER_EXCLUSION_COLUMNS}
       from pulso_iris.professional_payer_exclusions
       where tenant_id = $1
       order by created_at desc`,
      [scope.tenantId]
    );
    return envelope(pulsoIrisPayerExclusionListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/payer-exclusions`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisPayerExclusionInputSchema, request, reply);
    if (!input) return;

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.payerId, table: "pulso_iris.payers", label: "payerId" }
    ]);
    if (referenceError) {
      return sendReferenceError(reply, request, referenceError.label);
    }

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const insertResult = await transaction.query(
          `insert into pulso_iris.professional_payer_exclusions
             (tenant_id, professional_id, payer_id, status)
           values ($1, $2, $3, coalesce($4, 'active'))
           returning ${PAYER_EXCLUSION_COLUMNS}`,
          [scope.tenantId, input.professionalId, input.payerId, input.status ?? null]
        );
        const created = pulsoIrisPayerExclusionListSchema.parse(insertResult.rows)[0];
        if (created) {
          await emitConfigUpdated(request, scope.tenantId, "payer_exclusion", created.id, transaction);
        }
        return insertResult;
      });
      const created = pulsoIrisPayerExclusionListSchema.parse(result.rows)[0];
      return reply.code(201).send(envelope(created, request.id));
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });

  app.patch(`${base}/payer-exclusions/:exclusionId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const exclusionId = readUuidParam(request.params, "exclusionId");
    if (!exclusionId) {
      return reply.code(400).send(envelope({ error: "exclusionId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisPayerExclusionInputSchema.partial(), request, reply);
    if (!input) return;

    const referenceError = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.payerId, table: "pulso_iris.payers", label: "payerId" }
    ]);
    if (referenceError) {
      return sendReferenceError(reply, request, referenceError.label);
    }

    try {
      const result = await scope.db.transaction(async (transaction) => {
        const updateResult = await transaction.query(
          `update pulso_iris.professional_payer_exclusions set
             professional_id = coalesce($3, professional_id),
             payer_id = coalesce($4, payer_id),
             status = coalesce($5, status),
             updated_at = now()
           where tenant_id = $1 and id = $2
           returning ${PAYER_EXCLUSION_COLUMNS}`,
          [scope.tenantId, exclusionId, input.professionalId ?? null, input.payerId ?? null, input.status ?? null]
        );
        if (updateResult.rows.length > 0) {
          await emitConfigUpdated(request, scope.tenantId, "payer_exclusion", exclusionId, transaction);
        }
        return updateResult;
      });

      if (result.rows.length === 0) {
        return reply.code(404).send(envelope({ error: "Payer exclusion not found" }, request.id));
      }
      return envelope(pulsoIrisPayerExclusionListSchema.parse(result.rows)[0], request.id);
    } catch (error) {
      return sendDatabaseConfigError(error, reply, request.id);
    }
  });
}

interface AgendaSettingsRow {
  tenantId: string;
  mode: "internal" | "hybrid_manual" | "legacy_integrated";
  timezone: string;
  bookingHorizonDays: number;
  holdDurationMinutes: number;
  maxAlternatives: number;
  maxReschedules: number;
  externalConfirmationSlaMinutes: number;
  externalReferenceRequired: boolean;
  capacityPolicy: "strict";
  status: "active" | "paused";
  updatedBy: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function asTransactionalDatabase(transaction: TransactionExecutor): Database {
  return {
    query: (text, params) => transaction.query(text, params),
    transaction: async (work) => {
      await transaction.query("savepoint hyperion_config_import");
      try {
        const result = await work(transaction);
        await transaction.query("release savepoint hyperion_config_import");
        return result;
      } catch (error) {
        await transaction.query("rollback to savepoint hyperion_config_import");
        await transaction.query("release savepoint hyperion_config_import");
        throw error;
      }
    },
    close: async () => undefined
  };
}

async function ensureAgendaSettings(db: Database, tenantId: string): Promise<AgendaSettingsRow> {
  await ensureAgendaSettingsExist(db, tenantId);
  const result = await db.query<AgendaSettingsRow>(
    `select ${AGENDA_SETTINGS_COLUMNS} from pulso_iris.agenda_settings where tenant_id = $1`,
    [tenantId]
  );
  const settings = result.rows[0];
  if (!settings) throw new Error("Could not initialize agenda settings");
  return settings;
}

function readImportResource(params: unknown) {
  const raw =
    typeof params === "object" && params !== null && "resource" in params
      ? (params as { resource?: unknown }).resource
      : undefined;
  return parseAgendaImportResource(raw);
}

function sendAgendaCsvError(error: unknown, reply: FastifyReply, requestId: string) {
  if (error instanceof AgendaCsvError) {
    return reply.code(error.statusCode).send(envelope({ error: error.message }, requestId));
  }
  throw error;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("es-CO", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

interface EffectiveAvailabilityRule {
  siteId: string;
  professionalId: string;
  appointmentTypeId: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
  slotDurationMin: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: "active" | "paused";
}

async function validateAvailabilityRuleConfiguration(
  db: Database,
  tenantId: string,
  input: EffectiveAvailabilityRule,
  excludeRuleId?: string
): Promise<string | undefined> {
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    return "effectiveTo must be on or after effectiveFrom";
  }

  const durationError = await validateRuleSlotDuration(db, tenantId, {
    appointmentTypeId: input.appointmentTypeId,
    slotDurationMin: input.slotDurationMin
  });
  if (durationError) return durationError;

  const result = await db.query<{
    professionalSite: boolean;
    professionalAppointmentType: boolean;
    overlaps: boolean;
  }>(
    `select
       exists(
         select 1 from pulso_iris.professional_sites
         where tenant_id = $1 and professional_id = $2 and site_id = $3 and status = 'active'
       ) as "professionalSite",
       exists(
         select 1 from pulso_iris.professional_appointment_types
         where tenant_id = $1 and professional_id = $2 and appointment_type_id = $4 and status = 'active'
       ) as "professionalAppointmentType",
       case when $10 = 'active' then exists(
         select 1 from pulso_iris.availability_rules
         where tenant_id = $1
           and professional_id = $2
           and weekday = $5
           and status = 'active'
           and starts_at < $7::time
           and ends_at > $6::time
           and daterange(
             coalesce(effective_from, '-infinity'::date),
             coalesce(effective_to, 'infinity'::date),
             '[]'
           ) && daterange(
             coalesce($8::date, '-infinity'::date),
             coalesce($9::date, 'infinity'::date),
             '[]'
           )
           and ($11::uuid is null or id <> $11::uuid)
       ) else false end as overlaps`,
    [
      tenantId,
      input.professionalId,
      input.siteId,
      input.appointmentTypeId,
      input.weekday,
      input.startsAt,
      input.endsAt,
      input.effectiveFrom,
      input.effectiveTo,
      input.status,
      excludeRuleId ?? null
    ]
  );
  const validation = result.rows[0];
  if (!validation?.professionalSite) return "Professional is not active at the selected site";
  if (!validation.professionalAppointmentType) return "Professional is not authorized for the appointment type";
  if (validation.overlaps) return "Availability rule overlaps another active rule for this professional";
  return undefined;
}

async function validateRuleSlotDuration(
  db: Database,
  tenantId: string,
  input: { appointmentTypeId: string; slotDurationMin: number }
): Promise<string | undefined> {
  const result = await db.query<{ durationMin: number }>(
    `select duration_min as "durationMin"
     from pulso_iris.appointment_types
     where tenant_id = $1 and id = $2`,
    [tenantId, input.appointmentTypeId]
  );
  const durationMin = result.rows[0]?.durationMin;
  if (durationMin === undefined) {
    return "appointmentTypeId does not belong to this tenant";
  }
  if (input.slotDurationMin < durationMin) {
    return `slotDurationMin must be >= appointment type durationMin (${durationMin})`;
  }
  return undefined;
}

async function findSlotDurationConflict(
  db: Database,
  tenantId: string,
  input: { appointmentTypeId: string; durationMin: number }
): Promise<{ slotDurationMin: number } | undefined> {
  const result = await db.query<{ slotDurationMin: number }>(
    `select slot_duration_min as "slotDurationMin"
     from pulso_iris.availability_rules
     where tenant_id = $1
       and appointment_type_id = $2
       and status = 'active'
       and slot_duration_min < $3
     order by slot_duration_min
     limit 1`,
    [tenantId, input.appointmentTypeId, input.durationMin]
  );
  return result.rows[0];
}

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
    String((error as { code?: unknown }).code) === "23P01"
  ) {
    return reply.code(409).send(envelope({ error: "Configuration overlaps an existing rule" }, requestId));
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
