import { productGrantSchema, type AccessPrincipal } from "@hyperion/platform-contracts";
import { z } from "zod";

export * from "./domain.js";
export * from "./sofia-context.js";
export * from "./bff-route-policies.js";

export const pulsoProductId = "PULSO_IRIS" as const;
export const pulsoConsoleRequestHeaderValue = "pulso-console" as const;
export const pulsoProductRoleSchema = z.enum(["admin", "coordinator", "advisor", "auditor"]);
export const pulsoCapabilitySchema = z.enum(["pulso:read", "pulso:write", "pulso:admin"]);

/**
 * Browser-facing namespaces that exist today. SOFIA, Prompt Flow, Knowledge and
 * WhatsApp remain cell-internal behind PULSO Core/Integration until they expose
 * a tenant-scoped customer API of their own.
 */
export const pulsoCellComponentSchema = z.enum(["pulso-iris", "integrations"]);
export const pulsoCellServiceSchema = z.enum(["core", "sofia", "prompt-flow", "knowledge", "integration", "whatsapp"]);

export const pulsoGrantSchema = productGrantSchema.extend({
  productId: z.literal(pulsoProductId),
  roles: z.array(pulsoProductRoleSchema).min(1),
  capabilities: z.array(pulsoCapabilitySchema).min(1)
});

/**
 * Provider-owned precondition for Channel to claim a queued PULSO message.
 * This is carried in an authenticated JSON body so message content never
 * appears in request URLs, access logs or proxy query telemetry.
 */
export const pulsoDeliveryGuardRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    body: z.string().min(1).max(4096),
    expectedDeliveryStatus: z.literal("queued")
  })
  .strict();

export const pulsoDeliveryGuardResultSchema = z
  .object({
    messageId: z.string().uuid(),
    matches: z.boolean()
  })
  .strict();

export type PulsoProductRole = z.infer<typeof pulsoProductRoleSchema>;
export type PulsoCapability = z.infer<typeof pulsoCapabilitySchema>;
export type PulsoCellComponent = z.infer<typeof pulsoCellComponentSchema>;
export type PulsoCellService = z.infer<typeof pulsoCellServiceSchema>;
export type PulsoGrant = z.infer<typeof pulsoGrantSchema>;
export type PulsoDeliveryGuardRequest = z.infer<typeof pulsoDeliveryGuardRequestSchema>;
export type PulsoDeliveryGuardResult = z.infer<typeof pulsoDeliveryGuardResultSchema>;

export function findPulsoGrant(principal: AccessPrincipal, tenantId: string): PulsoGrant | undefined {
  for (const grant of principal.grants) {
    if (!grant.active || grant.tenantId !== tenantId || grant.productId !== pulsoProductId) continue;
    const parsed = pulsoGrantSchema.safeParse(grant);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function pulsoCapabilityForMethod(method: string): PulsoCapability {
  return method === "GET" || method === "HEAD" ? "pulso:read" : "pulso:write";
}

export function pulsoGrantAllows(grant: PulsoGrant, required: PulsoCapability): boolean {
  return grant.capabilities.includes("pulso:admin") || grant.capabilities.includes(required);
}

export function pulsoServiceForComponent(component: PulsoCellComponent): PulsoCellService {
  return component === "pulso-iris" ? "core" : "integration";
}
