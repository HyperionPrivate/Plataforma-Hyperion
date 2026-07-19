export function readPlatformMigratorDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.PLATFORM_MIGRATOR_DATABASE_URL?.trim();
  if (!value) throw new Error("PLATFORM_MIGRATOR_DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PLATFORM_MIGRATOR_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname || !parsed.pathname) {
    throw new Error("PLATFORM_MIGRATOR_DATABASE_URL must be a valid PostgreSQL URL");
  }
  return value;
}
