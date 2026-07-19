import { ACCESS_MIGRATOR_ROLE, ACCESS_RUNTIME_DATABASE_ROLES, type AccessRolePasswords } from "./role-manifest.js";

export {
  ACCESS_MIGRATOR_ROLE,
  ACCESS_RUNTIME_DATABASE_ROLES,
  type AccessRolePasswords,
  type AccessRuntimeDatabaseRole
} from "./role-manifest.js";

const SAFE_SECRET_PATTERN = /^[A-Za-z0-9._~-]{24,}$/;
const CONNECTION_OVERRIDE_PARAMETERS = new Set([
  "database",
  "dbname",
  "host",
  "options",
  "password",
  "port",
  "service",
  "user"
]);

export function readAccessMigratorDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const raw = readPostgresUrl(environment.ACCESS_MIGRATOR_DATABASE_URL, "ACCESS_MIGRATOR_DATABASE_URL", environment);
  const parsed = new URL(raw);
  if (decodeURIComponent(parsed.username) !== ACCESS_MIGRATOR_ROLE) {
    throw new Error(`ACCESS_MIGRATOR_DATABASE_URL must authenticate as ${ACCESS_MIGRATOR_ROLE}`);
  }
  if (decodeURIComponent(parsed.pathname.slice(1)) !== readAccessPostgresDatabase(environment)) {
    throw new Error("ACCESS_MIGRATOR_DATABASE_URL must target ACCESS_POSTGRES_DB");
  }
  return raw;
}

export function readAccessPostgresAdminUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const raw = readPostgresUrl(environment.ACCESS_POSTGRES_ADMIN_URL, "ACCESS_POSTGRES_ADMIN_URL", environment);
  const username = decodeURIComponent(new URL(raw).username);
  const providerRoles = new Set<string>([
    ACCESS_MIGRATOR_ROLE,
    ...ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role)
  ]);
  if (!username || providerRoles.has(username)) {
    throw new Error("ACCESS_POSTGRES_ADMIN_URL must use a separate PostgreSQL administrator identity");
  }
  return raw;
}

export function readAccessPostgresDatabase(environment: NodeJS.ProcessEnv = process.env): string {
  const database = environment.ACCESS_POSTGRES_DB?.trim();
  if (!database || !/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error("ACCESS_POSTGRES_DB must be a safe lowercase PostgreSQL database name");
  }
  return database;
}

export function readAccessMigratorPassword(environment: NodeJS.ProcessEnv = process.env): string {
  return readSafeSecret(environment, "ACCESS_MIGRATOR_DATABASE_PASSWORD");
}

export function readAccessRolePasswords(environment: NodeJS.ProcessEnv = process.env): AccessRolePasswords {
  const entries = ACCESS_RUNTIME_DATABASE_ROLES.map(({ environmentVariable, role }) => {
    return [role, readSafeSecret(environment, environmentVariable)] as const;
  });
  const migratorPassword = readSafeSecret(environment, "ACCESS_MIGRATOR_DATABASE_PASSWORD");
  const allPasswords = [migratorPassword, ...entries.map(([, password]) => password)];
  if (new Set(allPasswords).size !== allPasswords.length) {
    throw new Error("Access migrator and runtime database passwords must all be distinct");
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
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    parsed.pathname === "/"
  ) {
    throw new Error(`${variableName} must be a valid PostgreSQL URL`);
  }
  const overrides = [...parsed.searchParams.keys()]
    .map((name) => name.toLowerCase())
    .filter((name) => CONNECTION_OVERRIDE_PARAMETERS.has(name));
  if (overrides.length > 0) {
    throw new Error(`${variableName} must not override connection identity or target parameters`);
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
