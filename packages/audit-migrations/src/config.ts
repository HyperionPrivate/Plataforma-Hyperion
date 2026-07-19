export const AUDIT_RUNTIME_ROLE = "hyperion_audit" as const;
export const AUDIT_MIGRATOR_ROLE = "hyperion_audit_migrator" as const;

const SAFE_SECRET_PATTERN = /^[A-Za-z0-9._~-]{24,}$/;

export function readAuditMigratorDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return readPostgresUrl(environment.AUDIT_MIGRATOR_DATABASE_URL, "AUDIT_MIGRATOR_DATABASE_URL", environment);
}

export function readAuditPostgresAdminUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return readPostgresUrl(environment.AUDIT_POSTGRES_ADMIN_URL, "AUDIT_POSTGRES_ADMIN_URL", environment);
}

export function readAuditPostgresDatabase(environment: NodeJS.ProcessEnv = process.env): string {
  const database = environment.AUDIT_POSTGRES_DB?.trim();
  if (!database || !/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error("AUDIT_POSTGRES_DB must be a safe lowercase PostgreSQL database name");
  }
  return database;
}

export function readAuditMigratorPassword(environment: NodeJS.ProcessEnv = process.env): string {
  return readSafeSecret(environment, "AUDIT_MIGRATOR_DATABASE_PASSWORD");
}

export function readAuditRuntimePassword(environment: NodeJS.ProcessEnv = process.env): string {
  return readSafeSecret(environment, "AUDIT_DATABASE_PASSWORD");
}

function readPostgresUrl(rawValue: string | undefined, variableName: string, environment: NodeJS.ProcessEnv): string {
  const raw = rawValue?.trim();
  if (!raw) throw new Error(`${variableName} is required`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }
  if (isRestrictedEnvironment(environment) && /replace-/i.test(raw)) {
    throw new Error(`${variableName} must not use a placeholder in production/staging`);
  }
  return raw;
}

function readSafeSecret(environment: NodeJS.ProcessEnv, variableName: string): string {
  const value = environment[variableName]?.trim();
  if (!value || !SAFE_SECRET_PATTERN.test(value)) {
    throw new Error(`${variableName} must contain at least 24 RFC 3986 unreserved characters`);
  }
  if (isRestrictedEnvironment(environment) && /^replace-/i.test(value)) {
    throw new Error(`${variableName} must not use a placeholder in production/staging`);
  }
  return value;
}

function isRestrictedEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return ["production", "staging"].includes(
    (environment.HYPERION_ENVIRONMENT ?? environment.HYPERION_ENV ?? environment.NODE_ENV ?? "development")
      .trim()
      .toLowerCase()
  );
}
