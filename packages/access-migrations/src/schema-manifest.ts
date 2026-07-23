export const ACCESS_CURRENT_MIGRATION = "005-access-jwt-denylist.sql";
export const ACCESS_FRESH_BASELINE_MIGRATION = "001-access-fresh-baseline.sql";
export const ACCESS_FRESH_PROVIDER_MIGRATIONS = Object.freeze([
  ACCESS_FRESH_BASELINE_MIGRATION,
  "002-access-runtime-role-boundary.sql",
  "003-access-tenant-projection.sql",
  "004-access-tenant-lifecycle-integrity.sql",
  ACCESS_CURRENT_MIGRATION
]);
export const ACCESS_FRESH_PROVIDER_LEDGER = Object.freeze([
  Object.freeze({
    name: ACCESS_FRESH_BASELINE_MIGRATION,
    checksum: "e24c32b0055a84f319328ed524a25f6ccd348db0bbd1dbd864dbb29bd7b42328"
  }),
  Object.freeze({
    name: "002-access-runtime-role-boundary.sql",
    checksum: "3abcdfac4af18a3cbb4066741198d601a6e1b4a57c014c41dba7f5fc849ce24d"
  }),
  Object.freeze({
    name: "003-access-tenant-projection.sql",
    checksum: "5fb558a7d36899e98e532b22e0134665187f3c4db75f63a155cfe9d31821e7c8"
  }),
  Object.freeze({
    name: "004-access-tenant-lifecycle-integrity.sql",
    checksum: "c17283b147bcc57cd66e040e4b8f91e20285667f4c2dd1d23c16671b55d61a08"
  }),
  Object.freeze({
    name: ACCESS_CURRENT_MIGRATION,
    checksum: "3c88553e9d4d5a6085b8e80c5ef2a7d4391e02fac30ee1ff0c26b0f33e92c7a7"
  })
]);

/**
 * Identity and Tenant inspect only the Access-owned ledger. Keeping this in a
 * pure subpath prevents runtime images from receiving SQL or bootstrap code.
 * Both migrations and checksums are mandatory, and no mixed/extra ledger rows
 * are accepted. N-1 means the old binary remains on the legacy provider during
 * cutover; the new binary never claims the shared legacy database is ready.
 */
export const ACCESS_RUNTIME_MIGRATION_REQUIREMENT = Object.freeze({
  schema: "access_runtime",
  migrationNames: ACCESS_FRESH_PROVIDER_MIGRATIONS,
  exactMigrationLedger: ACCESS_FRESH_PROVIDER_LEDGER
});
