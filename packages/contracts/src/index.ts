import { z } from "zod";

export const serviceNameSchema = z.enum([
  "api-gateway",
  "identity-service",
  "tenant-service",
  "agent-service",
  "prompt-flow-service",
  "knowledge-service",
  "audit-service",
  "integration-service",
  "pulso-iris-service",
  "whatsapp-channel-service",
  "lumen-service"
]);

export type ServiceName = z.infer<typeof serviceNameSchema>;

export const healthStatusSchema = z.enum(["ok", "degraded", "down"]);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const dependencyHealthSchema = z.object({
  name: z.string().min(1),
  status: healthStatusSchema,
  latencyMs: z.number().nonnegative().optional(),
  detail: z.string().optional()
});

export const serviceHealthSchema = z.object({
  service: serviceNameSchema,
  status: healthStatusSchema,
  version: z.string().min(1),
  checkedAt: z.string().datetime(),
  uptimeSeconds: z.number().nonnegative(),
  dependencies: z.array(dependencyHealthSchema).default([])
});

export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

export const platformHealthSchema = z.object({
  status: healthStatusSchema,
  checkedAt: z.string().datetime(),
  services: z.array(serviceHealthSchema)
});

export type PlatformHealth = z.infer<typeof platformHealthSchema>;

export const tenantStatusSchema = z.enum(["active", "paused", "archived"]);
export const agentStatusSchema = z.enum(["draft", "active", "paused", "retired"]);
export const productStatusSchema = z.enum(["foundation", "building", "active", "paused"]);

export const pulsoIrisProductCode = "PULSO_IRIS" as const;
export const pulsoIrisAgentCode = "SOFIA" as const;
export const lumenProductCode = "LUMEN" as const;

export const tenantIdSchema = z.string().uuid();

const isoDateTime = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().datetime()
);

const isoDateTimeOptional = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : (value ?? undefined)),
  z.string().datetime().optional()
);

const optionalFromNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value ?? undefined, schema.optional());

export const whatsappSofiaRuntimeMigration = "012-whatsapp-sofia-runtime.sql" as const;

export const whatsappProviderModeSchema = z.literal("whatsapp_web_test");
export const whatsappConnectionStateSchema = z.enum(["disconnected", "qr_pending", "connecting", "ready", "degraded"]);

export const whatsappIntegrationStatusSchema = z.object({
  tenantId: tenantIdSchema,
  providerMode: whatsappProviderModeSchema,
  state: whatsappConnectionStateSchema,
  phoneMasked: optionalFromNull(z.string().regex(/^\*{4,8}\d{4}$/)),
  lastActivityAt: isoDateTimeOptional,
  lastError: optionalFromNull(z.string().min(1).max(160)),
  qrExpiresAt: isoDateTimeOptional,
  sessionRestorable: z.boolean()
});

export const whatsappQrSchema = z.object({
  tenantId: tenantIdSchema,
  providerMode: whatsappProviderModeSchema,
  state: whatsappConnectionStateSchema,
  qrDataUrl: optionalFromNull(z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)),
  qrExpiresAt: isoDateTimeOptional
});

export const sofiaDependencyReadinessSchema = z.object({
  name: z.enum(["channel", "llm", "prompt_flow", "agenda"]),
  status: healthStatusSchema,
  detail: z.string().min(1).optional()
});

export const sofiaReadinessSchema = z.object({
  tenantId: tenantIdSchema,
  status: z.enum(["ready", "degraded", "not_ready"]),
  checkedAt: isoDateTime,
  canReceiveMessages: z.boolean(),
  canBookAppointments: z.boolean(),
  dependencies: z.array(sofiaDependencyReadinessSchema)
});

export type WhatsAppProviderMode = z.infer<typeof whatsappProviderModeSchema>;
export type WhatsAppConnectionState = z.infer<typeof whatsappConnectionStateSchema>;
export type WhatsAppIntegrationStatus = z.infer<typeof whatsappIntegrationStatusSchema>;
export type WhatsAppQr = z.infer<typeof whatsappQrSchema>;
export type SofiaReadiness = z.infer<typeof sofiaReadinessSchema>;

export const pulsoIrisChannelSchema = z.enum(["voice", "whatsapp"]);
export const pulsoIrisDirectionSchema = z.enum(["inbound", "outbound"]);
export const pulsoIrisConversationStatusSchema = z.enum(["active", "resolved", "handoff_required", "closed"]);
export const pulsoIrisAppointmentStatusSchema = z.enum([
  "offered",
  "registered",
  "pending_provider",
  "submitted",
  "pending_external_confirmation",
  "verified",
  "confirmed",
  "deferred",
  "verification_failed",
  "failed",
  "external_rejected",
  "expired",
  "rescheduled",
  "cancelled",
  "no_show"
]);
export const pulsoIrisVerificationModeSchema = z.enum(["internal", "manual_external", "legacy_provider", "simulated"]);
export const pulsoIrisRpaActionStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "verification_failed",
  "deferred",
  "failed"
]);
export const pulsoIrisHandoffStatusSchema = z.enum([
  "open",
  "assigned",
  "in_progress",
  "resolved",
  "returned_to_sofia"
]);
export const pulsoIrisPatientStatusSchema = z.enum([
  "active",
  "inactive_12m",
  "waiting_list",
  "high_noshow_risk",
  "partial_optout",
  "total_optout",
  "data_cleanup"
]);
export const pulsoIrisHandoffPrioritySchema = z.enum(["max", "high", "medium", "low"]);

export type PulsoIrisChannel = z.infer<typeof pulsoIrisChannelSchema>;
export type PulsoIrisDirection = z.infer<typeof pulsoIrisDirectionSchema>;
export type PulsoIrisConversationStatus = z.infer<typeof pulsoIrisConversationStatusSchema>;
export type PulsoIrisAppointmentStatus = z.infer<typeof pulsoIrisAppointmentStatusSchema>;
export type PulsoIrisRpaActionStatus = z.infer<typeof pulsoIrisRpaActionStatusSchema>;
export type PulsoIrisHandoffStatus = z.infer<typeof pulsoIrisHandoffStatusSchema>;
export type PulsoIrisPatientStatus = z.infer<typeof pulsoIrisPatientStatusSchema>;

export const pulsoIrisAdministrativePatientSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  status: pulsoIrisPatientStatusSchema,
  documentType: z.string().min(1).optional(),
  documentNumberMasked: z.string().min(1).optional(),
  fullName: z.string().min(1).optional(),
  preferredChannel: pulsoIrisChannelSchema.optional(),
  metadata: z.record(z.unknown()).default({})
});

