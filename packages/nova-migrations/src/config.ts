export const NOVA_CELL_DATABASE_ROLES = [
  { environmentVariable: "NOVA_DATABASE_PASSWORD", role: "hyperion_nova" },
  { environmentVariable: "VOICE_DATABASE_PASSWORD", role: "hyperion_voice" },
  { environmentVariable: "LIWA_DATABASE_PASSWORD", role: "hyperion_liwa" },
  { environmentVariable: "DOCUMENTS_DATABASE_PASSWORD", role: "hyperion_documents" }
] as const;

export type NovaCellDatabaseRole = (typeof NOVA_CELL_DATABASE_ROLES)[number]["role"];
export type NovaRolePasswords = ReadonlyMap<NovaCellDatabaseRole, string>;
export const NOVA_MIGRATOR_ROLE = "hyperion_nova_migrator" as const;

const SAFE_SECRET_PATTERN = /^[A-Za-z0-9._~-]{24,}$/;

export function readNovaMigratorDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const raw = environment.NOVA_MIGRATOR_DATABASE_URL?.trim();
  if (!raw) throw new Error("NOVA_MIGRATOR_DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("NOVA_MIGRATOR_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname || !parsed.pathname) {
    throw new Error("NOVA_MIGRATOR_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (isRestrictedEnvironment(environment) && /replace-/i.test(raw)) {
    throw new Error("NOVA_MIGRATOR_DATABASE_URL must not use a placeholder in production/staging");
  }
  return raw;
}

export function readNovaPostgresAdminUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return readPostgresUrl(environment.NOVA_POSTGRES_ADMIN_URL, "NOVA_POSTGRES_ADMIN_URL", environment);
}

export function readNovaPostgresDatabase(environment: NodeJS.ProcessEnv = process.env): string {
  const database = environment.NOVA_POSTGRES_DB?.trim();
  if (!database || !/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error("NOVA_POSTGRES_DB must be a safe lowercase PostgreSQL database name");
  }
  return database;
}

export function readNovaMigratorPassword(environment: NodeJS.ProcessEnv = process.env): string {
  return readSafeSecret(environment, "NOVA_MIGRATOR_DATABASE_PASSWORD");
}

export function readNovaRolePasswords(environment: NodeJS.ProcessEnv = process.env): NovaRolePasswords {
  const entries = NOVA_CELL_DATABASE_ROLES.map(({ environmentVariable, role }) => {
    const value = readSafeSecret(environment, environmentVariable);
    return [role, value] as const;
  });
  if (new Set(entries.map(([, value]) => value)).size !== entries.length) {
    throw new Error("NOVA cell database passwords must be distinct");
  }
  return new Map(entries);
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
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname || !parsed.pathname) {
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
