export const ACCESS_CURRENT_MIGRATION = "006-access-runtime-readiness-ledger.sql";

/**
 * Pure runtime boundary exported independently from the migrator entrypoint.
 * Consumers receive only the provider-owned ledger identity and terminal name;
 * importing this subpath cannot execute migrations or load database credentials.
 */
export const ACCESS_RUNTIME_MIGRATION_REQUIREMENT = Object.freeze({
  schema: "access_runtime",
  migrationNames: Object.freeze([ACCESS_CURRENT_MIGRATION])
});