export const pulsoIrisConversationSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  patientId: optionalFromNull(z.string().uuid()),
  siteId: optionalFromNull(z.string().uuid()),
  channel: pulsoIrisChannelSchema,
  direction: pulsoIrisDirectionSchema,
  status: pulsoIrisConversationStatusSchema,
  primaryIntent: optionalFromNull(z.string().min(1)),
  provider: optionalFromNull(z.string().min(1)),
  identityStatus: optionalFromNull(z.enum(["identified", "pending_name"])),
  sofiaStatus: optionalFromNull(z.enum(["queued", "processing", "responded", "failed"])),
  lastSofiaActivityAt: isoDateTimeOptional,
  startedAt: isoDateTime,
  endedAt: isoDateTimeOptional,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisMessageSchema = z.object({
  id: z.string().uuid(),
  tenantId: optionalFromNull(z.string().uuid()),
  conversationId: z.string().uuid(),
  sender: z.enum(["sofia", "patient", "advisor", "system"]),
  body: z.string().min(1),
  provider: optionalFromNull(z.string().min(1)),
  externalMessageId: optionalFromNull(z.string().min(1)),
  providerMessageId: optionalFromNull(z.string().min(1)),
  deliveryStatus: optionalFromNull(z.enum(["received", "queued", "sent", "delivered", "read", "failed", "ignored"])),
  deliveredAt: isoDateTimeOptional,
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).default({})
});

export const pulsoIrisAppointmentSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  patientId: optionalFromNull(z.string().uuid()),
  conversationId: optionalFromNull(z.string().uuid()),
  siteId: optionalFromNull(z.string().uuid()),
  professionalId: optionalFromNull(z.string().uuid()),
  professionalIsPilot: z.boolean().optional(),
  payerId: optionalFromNull(z.string().uuid()),
  appointmentTypeId: optionalFromNull(z.string().uuid()),
  appointmentType: optionalFromNull(z.string().min(1)),
  origin: z.string().min(1).default("sofia_wa"),
  status: pulsoIrisAppointmentStatusSchema,
  scheduledAt: isoDateTimeOptional,
  durationMin: optionalFromNull(z.number().int().positive()),
  idempotencyKey: optionalFromNull(z.string().min(4)),
  holdId: optionalFromNull(z.string().uuid()),
  slotCapacityToken: optionalFromNull(z.number().int().positive()),
  verificationMode: optionalFromNull(pulsoIrisVerificationModeSchema),
  externalSystem: optionalFromNull(z.string().min(1)),
  externalReference: optionalFromNull(z.string().min(1)),
  externalNote: optionalFromNull(z.string().min(1)),
  verifiedAt: isoDateTimeOptional,
  verifiedBy: optionalFromNull(z.string().min(1)),
  externalSlaDueAt: isoDateTimeOptional,
  rescheduleCount: z.number().int().nonnegative().default(0),
  previousAppointmentId: optionalFromNull(z.string().uuid()),
  cancellationReason: optionalFromNull(z.string().min(1)),
  cancelledAt: isoDateTimeOptional,
  cancelledBy: optionalFromNull(z.string().min(1)),
  externalRejectionReason: optionalFromNull(z.string().min(1)),
  externalRejectedAt: isoDateTimeOptional,
  externalRejectedBy: optionalFromNull(z.string().min(1)),
  statusUpdatedAt: isoDateTimeOptional,
  legacyReference: optionalFromNull(z.string().min(1)),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisRpaActionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  appointmentId: optionalFromNull(z.string().uuid()),
  conversationId: optionalFromNull(z.string().uuid()),
  workerId: optionalFromNull(z.string().uuid()),
  actionType: z.enum([
    "check_availability",
    "register_appointment",
    "cancel",
    "reschedule",
    "confirm",
    "sweep",
    "create_patient"
  ]),
  status: pulsoIrisRpaActionStatusSchema,
  priority: z.number().int().min(0).default(50),
  phase: optionalFromNull(z.string().min(1)),
  durationMs: optionalFromNull(z.number().int().nonnegative()),
  executedAt: isoDateTimeOptional,
  idempotencyKey: z.string().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisHandoffSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  patientId: optionalFromNull(z.string().uuid()),
  conversationId: optionalFromNull(z.string().uuid()),
  triggerCode: z.string().min(1),
  priority: pulsoIrisHandoffPrioritySchema,
  status: pulsoIrisHandoffStatusSchema,
  summary: optionalFromNull(z.string().min(1)),
  slaDueAt: isoDateTimeOptional,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

const catalogStatusSchema = z.enum(["active", "paused"]);

export const pulsoIrisSiteSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  city: optionalFromNull(z.string().min(1)),
  address: optionalFromNull(z.string().min(1)),
  phone: optionalFromNull(z.string().min(1)),
  status: catalogStatusSchema.default("active"),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisSiteInputSchema = z.object({
  name: z.string().min(2),
  city: z.string().min(2).optional(),
  address: z.string().min(2).optional(),
  phone: z.string().min(5).optional(),
  status: catalogStatusSchema.optional()
});

export const pulsoIrisProfessionalTypeSchema = z.enum(["ophthalmologist", "optometrist"]);

export const pulsoIrisProfessionalSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  professionalType: pulsoIrisProfessionalTypeSchema,
  subspecialty: optionalFromNull(z.string().min(1)),
  isPilot: z.boolean().default(false),
  status: catalogStatusSchema.default("active"),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisProfessionalInputSchema = z.object({
  name: z.string().min(2),
  professionalType: pulsoIrisProfessionalTypeSchema,
  subspecialty: z.string().min(2).optional(),
  isPilot: z.boolean().optional(),
  status: catalogStatusSchema.optional()
});

export const pulsoIrisPayerGroupSchema = z.enum(["eps", "private_prepaid", "policy", "particular", "other"]);

export const pulsoIrisPayerSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  group: pulsoIrisPayerGroupSchema,
  requiresAuthorization: z.boolean().default(false),
  status: catalogStatusSchema.default("active"),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisPayerInputSchema = z.object({
  name: z.string().min(2),
  group: pulsoIrisPayerGroupSchema,
  requiresAuthorization: z.boolean().optional(),
  status: catalogStatusSchema.optional()
});

export const pulsoIrisAppointmentTypeCategorySchema = z.enum(["consulta", "ayuda_dx", "valoracion_qx", "control_post"]);

export const pulsoIrisAppointmentTypeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  category: pulsoIrisAppointmentTypeCategorySchema,
  durationMin: z.number().int().positive(),
  preparationText: optionalFromNull(z.string().min(1)),
  bookableByIa: z.boolean(),
  slotPriority: z.number().int().nonnegative(),
  status: catalogStatusSchema.default("active"),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisAppointmentTypeInputSchema = z.object({
  name: z.string().min(2),
  category: pulsoIrisAppointmentTypeCategorySchema,
  durationMin: z.number().int().positive().optional(),
  preparationText: z.string().min(2).optional(),
  bookableByIa: z.boolean().optional(),
  slotPriority: z.number().int().nonnegative().optional(),
  status: catalogStatusSchema.optional()
});

const timeOfDaySchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const pulsoIrisWeekdaySchema = z.number().int().min(0).max(6);

export const pulsoIrisAvailabilityRuleSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  siteId: z.string().uuid(),
  professionalId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  weekday: pulsoIrisWeekdaySchema,
  startsAt: timeOfDaySchema,
  endsAt: timeOfDaySchema,
  slotDurationMin: z.number().int().positive(),
  capacity: z.number().int().positive(),
  timezone: z.string().min(1),
  effectiveFrom: optionalFromNull(dateOnlySchema),
  effectiveTo: optionalFromNull(dateOnlySchema),
  status: catalogStatusSchema.default("active"),
  notes: optionalFromNull(z.string().min(1)),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisAvailabilityRuleInputSchema = z.object({
  siteId: z.string().uuid(),
  professionalId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  weekday: pulsoIrisWeekdaySchema,
  startsAt: timeOfDaySchema,
  endsAt: timeOfDaySchema,
  slotDurationMin: z.number().int().positive().optional(),
  capacity: z.number().int().positive().optional(),
  timezone: z.string().min(1).optional(),
  effectiveFrom: dateOnlySchema.optional(),
  effectiveTo: dateOnlySchema.optional(),
  status: catalogStatusSchema.optional(),
  notes: z.string().min(1).optional()
});

export const pulsoIrisAgendaBlockStatusSchema = z.enum(["active", "cancelled"]);
export const pulsoIrisAgendaBlockTypeSchema = z.enum(["block", "absence", "vacation"]);

export const pulsoIrisAgendaBlockSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  siteId: optionalFromNull(z.string().uuid()),
  professionalId: optionalFromNull(z.string().uuid()),
  appointmentTypeId: optionalFromNull(z.string().uuid()),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  blockType: pulsoIrisAgendaBlockTypeSchema.default("block"),
  reason: z.string().min(1),
  status: pulsoIrisAgendaBlockStatusSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisAgendaBlockInputSchema = z.object({
  siteId: z.string().uuid().optional(),
  professionalId: z.string().uuid().optional(),
  appointmentTypeId: z.string().uuid().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  blockType: pulsoIrisAgendaBlockTypeSchema.optional(),
  reason: z.string().min(2),
  status: pulsoIrisAgendaBlockStatusSchema.optional()
});

export const pulsoIrisAvailabilitySlotSchema = z.object({
  ruleId: z.string().uuid(),
  siteId: z.string().uuid(),
  professionalId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  localDate: dateOnlySchema,
  localTime: timeOfDaySchema,
  timeZone: z.string().min(1),
  capacity: z.number().int().positive(),
  booked: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  status: z.enum(["available", "full"]),
  siteName: optionalFromNull(z.string().min(1)),
  professionalName: optionalFromNull(z.string().min(1)),
  professionalIsPilot: z.boolean().optional(),
  appointmentTypeName: optionalFromNull(z.string().min(1)),
  appointmentCategory: optionalFromNull(pulsoIrisAppointmentTypeCategorySchema)
});

export const pulsoIrisAvailabilitySlotsSchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  slots: z.array(pulsoIrisAvailabilitySlotSchema)
});

export const pulsoIrisAvailabilitySlotQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  siteId: z.string().uuid().optional(),
  professionalId: z.string().uuid().optional(),
  appointmentTypeId: z.string().uuid().optional(),
  payerId: z.string().uuid().optional(),
  includeFull: z.preprocess((value) => value === "true" || value === true, z.boolean()).default(false)
});

export const pulsoIrisHolidaySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  holidayDate: dateOnlySchema,
  name: z.string().min(1),
  status: catalogStatusSchema.default("active"),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisHolidayInputSchema = z.object({
  holidayDate: dateOnlySchema,
  name: z.string().min(2),
  status: catalogStatusSchema.optional()
});

export const pulsoIrisPayerExclusionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  professionalId: z.string().uuid(),
  payerId: z.string().uuid(),
  status: catalogStatusSchema.default("active"),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisPayerExclusionInputSchema = z.object({
  professionalId: z.string().uuid(),
  payerId: z.string().uuid(),
  status: catalogStatusSchema.optional()
});

export const pulsoIrisAgendaModeSchema = z.enum(["internal", "hybrid_manual", "legacy_integrated"]);
export const pulsoIrisAgendaCapacityPolicySchema = z.literal("strict");
export const pulsoIrisAgendaStatusSchema = z.enum(["active", "paused"]);

