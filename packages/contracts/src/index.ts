import { z } from "zod";

export const serviceNameSchema = z.enum([
  "api-gateway",
  "identity-service",
  "tenant-service",
  "agent-service",
  "prompt-flow-service",
  "knowledge-service",
  "audit-service",
  "integration-service"
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

export const productModuleSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  status: productStatusSchema,
  ownerService: serviceNameSchema,
  description: z.string().min(1)
});

export type ProductModule = z.infer<typeof productModuleSchema>;

export const platformCatalogSchema = z.object({
  services: z.array(z.object({
    name: serviceNameSchema,
    port: z.number().int().positive(),
    responsibility: z.string().min(1)
  })),
  productModules: z.array(productModuleSchema)
});

export type PlatformCatalog = z.infer<typeof platformCatalogSchema>;

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
    code: "CEDCO-R02",
    name: "CEDCO Agente de Voz y Plataforma",
    status: "foundation",
    ownerService: "agent-service",
    description: "Producto CEDCO inicial sobre el nucleo de plataforma."
  },
  {
    code: "CEDCO-R03",
    name: "CEDCO Activos Fijos",
    status: "foundation",
    ownerService: "integration-service",
    description: "Modulo posterior para activos, GLPI, ERP e inventario."
  }
];
