import { platformControlTenantId } from "@hyperion/platform-contracts/platform-control";

export interface AdministrativeGrantIdentity {
  operatorId: string;
  tenantId: string;
  productId: string;
}

export function parseUniqueValues(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

export function platformGrantPath(grant: AdministrativeGrantIdentity): string {
  return `/v1/platform/grants/${encodeURIComponent(grant.operatorId)}/${encodeURIComponent(grant.tenantId)}/${encodeURIComponent(grant.productId)}`;
}

export function isProtectedControlGrant(operatorId: string, grant: AdministrativeGrantIdentity): boolean {
  return (
    grant.operatorId === operatorId && grant.tenantId === platformControlTenantId && grant.productId === "PLATFORM"
  );
}

export function wouldDowngradeOwnControlGrant(
  operatorId: string,
  grant: AdministrativeGrantIdentity,
  roles: string[],
  capabilities: string[]
): boolean {
  return (
    isProtectedControlGrant(operatorId, grant) &&
    (!roles.includes("platform-admin") || !capabilities.includes("manage:platform"))
  );
}