export const pulsoIrisAgendaSettingsSchema = z.object({
  tenantId: z.string().uuid(),
  mode: pulsoIrisAgendaModeSchema,
  timezone: z.string().min(1),
  bookingHorizonDays: z.number().int().min(1).max(730),
  holdDurationMinutes: z.number().int().min(1).max(1440),
  maxAlternatives: z.number().int().min(1).max(20),
  maxReschedules: z.number().int().min(0).max(20),
  externalConfirmationSlaMinutes: z.number().int().min(1).max(10080),
  externalReferenceRequired: z.boolean(),
  capacityPolicy: pulsoIrisAgendaCapacityPolicySchema,
  status: pulsoIrisAgendaStatusSchema,
  updatedBy: optionalFromNull(z.string().min(1)),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisAgendaSettingsInputSchema = z
  .object({
    mode: pulsoIrisAgendaModeSchema.optional(),
    timezone: z.string().trim().min(1).optional(),
    bookingHorizonDays: z.number().int().min(1).max(730).optional(),
    holdDurationMinutes: z.number().int().min(1).max(1440).optional(),
    maxAlternatives: z.number().int().min(1).max(20).optional(),
    maxReschedules: z.number().int().min(0).max(20).optional(),
    externalConfirmationSlaMinutes: z.number().int().min(1).max(10080).optional(),
    externalReferenceRequired: z.boolean().optional(),
    capacityPolicy: pulsoIrisAgendaCapacityPolicySchema.optional(),
    status: pulsoIrisAgendaStatusSchema.optional()
  })
  .refine((input) => Object.keys(input).length > 0, "at least one agenda setting is required");

export const pulsoIrisAgendaSettingsPatchSchema = pulsoIrisAgendaSettingsInputSchema;

export const pulsoIrisProfessionalSiteSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  professionalId: z.string().uuid(),
  siteId: z.string().uuid(),
  status: catalogStatusSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisProfessionalSiteInputSchema = z.object({
  professionalId: z.string().uuid(),
  siteId: z.string().uuid(),
  status: catalogStatusSchema.optional()
});

export const pulsoIrisProfessionalAppointmentTypeSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  professionalId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  status: catalogStatusSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisProfessionalAppointmentTypeInputSchema = z.object({
  professionalId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  status: catalogStatusSchema.optional()
});

export const pulsoIrisAppointmentHoldStatusSchema = z.enum(["active", "consumed", "expired", "cancelled"]);

export const pulsoIrisAppointmentHoldSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  patientId: optionalFromNull(z.string().uuid()),
  conversationId: optionalFromNull(z.string().uuid()),
  siteId: z.string().uuid(),
  professionalId: z.string().uuid(),
  payerId: optionalFromNull(z.string().uuid()),
  appointmentTypeId: z.string().uuid(),
  scheduledAt: isoDateTime,
  durationMin: z.number().int().positive(),
  slotCapacityToken: z.number().int().positive(),
  status: pulsoIrisAppointmentHoldStatusSchema,
  expiresAt: isoDateTime,
  idempotencyKey: z.string().min(4),
  appointmentId: optionalFromNull(z.string().uuid()),
  createdBy: optionalFromNull(z.string().min(1)),
  consumedAt: isoDateTimeOptional,
  cancelledAt: isoDateTimeOptional,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisAppointmentHoldInputSchema = z.object({
  patientId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  siteId: z.string().uuid(),
  professionalId: z.string().uuid(),
  payerId: z.string().uuid().optional(),
  appointmentTypeId: z.string().uuid(),
  scheduledAt: z.string().datetime(),
  idempotencyKey: z.string().trim().min(4).max(200)
});

export const pulsoIrisAppointmentHoldListSchema = z.array(pulsoIrisAppointmentHoldSchema);

export const pulsoIrisManualVerificationInputSchema = z.object({
  externalReference: z.string().trim().min(1).max(200),
  externalSystem: z.string().trim().min(1).max(200),
  note: z.string().trim().min(1).max(2000).optional()
});

export const pulsoIrisExternalRejectionInputSchema = z.object({
  reason: z.string().trim().min(2).max(1000)
});

export const pulsoIrisAppointmentCancellationInputSchema = z.object({
  reason: z.string().trim().min(2).max(1000)
});

export const pulsoIrisAppointmentRescheduleInputSchema = z
  .object({
    holdId: z.string().uuid().optional(),
    siteId: z.string().uuid().optional(),
    professionalId: z.string().uuid().optional(),
    appointmentTypeId: z.string().uuid().optional(),
    payerId: z.string().uuid().optional(),
    scheduledAt: z.string().datetime().optional(),
    reason: z.string().trim().min(2).max(1000),
    idempotencyKey: z.string().trim().min(4).max(200)
  })
  .refine(
    (input) =>
      Boolean(input.holdId) ||
      Boolean(input.siteId && input.professionalId && input.appointmentTypeId && input.scheduledAt),
    "holdId or complete slot coordinates are required"
  );

export const pulsoIrisAppointmentStatusHistorySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  appointmentId: z.string().uuid(),
  fromStatus: optionalFromNull(pulsoIrisAppointmentStatusSchema),
  toStatus: pulsoIrisAppointmentStatusSchema,
  actorId: optionalFromNull(z.string().min(1)),
  reason: optionalFromNull(z.string().min(1)),
  metadata: z.record(z.unknown()).default({}),
  createdAt: isoDateTime
});

export const pulsoIrisAppointmentStatusHistoryListSchema = z.array(pulsoIrisAppointmentStatusHistorySchema);

export const pulsoIrisConfigurationImportKindSchema = z.enum([
  "professionals",
  "professional_sites",
  "professional_appointment_types",
  "availability_rules",
  "payer_exclusions",
  "agenda_blocks"
]);

export const pulsoIrisConfigurationImportResourceSchema = z.enum([
  "professionals",
  "professional-sites",
  "professional-appointment-types",
  "availability-rules",
  "payer-exclusions",
  "agenda-blocks"
]);

export const pulsoIrisConfigurationImportStatusSchema = z.enum(["previewed", "applying", "applied", "failed"]);
export const pulsoIrisConfigurationImportRowStatusSchema = z.enum(["accepted", "rejected"]);

export const pulsoIrisConfigurationImportAcceptedRowSchema = z.object({
  row: z.number().int().positive(),
  data: z.record(z.union([z.string(), z.number(), z.null()]))
});

export const pulsoIrisConfigurationImportRejectedRowSchema = z.object({
  row: z.number().int().positive(),
  reason: z.string().min(1)
});

export const pulsoIrisConfigurationImportSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  kind: pulsoIrisConfigurationImportKindSchema,
  idempotencyKey: z.string().min(4),
  contentHash: z.string().min(32),
  status: pulsoIrisConfigurationImportStatusSchema,
  rowCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  createdBy: optionalFromNull(z.string().min(1)),
  createdAt: isoDateTime,
  appliedAt: isoDateTimeOptional,
  updatedAt: isoDateTime
});

export const pulsoIrisConfigurationImportPreviewInputSchema = z.object({
  csv: z.string().min(1).max(2_000_000)
});

export const pulsoIrisConfigurationImportPreviewSchema = z.object({
  resource: pulsoIrisConfigurationImportResourceSchema,
  accepted: z.array(pulsoIrisConfigurationImportAcceptedRowSchema),
  rejected: z.array(pulsoIrisConfigurationImportRejectedRowSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative()
  })
});

export const pulsoIrisConfigurationImportApplyInputSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  idempotencyKey: z.string().trim().min(8).max(200)
});

export const pulsoIrisConfigurationImportApplyResultSchema = pulsoIrisConfigurationImportPreviewSchema.extend({
  importId: z.string().uuid(),
  applied: z.number().int().nonnegative(),
  idempotent: z.boolean()
});

export const pulsoIrisConfigurationExportQuerySchema = z.object({
  resource: pulsoIrisConfigurationImportResourceSchema
});

