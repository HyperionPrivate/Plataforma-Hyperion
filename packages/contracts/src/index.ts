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
  "pulso-iris-service"
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

export const pulsoIrisChannelSchema = z.enum(["voice", "whatsapp"]);
export const pulsoIrisDirectionSchema = z.enum(["inbound", "outbound"]);
export const pulsoIrisConversationStatusSchema = z.enum(["active", "resolved", "handoff_required", "closed"]);
export const pulsoIrisAppointmentStatusSchema = z.enum([
  "offered",
  "registered",
  "verified",
  "confirmed",
  "rescheduled",
  "cancelled",
  "no_show"
]);
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
  channel: pulsoIrisChannelSchema,
  direction: pulsoIrisDirectionSchema,
  status: pulsoIrisConversationStatusSchema,
  primaryIntent: optionalFromNull(z.string().min(1)),
  startedAt: isoDateTime,
  endedAt: isoDateTimeOptional,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisMessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  sender: z.enum(["sofia", "patient", "advisor", "system"]),
  body: z.string().min(1),
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
  payerId: optionalFromNull(z.string().uuid()),
  appointmentType: optionalFromNull(z.string().min(1)),
  status: pulsoIrisAppointmentStatusSchema,
  scheduledAt: isoDateTimeOptional,
  legacyReference: optionalFromNull(z.string().min(1)),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

export const pulsoIrisRpaActionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  appointmentId: optionalFromNull(z.string().uuid()),
  conversationId: optionalFromNull(z.string().uuid()),
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

export const pulsoIrisSiteSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  city: z.string().min(1).optional(),
  status: z.enum(["active", "paused"]).default("active")
});

export const pulsoIrisProfessionalSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  professionalType: z.enum(["ophthalmologist", "optometrist"]),
  status: z.enum(["active", "paused"]).default("active")
});

export const pulsoIrisPayerSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  group: z.enum(["eps", "private_prepaid", "policy", "particular", "other"]),
  requiresAuthorization: z.boolean().default(false),
  status: z.enum(["active", "paused"]).default("active")
});

export const pulsoIrisConversationListSchema = z.array(pulsoIrisConversationSchema);
export const pulsoIrisAppointmentListSchema = z.array(pulsoIrisAppointmentSchema);
export const pulsoIrisHandoffListSchema = z.array(pulsoIrisHandoffSchema);
export const pulsoIrisRpaActionListSchema = z.array(pulsoIrisRpaActionSchema);

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

export const authOperatorSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  role: z.string().min(1)
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
    code: "CEDCO-R03",
    name: "CEDCO Activos Fijos",
    status: "foundation",
    ownerService: "integration-service",
    description: "Modulo posterior para activos, GLPI, ERP e inventario."
  }
];
