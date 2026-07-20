# Legacy ledger readiness API (DEBT-010) — closed

`requiredLegacyMigrationNames` and all `platform.schema_migrations` readiness queries were removed from
`packages/service-runtime/src/index.ts` on 2026-07-20.

Audit already pins `requiredMigrationLedger: AUDIT_RUNTIME_MIGRATION_REQUIREMENT`. Boundary baseline is empty
for this finding; DEBT-010 was removed from `docs/catalogs/debt.v1.json`.