export const pulsoIrisSlotAlternativeSchema = z.object({
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  localDate: dateOnlySchema,
  localTime: timeOfDaySchema,
  timeZone: z.string().min(1),
  siteId: z.string().uuid(),
  professionalId: z.string().uuid(),
  appointmentTypeId: z.string().uuid(),
  remaining: z.number().int().nonnegative(),
  siteName: optionalFromNull(z.string().min(1)),
  professionalName: optionalFromNull(z.string().min(1)),
  appointmentTypeName: optionalFromNull(z.string().min(1))
});

export const pulsoIrisSiteListSchema = z.array(pulsoIrisSiteSchema);
export const pulsoIrisProfessionalListSchema = z.array(pulsoIrisProfessionalSchema);
export const pulsoIrisPayerListSchema = z.array(pulsoIrisPayerSchema);
export const pulsoIrisAppointmentTypeListSchema = z.array(pulsoIrisAppointmentTypeSchema);
export const pulsoIrisAvailabilityRuleListSchema = z.array(pulsoIrisAvailabilityRuleSchema);
export const pulsoIrisAgendaBlockListSchema = z.array(pulsoIrisAgendaBlockSchema);
export const pulsoIrisHolidayListSchema = z.array(pulsoIrisHolidaySchema);
export const pulsoIrisPayerExclusionListSchema = z.array(pulsoIrisPayerExclusionSchema);
export const pulsoIrisProfessionalSiteListSchema = z.array(pulsoIrisProfessionalSiteSchema);
export const pulsoIrisProfessionalAppointmentTypeListSchema = z.array(pulsoIrisProfessionalAppointmentTypeSchema);

export type PulsoIrisSite = z.infer<typeof pulsoIrisSiteSchema>;
export type PulsoIrisSiteInput = z.infer<typeof pulsoIrisSiteInputSchema>;
export type PulsoIrisProfessional = z.infer<typeof pulsoIrisProfessionalSchema>;
export type PulsoIrisProfessionalInput = z.infer<typeof pulsoIrisProfessionalInputSchema>;
export type PulsoIrisPayer = z.infer<typeof pulsoIrisPayerSchema>;
export type PulsoIrisPayerInput = z.infer<typeof pulsoIrisPayerInputSchema>;
export type PulsoIrisAppointmentType = z.infer<typeof pulsoIrisAppointmentTypeSchema>;
export type PulsoIrisAppointmentTypeInput = z.infer<typeof pulsoIrisAppointmentTypeInputSchema>;
export type PulsoIrisAvailabilityRule = z.infer<typeof pulsoIrisAvailabilityRuleSchema>;
export type PulsoIrisAvailabilityRuleInput = z.infer<typeof pulsoIrisAvailabilityRuleInputSchema>;
export type PulsoIrisAgendaBlock = z.infer<typeof pulsoIrisAgendaBlockSchema>;
export type PulsoIrisAgendaBlockInput = z.infer<typeof pulsoIrisAgendaBlockInputSchema>;
export type PulsoIrisAvailabilitySlot = z.infer<typeof pulsoIrisAvailabilitySlotSchema>;
export type PulsoIrisAvailabilitySlots = z.infer<typeof pulsoIrisAvailabilitySlotsSchema>;
export type PulsoIrisHoliday = z.infer<typeof pulsoIrisHolidaySchema>;
export type PulsoIrisHolidayInput = z.infer<typeof pulsoIrisHolidayInputSchema>;
export type PulsoIrisPayerExclusion = z.infer<typeof pulsoIrisPayerExclusionSchema>;
export type PulsoIrisPayerExclusionInput = z.infer<typeof pulsoIrisPayerExclusionInputSchema>;
export type PulsoIrisSlotAlternative = z.infer<typeof pulsoIrisSlotAlternativeSchema>;
export type PulsoIrisAgendaMode = z.infer<typeof pulsoIrisAgendaModeSchema>;
export type PulsoIrisAgendaSettings = z.infer<typeof pulsoIrisAgendaSettingsSchema>;
export type PulsoIrisAgendaSettingsInput = z.infer<typeof pulsoIrisAgendaSettingsInputSchema>;
export type PulsoIrisProfessionalSite = z.infer<typeof pulsoIrisProfessionalSiteSchema>;
export type PulsoIrisProfessionalSiteInput = z.infer<typeof pulsoIrisProfessionalSiteInputSchema>;
export type PulsoIrisProfessionalAppointmentType = z.infer<typeof pulsoIrisProfessionalAppointmentTypeSchema>;
export type PulsoIrisProfessionalAppointmentTypeInput = z.infer<typeof pulsoIrisProfessionalAppointmentTypeInputSchema>;
export type PulsoIrisAppointmentHold = z.infer<typeof pulsoIrisAppointmentHoldSchema>;
export type PulsoIrisAppointmentHoldInput = z.infer<typeof pulsoIrisAppointmentHoldInputSchema>;
export type PulsoIrisManualVerificationInput = z.infer<typeof pulsoIrisManualVerificationInputSchema>;
export type PulsoIrisAppointmentRescheduleInput = z.infer<typeof pulsoIrisAppointmentRescheduleInputSchema>;
export type PulsoIrisConfigurationImport = z.infer<typeof pulsoIrisConfigurationImportSchema>;
export type PulsoIrisConfigurationImportPreview = z.infer<typeof pulsoIrisConfigurationImportPreviewSchema>;
export type PulsoIrisConfigurationImportApplyResult = z.infer<typeof pulsoIrisConfigurationImportApplyResultSchema>;

export const pulsoIrisConversationListSchema = z.array(pulsoIrisConversationSchema);
export const pulsoIrisAppointmentListSchema = z.array(pulsoIrisAppointmentSchema);
export const pulsoIrisHandoffListSchema = z.array(pulsoIrisHandoffSchema);
export const pulsoIrisRpaActionListSchema = z.array(pulsoIrisRpaActionSchema);

// ----- Entradas de operacion (escritura controlada, sin proveedores reales) -----

export const pulsoIrisPatientInputSchema = z.object({
  fullName: z.string().min(2).optional(),
  documentType: z.string().min(2).optional(),
  documentNumberMasked: z.string().min(3).optional(),
  phone: z.string().min(5).optional(),
  preferredChannel: pulsoIrisChannelSchema.optional(),
  status: pulsoIrisPatientStatusSchema.optional()
});

export const pulsoIrisConversationInputSchema = z.object({
  patientId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  channel: pulsoIrisChannelSchema,
  direction: pulsoIrisDirectionSchema.optional(),
  primaryIntent: z.string().min(2).optional(),
  firstResponseSeconds: z.number().nonnegative().optional()
});

