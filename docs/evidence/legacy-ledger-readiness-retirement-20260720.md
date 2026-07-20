# Legacy ledger readiness API (DEBT-010)

`packages/service-runtime` still exposes `requiredLegacyMigrationNames` for transitional Audit consumers that read `platform.schema_migrations`.

Removal is gated on those consumers migrating to provider-owned ledgers. Until then the boundary finding remains sole baseline workstream.
