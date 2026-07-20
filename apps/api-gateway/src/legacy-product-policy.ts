/**
 * Legacy multiproduct gateway product facade — permanently retired (DEBT-020 / DEBT-032).
 *
 * `isLegacyGatewayEnabled()` always returns false. Product-scoped paths are still detected
 * so the gateway can return 410 and increment disabled-reject telemetry. Product BFFs are
 * the only supported entry points.
 */

export type LegacyCustomerProductId = "NOVA" | "LUMEN" | "PULSO_IRIS";

interface LegacyProductDefinition {
  productId: LegacyCustomerProductId;
  components: readonly string[];
}

export interface LegacyProductRequestScope {
  productId: LegacyCustomerProductId;
  tenantId?: string;
}

/** Permanently retired: env is ignored (DEBT-020 / DEBT-032). */
export function isLegacyGatewayEnabled(_env: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

export const legacyGatewayTelemetry = {
  deprecatedRouteHits: 0,
  disabledRejects: 0
};

export function noteLegacyGatewayDeprecatedHit(): void {
  legacyGatewayTelemetry.deprecatedRouteHits += 1;
}

export function noteLegacyGatewayDisabledReject(): void {
  legacyGatewayTelemetry.disabledRejects += 1;
}

const LEGACY_PRODUCTS: readonly LegacyProductDefinition[] = Object.freeze([
  Object.freeze({
    productId: "NOVA" as const,
    components: Object.freeze(["nova", "voice", "liwa", "documents"])
  }),
  Object.freeze({
    productId: "LUMEN" as const,
    components: Object.freeze(["lumen"])
  }),
  Object.freeze({
    productId: "PULSO_IRIS" as const,
    components: Object.freeze(["pulso-iris", "integrations"])
  })
]);

const PRODUCT_BY_ID = new Map(LEGACY_PRODUCTS.map((product) => [product.productId, product]));
const PRODUCT_BY_COMPONENT = new Map(
  LEGACY_PRODUCTS.flatMap((product) => product.components.map((component) => [component, product] as const))
);

const UNSCOPED_PRODUCT_PATHS = new Map<string, LegacyCustomerProductId>([
  ["/v1/nova/health", "NOVA"],
  ["/v1/nova/catalog", "NOVA"],
  ["/v1/voice/health", "NOVA"],
  ["/v1/liwa/health", "NOVA"],
  ["/v1/documents/health", "NOVA"],
  ["/v1/lumen/health", "LUMEN"],
  ["/v1/lumen/catalog", "LUMEN"],
  ["/v1/pulso-iris/health", "PULSO_IRIS"],
  ["/v1/pulso-iris/catalog", "PULSO_IRIS"]
]);

export function readLegacyProductRequestScope(path: string): LegacyProductRequestScope | undefined {
  const tenantMatch = path.match(/^\/v1\/tenants\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (tenantMatch) {
    const product = PRODUCT_BY_COMPONENT.get(tenantMatch[2] ?? "");
    if (!product) return undefined;
    return { productId: product.productId, tenantId: decodeURIComponent(tenantMatch[1] ?? "") };
  }

  const productId = UNSCOPED_PRODUCT_PATHS.get(path);
  return productId ? { productId } : undefined;
}

export function isLegacyCustomerProductId(productId: string): productId is LegacyCustomerProductId {
  return PRODUCT_BY_ID.has(productId as LegacyCustomerProductId);
}
