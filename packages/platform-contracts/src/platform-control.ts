/**
 * Isolated browser-safe control-plane identifier. This subpath deliberately
 * has no schema/runtime dependencies so administrative bundles do not execute
 * the full Access contract module merely to compare one tenant identifier.
 */
export const platformControlTenantId = "00000000-0000-4000-8000-000000000001" as const;
