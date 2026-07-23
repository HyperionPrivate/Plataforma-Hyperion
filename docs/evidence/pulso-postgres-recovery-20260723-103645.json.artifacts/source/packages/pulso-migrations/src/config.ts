export const PULSO_MIGRATOR_ROLE = "hyperion_pulso_migrator" as const;

export const PULSO_RUNTIME_ROLE_DEFINITIONS = [
  { environmentVariable: "PULSO_DATABASE_PASSWORD", role: "hyperion_pulso" },
  { environmentVariable: "SOFIA_DATABASE_PASSWORD", role: "hyperion_sofia" },
  { environmentVariable: "KNOWLEDGE_DATABASE_PASSWORD", role: "hyperion_knowledge" },
  { environmentVariable: "INTEGRATION_DATABASE_PASSWORD", role: "hyperion_integration" },
  { environmentVariable: "CHANNEL_DATABASE_PASSWORD", role: "hyperion_channel" }
] as const;

export type PulsoRuntimeRole = (typeof PULSO_RUNTIME_ROLE_DEFINITIONS)[number]["role"];
export type PulsoRuntimePasswords = ReadonlyMap<PulsoRuntimeRole, string>;

const SAFE_SECRET_PATTERN = /^[A-Za-z0-9._~-]{24,}$/;

export function readPulsoMigratorDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return readPostgresUrl(environment.PULSO_MIGRATOR_DATABASE_URL, "PULSO_MIGRATOR_DATABASE_URL", environment);
}

export function readPulsoPostgresAdminUrl(environment: NodeJS.ProcessEnv = process.env): string {
  return readPostgresUrl(environment.PULSO_POSTGRES_ADMIN_URL, "PULSO_POSTGRES_ADMIN_URL", environment);
}

export function readPulsoPostgresDatabase(environment: NodeJS.ProcessEnv = process.env): string {
  const database = environment.PULSO_POSTGRES_DB?.trim();
  if (!database || !/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error("PULSO_POSTGRES_DB must be a safe lowercase PostgreSQL database name");
  }
  return database;
}

export function readPulsoMigratorPassword(environment: NodeJS.ProcessEnv = process.env): string {
  return readSafeSecret(environment, "PULSO_MIGRATOR_DATABASE_PASSWORD");
}

export function readPulsoRuntimePasswords(environment: NodeJS.ProcessEnv = process.env): PulsoRuntimePasswords {
  const passwords = new Map<PulsoRuntimeRole, string>();
  const seen = new Set<string>();
  for (const definition of PULSO_RUNTIME_ROLE_DEFINITIONS) {
    const password = readSafeSecret(environment, definition.environmentVariable);
    if (seen.has(password)) throw new Error("PULSO runtime database passwords must be distinct");
    seen.add(password);
    passwords.set(definition.role, password);
  }
  return passwords;
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
