import type { LumenCapability, LumenGrant } from "@hyperion/lumen-contracts";
import type { AccessOperator } from "@hyperion/platform-contracts";

export type { LumenCapability, LumenGrant } from "@hyperion/lumen-contracts";

export interface ClinicalTenant {
  id: string;
  displayName: string;
}

/** Public session projection returned by the same-origin LUMEN BFF. */
export interface LumenSession {
  operator: AccessOperator;
  tenants: ClinicalTenant[];
  grants: LumenGrant[];
  /** Double-submit token returned in JSON; the authenticated session cookie remains HttpOnly. */
  csrfToken: string;
}

export function viewGrantFor(session: LumenSession): LumenGrant | undefined {
  return session.grants.find(
    (grant) => grant.active && grant.productId === "LUMEN" && hasLumenCapability(grant, "lumen:read")
  );
}

export function hasLumenCapability(grant: LumenGrant, capability: LumenCapability): boolean {
  return grant.capabilities.includes("lumen:admin") || grant.capabilities.includes(capability);
}