export const pulsoIrisConversationPatchSchema = z.object({
  status: pulsoIrisConversationStatusSchema.optional(),
  primaryIntent: z.string().min(2).optional(),
  siteId: z.string().uuid().optional(),
  ended: z.boolean().optional()
});

export const pulsoIrisMessageInputSchema = z.object({
  sender: z.enum(["sofia", "patient", "advisor", "system"]),
  body: z.string().min(1)
});

export const pulsoIrisAppointmentOriginSchema = z.enum(["sofia_voz", "sofia_wa", "advisor", "legacy"]);

export const pulsoIrisAppointmentInputSchema = z.object({
  patientId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  professionalId: z.string().uuid().optional(),
  payerId: z.string().uuid().optional(),
  appointmentTypeId: z.string().uuid().optional(),
  appointmentType: z.string().min(2).optional(),
  scheduledAt: z.string().datetime().optional(),
  holdId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(4).max(200).optional(),
  origin: pulsoIrisAppointmentOriginSchema.optional()
});

export const pulsoIrisAppointmentPatchSchema = z.object({
  status: pulsoIrisAppointmentStatusSchema.optional(),
  scheduledAt: z.string().datetime().optional(),
  siteId: z.string().uuid().optional(),
  professionalId: z.string().uuid().optional(),
  holdId: z.string().uuid().optional()
});

export const pulsoIrisHandoffInputSchema = z.object({
  conversationId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  triggerCode: z.string().min(2),
  priority: pulsoIrisHandoffPrioritySchema.optional(),
  summary: z.string().min(2).optional(),
  slaDueAt: z.string().datetime().optional()
});

export const pulsoIrisHandoffPatchSchema = z.object({
  status: pulsoIrisHandoffStatusSchema.optional(),
  priority: pulsoIrisHandoffPrioritySchema.optional(),
  summary: z.string().min(2).optional()
});

export const pulsoIrisRpaActionTypeSchema = z.enum([
  "check_availability",
  "register_appointment",
  "cancel",
  "reschedule",
  "confirm",
  "sweep",
  "create_patient"
]);

export const pulsoIrisRpaActionInputSchema = z.object({
  actionType: pulsoIrisRpaActionTypeSchema,
  appointmentId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  idempotencyKey: z.string().min(4)
});

export const pulsoIrisRpaActionPatchSchema = z.object({
  status: pulsoIrisRpaActionStatusSchema.optional(),
  workerId: z.string().uuid().optional(),
  phase: z.string().min(2).optional(),
  durationMs: z.number().int().nonnegative().optional()
});

export const pulsoIrisWorkerStatusSchema = z.enum(["active", "standby", "quarantine", "maintenance", "inactive"]);

export const pulsoIrisWorkerSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  vpsHost: optionalFromNull(z.string().min(1)),
  status: pulsoIrisWorkerStatusSchema,
  sessionStartedAt: isoDateTimeOptional,
  lastKeepaliveAt: isoDateTimeOptional,
  currentAction: optionalFromNull(z.string().min(1)),
  cpuPct: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisWorkerListSchema = z.array(pulsoIrisWorkerSchema);

export const pulsoIrisCampaignTypeSchema = z.enum(["reminder", "reactivation", "confirmation", "survey", "reschedule"]);
export const pulsoIrisCampaignStatusSchema = z.enum(["draft", "active", "paused", "finished"]);

export const pulsoIrisCampaignSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  campaignType: pulsoIrisCampaignTypeSchema,
  status: pulsoIrisCampaignStatusSchema,
  channels: z.array(z.string()).default([]),
  segment: z.record(z.unknown()).default({}),
  cadence: z.record(z.unknown()).default({}),
  budgetCop: optionalFromNull(z.coerce.number()),
  stats: z.record(z.unknown()).default({}),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisCampaignListSchema = z.array(pulsoIrisCampaignSchema);

export const pulsoIrisCampaignInputSchema = z.object({
  name: z.string().min(2),
  campaignType: pulsoIrisCampaignTypeSchema,
  status: pulsoIrisCampaignStatusSchema.optional(),
  channels: z.array(z.string()).optional(),
  segment: z.record(z.unknown()).optional(),
  cadence: z.record(z.unknown()).optional(),
  budgetCop: z.number().nonnegative().optional(),
  stats: z.record(z.unknown()).optional()
});

export const pulsoIrisWaitlistStatusSchema = z.enum(["active", "offered", "fulfilled", "expired"]);

export const pulsoIrisWaitlistInputSchema = z.object({
  patientId: z.string().uuid().optional(),
  appointmentTypeId: z.string().uuid().optional(),
  sites: z.array(z.string().uuid()).optional(),
  timeSlots: z.array(z.string()).optional(),
  clinicalPriority: z.number().int().min(0).max(100).optional(),
  deadline: z.string().optional(),
  status: pulsoIrisWaitlistStatusSchema.optional()
});

export type PulsoIrisPatientInput = z.infer<typeof pulsoIrisPatientInputSchema>;
export type PulsoIrisConversationInput = z.infer<typeof pulsoIrisConversationInputSchema>;
export type PulsoIrisAppointmentInput = z.infer<typeof pulsoIrisAppointmentInputSchema>;
export type PulsoIrisHandoffInput = z.infer<typeof pulsoIrisHandoffInputSchema>;
export type PulsoIrisRpaActionInput = z.infer<typeof pulsoIrisRpaActionInputSchema>;
export type PulsoIrisWorker = z.infer<typeof pulsoIrisWorkerSchema>;
export type PulsoIrisCampaign = z.infer<typeof pulsoIrisCampaignSchema>;

export const pulsoIrisOperationalKpisSchema = z.object({
  conversationsActive: z.number().int().nonnegative(),
  conversationsResolvedToday: z.number().int().nonnegative(),
  appointmentsVerifiedToday: z.number().int().nonnegative(),
  handoffsOpen: z.number().int().nonnegative(),
  rpaActionsQueued: z.number().int().nonnegative(),
  rpaActionsDeferred: z.number().int().nonnegative()
});

export const pulsoIrisCatalogSchema = z.object({
  product: z.object({
    code: z.literal(pulsoIrisProductCode),
    name: z.literal("PULSO IRIS"),
    status: productStatusSchema,
    ownerService: z.literal("pulso-iris-service")
  }),
  agent: z.object({
    code: z.literal(pulsoIrisAgentCode),
    name: z.literal("Sofia"),
    channel: z.literal("voice_whatsapp"),
    status: agentStatusSchema
  }),
  modules: z.array(
    z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      status: productStatusSchema,
      description: z.string().min(1)
    })
  )
});

