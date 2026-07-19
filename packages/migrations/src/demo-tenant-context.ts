const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Demo tooling must receive the same opaque tenant identity used by runtime
 * grants. Looking up a customer by a well-known slug can silently seed or
 * clear the wrong tenant after a rename, clone or restore.
 */
export function requireDemoTenantId(
  environment: NodeJS.ProcessEnv,
  variableName: "LUMEN_DEMO_TENANT_ID" | "PULSO_DEMO_TENANT_ID"
): string {
  const value = environment[variableName]?.trim();
  if (!value) {
    throw new Error(`${variableName} is required; tenant selection by slug is forbidden`);
  }
  if (!TENANT_ID_PATTERN.test(value)) {
    throw new Error(`${variableName} must be an explicit tenant UUID`);
  }
  return value.toLowerCase();
}
