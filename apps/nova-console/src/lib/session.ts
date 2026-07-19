import type { NovaCapability, NovaGrant, NovaProductRole as NovaRole } from "@hyperion/nova-contracts";
import type { AccessPrincipal, PlatformRole } from "@hyperion/platform-contracts";

export type { NovaCapability, NovaGrant, NovaRole, AccessPrincipal, PlatformRole };

const NOVA_ROLES = new Set<NovaRole>(["admin", "supervisor", "asesor"]);
const NOVA_CAPABILITIES = new Set<NovaCapability>(["nova:read", "nova:write", "nova:admin"]);
const PLATFORM_ROLES = new Set<PlatformRole>(["admin", "coordinator", "advisor", "auditor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseAccessPrincipal(value: unknown): AccessPrincipal {
  const candidate = isRecord(value) && isRecord(value.principal) ? value.principal : value;
  if (!isRecord(candidate) || !isRecord(candidate.operator) || !Array.isArray(candidate.grants)) {
    throw new Error("La sesión no contiene un principal de acceso válido");
  }

  const operator = candidate.operator;
  if (
    typeof operator.id !== "string" ||
    typeof operator.email !== "string" ||
    typeof operator.displayName !== "string" ||
    typeof operator.role !== "string" ||
    !PLATFORM_ROLES.has(operator.role as PlatformRole)
  ) {
    throw new Error("La sesión no contiene un operador válido");
  }

  const grants = candidate.grants.map((grant) => {
    if (
      !isRecord(grant) ||
      typeof grant.tenantId !== "string" ||
      typeof grant.productId !== "string" ||
      !isStringArray(grant.roles) ||
      !isStringArray(grant.capabilities)
    ) {
      throw new Error("La sesión contiene un grant inválido");
    }
    return {
      tenantId: grant.tenantId,
      productId: grant.productId,
      roles: grant.roles,
      capabilities: grant.capabilities,
      active: grant.active !== false
    };
  });

  return {
    operator: {
      id: operator.id,
      email: operator.email,
      displayName: operator.displayName,
      role: operator.role as PlatformRole
    },
    grants
  };
}

export function findNovaGrant(principal: AccessPrincipal, tenantId: string): NovaGrant | undefined {
  const grant = principal.grants.find(
    (candidate) => candidate.active && candidate.productId === "NOVA" && candidate.tenantId === tenantId
  );
  if (!grant) return undefined;

  const roles = grant.roles.filter((role): role is NovaRole => NOVA_ROLES.has(role as NovaRole));
  const capabilities = grant.capabilities.filter((capability): capability is NovaCapability =>
    NOVA_CAPABILITIES.has(capability as NovaCapability)
  );
  if (roles.length === 0 || capabilities.length === 0) return undefined;

  return { ...grant, productId: "NOVA", roles, capabilities };
}

export function novaGrantAllows(grant: NovaGrant | undefined, capability: NovaCapability): boolean {
  return Boolean(grant && (grant.capabilities.includes("nova:admin") || grant.capabilities.includes(capability)));
}

export function authorizedNovaTenantIds(principal: AccessPrincipal): string[] {
  return [
    ...new Set(
      principal.grants.filter((grant) => findNovaGrant(principal, grant.tenantId)).map((grant) => grant.tenantId)
    )
  ];
}

export function primaryNovaRole(grant: NovaGrant): NovaRole {
  if (grant.roles.includes("admin")) return "admin";
  if (grant.roles.includes("supervisor")) return "supervisor";
  return "asesor";
}