export type PulsoIrisAdministrativePatient = z.infer<typeof pulsoIrisAdministrativePatientSchema>;
export type PulsoIrisConversation = z.infer<typeof pulsoIrisConversationSchema>;
export type PulsoIrisMessage = z.infer<typeof pulsoIrisMessageSchema>;
export type PulsoIrisAppointment = z.infer<typeof pulsoIrisAppointmentSchema>;
export type PulsoIrisRpaAction = z.infer<typeof pulsoIrisRpaActionSchema>;
export type PulsoIrisHandoff = z.infer<typeof pulsoIrisHandoffSchema>;
export type PulsoIrisOperationalKpis = z.infer<typeof pulsoIrisOperationalKpisSchema>;
export type PulsoIrisCatalog = z.infer<typeof pulsoIrisCatalogSchema>;

export const pulsoIrisCatalog: PulsoIrisCatalog = pulsoIrisCatalogSchema.parse({
  product: {
    code: pulsoIrisProductCode,
    name: "PULSO IRIS",
    status: "building",
    ownerService: "pulso-iris-service"
  },
  agent: {
    code: pulsoIrisAgentCode,
    name: "Sofia",
    channel: "voice_whatsapp",
    status: "draft"
  },
  modules: [
    {
      code: "INBOUND",
      name: "Inbound voz y WhatsApp",
      status: "foundation",
      description: "Recepcion masiva, identificacion, intenciones y continuidad conversacional."
    },
    {
      code: "AGENDA",
      name: "Agendador end-to-end",
      status: "foundation",
      description: "Disponibilidad, citas, confirmaciones, reagenda, cancelacion y lista de espera."
    },
    {
      code: "RPA",
      name: "Dispatcher RPA",
      status: "foundation",
      description: "Cola de acciones contra el software de agendamiento legado sin API."
    },
    {
      code: "HANDOFF",
      name: "Handoff CEDCO",
      status: "foundation",
      description: "Transferencia humana con contexto, prioridad y SLA."
    },
    {
      code: "OPERATIONS",
      name: "Consola operativa y BI",
      status: "foundation",
      description: "Ficha administrativa, estado en vivo, KPIs y trazabilidad."
    }
  ]
});

export const lumenEncounterStatusSchema = z.enum(["preconsultation", "in_progress", "review", "approved"]);
export const lumenDictationStatusSchema = z.enum(["transcribed", "failed"]);
export const lumenClinicalRecordStatusSchema = z.enum(["draft", "approved"]);

const lumenEyeTextSchema = z.object({
  right: z.string().max(2000).nullable(),
  left: z.string().max(2000).nullable()
});

export const lumenClinicalRecordContentSchema = z.object({
  reasonForVisit: z.string().max(4000),
  history: z.string().max(8000),
  visualAcuity: lumenEyeTextSchema,
  intraocularPressure: lumenEyeTextSchema,
  biomicroscopy: lumenEyeTextSchema,
  fundus: lumenEyeTextSchema,
  assessment: z.array(
    z.object({
      description: z.string().min(1).max(2000),
      code: z.string().max(80).nullable(),
      confidence: z.number().min(0).max(1)
    })
  ),
  plan: z.array(z.string().min(1).max(2000)),
  uncertainties: z.array(
    z.object({
      field: z.string().min(1).max(120),
      message: z.string().min(1).max(1000),
      sourceText: z.string().max(2000).nullable()
    })
  )
});

export const lumenPreconsultationSummarySchema = z.object({
  summaryText: z.string().min(1).max(8000),
  activeDiagnoses: z.array(z.string().min(1).max(500)),
  medications: z.array(z.string().min(1).max(500)),
  alerts: z.array(z.string().min(1).max(1000)),
  trends: z.array(
    z.object({
      label: z.string().min(1).max(160),
      unit: z.string().max(40),
      points: z.array(z.object({ recordedAt: z.string(), value: z.number() }))
    })
  ),
  sourceCount: z.number().int().nonnegative()
});

export const lumenWorklistEntrySchema = z.object({
  encounterId: z.string().uuid(),
  tenantId: tenantIdSchema,
  patientId: z.string().uuid(),
  patientDisplayName: z.string().min(1),
  patientAge: z.number().int().nonnegative().nullable(),
  professionalName: z.string().min(1),
  siteName: z.string().min(1),
  scheduledAt: isoDateTime,
  status: lumenEncounterStatusSchema,
  isDemo: z.boolean()
});

export const lumenDictationSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  encounterId: z.string().uuid(),
  status: lumenDictationStatusSchema,
  transcript: z.string(),
  mimeType: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  createdAt: isoDateTime
});

export const lumenClinicalRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  encounterId: z.string().uuid(),
  dictationId: z.string().uuid().nullable(),
  status: lumenClinicalRecordStatusSchema,
  schemaVersion: z.string().min(1),
  content: lumenClinicalRecordContentSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  approvedBy: z.string().uuid().nullable(),
  approvedAt: isoDateTimeOptional,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const lumenEncounterDetailSchema = z.object({
  encounter: lumenWorklistEntrySchema,
  preconsultation: lumenPreconsultationSummarySchema.nullable(),
  dictations: z.array(lumenDictationSchema),
  clinicalRecord: lumenClinicalRecordSchema.nullable()
});

export const lumenTranscriptionInputSchema = z.object({
  audioBase64: z.string().min(20).max(900_000),
  mimeType: z.string().regex(/^audio\//),
  durationSeconds: z.number().int().min(1).max(90).optional()
});

export const lumenStructureInputSchema = z.object({
  transcript: z.string().trim().min(10).max(20_000),
  dictationId: z.string().uuid().optional()
});

export const lumenClinicalRecordPatchSchema = z.object({
  content: lumenClinicalRecordContentSchema
});

export type LumenEncounterStatus = z.infer<typeof lumenEncounterStatusSchema>;
export type LumenClinicalRecordContent = z.infer<typeof lumenClinicalRecordContentSchema>;
export type LumenPreconsultationSummary = z.infer<typeof lumenPreconsultationSummarySchema>;
export type LumenWorklistEntry = z.infer<typeof lumenWorklistEntrySchema>;
export type LumenDictation = z.infer<typeof lumenDictationSchema>;
export type LumenClinicalRecord = z.infer<typeof lumenClinicalRecordSchema>;
export type LumenEncounterDetail = z.infer<typeof lumenEncounterDetailSchema>;

export const lumenCatalog = {
  product: {
    code: lumenProductCode,
    name: "LUMEN",
    status: "building" as const,
    ownerService: "lumen-service" as const
  },
  modules: [
    {
      code: "CLINICAL_DEMO",
      name: "Consulta clínica por voz",
      status: "building" as const,
      description: "Resumen preconsulta, dictado, historia estructurada y aprobación profesional."
    }
  ]
};

export const productModuleSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  status: productStatusSchema,
  ownerService: serviceNameSchema,
  description: z.string().min(1)
});

