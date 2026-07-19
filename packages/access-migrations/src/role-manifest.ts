/**
 * Pure Access database identity manifest shared with runtime boundary probes.
 * It intentionally contains no environment readers, credentials or bootstrap
 * behavior so Identity and Tenant images can carry it without migration
 * authority.
 */
export const ACCESS_MIGRATOR_ROLE = "hyperion_access_migrator" as const;

export const ACCESS_RUNTIME_DATABASE_ROLES = [
  { environmentVariable: "IDENTITY_DATABASE_PASSWORD", role: "hyperion_identity" },
  { environmentVariable: "TENANT_DATABASE_PASSWORD", role: "hyperion_tenant" }
] as const;

export type AccessRuntimeDatabaseRole = (typeof ACCESS_RUNTIME_DATABASE_ROLES)[number]["role"];
export type AccessRolePasswords = ReadonlyMap<AccessRuntimeDatabaseRole, string>;
