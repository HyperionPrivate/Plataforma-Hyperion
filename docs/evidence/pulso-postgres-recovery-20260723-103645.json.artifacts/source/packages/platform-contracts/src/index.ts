import { z } from "zod";

export * from "./access-tenant-snapshot.js";
export * from "./exact-route-policy.js";

// Health is a neutral platform protocol. Service names are intentionally open
// so adding a provider-owned component never requires editing a global catalog.
export const serviceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{1,127}$/);
export type ServiceName = z.infer<typeof serviceNameSchema>;

export const healthStatusSchema = z.enum(["ok", "degraded", "down"]);
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const dependencyHealthSchema = z
  .object({
    name: z.string().min(1),
    status: healthStatusSchema,
    latencyMs: z.number().nonnegative().optional(),
    detail: z.string().optional()
  })
  .strict();

export const serviceHealthSchema = z
  .object({
    service: serviceNameSchema,
    status: healthStatusSchema,
    version: z.string().min(1),
    checkedAt: z.string().datetime(),
    uptimeSeconds: z.number().nonnegative(),
    dependencies: z.array(dependencyHealthSchema).default([])
  })
  .strict();
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

export const platformHealthSchema = z
  .object({
    status: healthStatusSchema,
    checkedAt: z.string().datetime(),
    services: z.array(serviceHealthSchema)
  })
  .strict();
export type PlatformHealth = z.infer<typeof platformHealthSchema>;

/** Reserved system tenant for global platform administration; never customer-selectable. */
export const platformControlTenantId = "00000000-0000-4000-8000-000000000001" as const;
export const platformControlTenantIdSchema = z.literal(platformControlTenantId);

export const tenantIdSchema = z.string().uuid();
export const productIdSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
export const platformRoleSchema = z.enum(["admin", "coordinator", "advisor", "auditor"]);
export const productRoleSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);
export const capabilitySchema = z.string().regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/);

function uniqueValues(values: string[]): boolean {
  return new Set(values).size === values.length;
}

const productRolesSchema = z.array(productRoleSchema).min(1).max(32).refine(uniqueValues, "roles must be unique");
const capabilitiesSchema = z
  .array(capabilitySchema)
  .min(1)
  .max(128)
  .refine(uniqueValues, "capabilities must be unique");

export const productGrantSchema = z
  .object({
    tenantId: tenantIdSchema,
    productId: productIdSchema,
    roles: productRolesSchema,
    capabilities: capabilitiesSchema,
    active: z.boolean().default(true)
  })
  .strict();

export const productGrantUpsertSchema = z
  .object({
    roles: productRolesSchema,
    capabilities: capabilitiesSchema,
    active: z.boolean().default(true)
  })
  .strict();

export const accessOperatorSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
    role: platformRoleSchema
  })
  .strict();

export const accessPrincipalSchema = z
  .object({
    operator: accessOperatorSchema,
    grants: z.array(productGrantSchema)
  })
  .strict();

export const accessLoginRequestSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8).max(512)
  })
  .strict();

export const accessSessionSchema = z
  .object({
    token: z.string().min(20),
    accessToken: z.string().min(20),
    tokenType: z.literal("Bearer"),
    expiresAt: z.string().datetime(),
    operator: accessOperatorSchema,
    grants: z.array(productGrantSchema)
  })
  .strict()
  .refine((session) => session.token === session.accessToken, "token aliases must match");

// N-1 Access endpoints remain available during the cookie/session cutover. They
// are Access-owned compatibility contracts, not part of a product catalog.
const accessDateTimeSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().datetime()
);
export const operatorRoleSchema = platformRoleSchema;
export const authLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});
export const authOperatorSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1),
  role: operatorRoleSchema
});
export const authSessionSchema = z.object({
  token: z.string().min(20),
  expiresAt: accessDateTimeSchema,
  operator: authOperatorSchema
});
export const authMeSchema = z.object({
  operator: authOperatorSchema,
  tenantIds: z.array(tenantIdSchema)
});
export const operatorCreateSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2),
  password: z.string().min(8),
  role: operatorRoleSchema,
  tenantIds: z.array(tenantIdSchema).default([])
});
export const operatorPatchSchema = z.object({
  displayName: z.string().min(2).optional(),
  password: z.string().min(8).optional(),
  role: operatorRoleSchema.optional(),
  status: z.enum(["active", "disabled"]).optional(),
  tenantIds: z.array(tenantIdSchema).optional()
});
export const operatorListItemSchema = authOperatorSchema.extend({
  status: z.enum(["active", "disabled"]),
  tenantIds: z.array(tenantIdSchema).default([]),
  createdAt: accessDateTimeSchema
});
export const operatorListSchema = z.array(operatorListItemSchema);

export const accessMeSchema = accessPrincipalSchema.extend({
  tenantIds: z.array(tenantIdSchema)
});

export const accessJwkSchema = z
  .object({
    kty: z.literal("RSA"),
    kid: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    n: z.string().min(1),
    e: z.string().min(1),
    alg: z.literal("RS256"),
    use: z.literal("sig")
  })
  .strict();

export const accessJwksSchema = z
  .object({
    keys: z.array(accessJwkSchema).min(1).max(8)
  })
  .strict();

export const accessTokenClaimsSchema = z
  .object({
    sub: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
    platformRole: platformRoleSchema,
    grants: z.array(productGrantSchema),
    iss: z.string().min(1),
    aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    exp: z.number().int().positive(),
    nbf: z.number().int().nonnegative().optional(),
    iat: z.number().int().nonnegative().optional(),
    jti: z.string().min(1).optional()
  })
  .passthrough();

export type PlatformRole = z.infer<typeof platformRoleSchema>;
export type ProductGrant = z.infer<typeof productGrantSchema>;
export type ProductGrantUpsert = z.infer<typeof productGrantUpsertSchema>;
export type AccessOperator = z.infer<typeof accessOperatorSchema>;
export type AccessPrincipal = z.infer<typeof accessPrincipalSchema>;
export type AccessLoginRequest = z.infer<typeof accessLoginRequestSchema>;
export type AccessSession = z.infer<typeof accessSessionSchema>;
export type AccessMe = z.infer<typeof accessMeSchema>;
export type AccessJwk = z.infer<typeof accessJwkSchema>;
export type AccessJwks = z.infer<typeof accessJwksSchema>;
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;
export type AuthLoginRequest = z.infer<typeof authLoginRequestSchema>;
export type AuthOperator = z.infer<typeof authOperatorSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type AuthMe = z.infer<typeof authMeSchema>;
export type OperatorCreateInput = z.infer<typeof operatorCreateSchema>;
export type OperatorPatchInput = z.infer<typeof operatorPatchSchema>;
export type OperatorListItem = z.infer<typeof operatorListItemSchema>;

export function principalFromAccessTokenClaims(claims: AccessTokenClaims): AccessPrincipal {
  return accessPrincipalSchema.parse({
    operator: {
      id: claims.sub,
      email: claims.email,
      displayName: claims.displayName,
      role: claims.platformRole
    },
    grants: claims.grants
  });
}

export function findActiveProductGrant(
  principal: AccessPrincipal,
  tenantId: string,
  productId: string
): ProductGrant | undefined {
  return principal.grants.find((grant) => grant.active && grant.tenantId === tenantId && grant.productId === productId);
}

export interface ResponseEnvelope<T> {
  data: T;
  meta: { requestId?: string; generatedAt: string };
}

export function envelope<T>(data: T, requestId?: string): ResponseEnvelope<T> {
  return {
    data,
    meta: { requestId, generatedAt: new Date().toISOString() }
  };
}
