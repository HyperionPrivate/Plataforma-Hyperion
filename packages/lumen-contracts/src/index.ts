import { productGrantSchema, type AccessPrincipal } from "@hyperion/platform-contracts";
import { z } from "zod";

export * from "./domain.js";
export * from "./projection-events.js";
export * from "./bff-route-policies.js";

export const lumenProductId = "LUMEN" as const;
export const lumenConsoleRequestHeaderValue = "lumen-console" as const;
export const lumenProductRoleSchema = z.enum(["admin", "coordinator", "advisor", "auditor"]);
export const lumenCapabilitySchema = z.enum(["lumen:read", "lumen:write", "lumen:admin"]);
export const lumenCellComponentSchema = z.enum(["lumen"]);

export const lumenGrantSchema = productGrantSchema.extend({
  productId: z.literal(lumenProductId),
  roles: z.array(lumenProductRoleSchema).min(1),
  capabilities: z.array(lumenCapabilitySchema).min(1)
});

export type LumenProductRole = z.infer<typeof lumenProductRoleSchema>;
export type LumenCapability = z.infer<typeof lumenCapabilitySchema>;
export type LumenCellComponent = z.infer<typeof lumenCellComponentSchema>;
export type LumenGrant = z.infer<typeof lumenGrantSchema>;

export const lumenCatalog = {
  product: {
    code: lumenProductId,
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
} as const;

export function findLumenGrant(principal: AccessPrincipal, tenantId: string): LumenGrant | undefined {
  for (const grant of principal.grants) {
    if (!grant.active || grant.tenantId !== tenantId || grant.productId !== lumenProductId) continue;
    const parsed = lumenGrantSchema.safeParse(grant);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function lumenCapabilityForMethod(method: string): LumenCapability {
  return method === "GET" || method === "HEAD" ? "lumen:read" : "lumen:write";
}

export function lumenGrantAllows(grant: LumenGrant, required: LumenCapability): boolean {
  return grant.capabilities.includes("lumen:admin") || grant.capabilities.includes(required);
}