export type ProductModule = z.infer<typeof productModuleSchema>;

export const platformCatalogSchema = z.object({
  services: z.array(
    z.object({
      name: serviceNameSchema,
      port: z.number().int().positive(),
      responsibility: z.string().min(1)
    })
  ),
  productModules: z.array(productModuleSchema)
});

export type PlatformCatalog = z.infer<typeof platformCatalogSchema>;

export const authLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export const operatorRoleSchema = z.enum(["admin", "coordinator", "advisor", "auditor"]);
export type OperatorRole = z.infer<typeof operatorRoleSchema>;

export const authOperatorSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  role: operatorRoleSchema
});

export const authSessionSchema = z.object({
  token: z.string().min(20),
  expiresAt: isoDateTime,
  operator: authOperatorSchema
});

export const authMeSchema = z.object({
  operator: authOperatorSchema,
  tenantIds: z.array(z.string().uuid())
});

export type AuthLoginRequest = z.infer<typeof authLoginRequestSchema>;
export type AuthOperator = z.infer<typeof authOperatorSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type AuthMe = z.infer<typeof authMeSchema>;

export const operatorCreateSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2),
  password: z.string().min(8),
  role: operatorRoleSchema,
  tenantIds: z.array(z.string().uuid()).default([])
});

export const operatorPatchSchema = z.object({
  displayName: z.string().min(2).optional(),
  password: z.string().min(8).optional(),
  role: operatorRoleSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  tenantIds: z.array(z.string().uuid()).optional()
});

export const operatorListItemSchema = authOperatorSchema.extend({
  status: z.enum(["active", "disabled"]),
  tenantIds: z.array(z.string().uuid()).default([]),
  createdAt: isoDateTime
});

export const operatorListSchema = z.array(operatorListItemSchema);
export type OperatorCreateInput = z.infer<typeof operatorCreateSchema>;
export type OperatorPatchInput = z.infer<typeof operatorPatchSchema>;
export type OperatorListItem = z.infer<typeof operatorListItemSchema>;

export const pulsoIrisAuditEventTypeSchema = z.enum([
  "agenda.settings.updated",
  "agenda.configuration.imported",
  "appointment.hold.created",
  "appointment.hold.expired",
  "appointment.pending_external_confirmation",
  "appointment.manually_verified",
  "appointment.external_rejected",
  "appointment.registered",
  "appointment.verified",
  "appointment.rescheduled",
  "appointment.cancelled",
  "channel.message.received",
  "channel.message.sent",
  "agent.execution.completed",
  "agent.tool.executed",
  "agent.response.created",
  "handoff.assigned",
  "config.updated"
]);

export type PulsoIrisAuditEventType = z.infer<typeof pulsoIrisAuditEventTypeSchema>;

export const auditEventSchema = z.object({
  tenantId: z.string().uuid().optional(),
  actorId: z.string().min(1).optional(),
  eventType: z.string().min(3),
  entityType: z.string().min(2),
  entityId: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).default({})
});

export type AuditEventInput = z.infer<typeof auditEventSchema>;

export interface ResponseEnvelope<TData> {
  data: TData;
  meta: {
    requestId?: string;
    generatedAt: string;
  };
}

export function envelope<TData>(data: TData, requestId?: string): ResponseEnvelope<TData> {
  return {
    data,
    meta: {
      requestId,
      generatedAt: new Date().toISOString()
    }
  };
}

export const serviceCatalog: PlatformCatalog["services"] = [
  {
    name: "api-gateway",
    port: 8080,
    responsibility: "Entrada HTTP publica, health agregado y fachada de plataforma."
  },
  {
    name: "identity-service",
    port: 8081,
    responsibility: "Operadores, autenticacion, sesiones y permisos."
  },
  {
    name: "tenant-service",
    port: 8082,
    responsibility: "Clientes, organizaciones, ambientes y configuracion por tenant."
  },
  {
    name: "agent-service",
    port: 8083,
    responsibility: "Agentes IA, productos, canales y ciclo de vida operacional."
  },
  {
    name: "prompt-flow-service",
    port: 8084,
    responsibility: "Versionado de prompts, flujos conversacionales y reglas de ejecucion."
  },
  {
    name: "knowledge-service",
    port: 8085,
    responsibility: "Fuentes de conocimiento, ingesta, indices y trazabilidad documental."
  },
  {
    name: "audit-service",
    port: 8086,
    responsibility: "Bitacora inmutable, eventos de negocio y evidencia operacional."
  },
  {
    name: "integration-service",
    port: 8087,
    responsibility: "Conectores externos como voz, WhatsApp, GLPI, ERP y activos."
  },
  {
    name: "pulso-iris-service",
    port: 8088,
    responsibility: "Producto PULSO IRIS: Sofia, agenda, handoff, RPA y operacion CEDCO."
  },
  {
    name: "whatsapp-channel-service",
    port: 8089,
    responsibility: "Canal temporal WhatsApp Web de prueba: QR, sesion durable y entrega de texto autorizada."
  },
  {
    name: "lumen-service",
    port: 8090,
    responsibility: "Producto LUMEN: resumen preconsulta, voz clínica, HC estructurada y aprobación profesional."
  }
];

export const productModules: ProductModule[] = [
  {
    code: "CORE",
    name: "Nucleo Hyperion",
    status: "building",
    ownerService: "api-gateway",
    description: "Base comun para identidad, tenants, auditoria, integraciones y productos."
  },
  {
    code: pulsoIrisProductCode,
    name: "PULSO IRIS",
    status: "building",
    ownerService: "pulso-iris-service",
    description: "Atencion y agendamiento inbound con IA para salud visual."
  },
  {
    code: lumenProductCode,
    name: "LUMEN",
    status: "building",
    ownerService: "lumen-service",
    description: "Documentacion clinica por voz y expediente estructurado para salud visual."
  },
  {
    code: "CEDCO-R03",
    name: "CEDCO Activos Fijos",
    status: "foundation",
    ownerService: "integration-service",
    description: "Modulo posterior para activos, GLPI, ERP e inventario."
  }
];
