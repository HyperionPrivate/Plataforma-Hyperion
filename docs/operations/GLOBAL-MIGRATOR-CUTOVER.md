---
documentType: runbook
status: draft
owner: platform-data
issue: HYP-DEBT-022
reviewDue: 2027-03-31
---

# Global migrator cutover (DEBT-022)

## Status

`retiring` — **code freeze completo** (2026-07-20). Historical chain `001`–`046` remains sealed for
compatibility bytes. Append-only contract migrations `047`–`052` cleared Access FK and N-1 adapter debt.
Provider-owned PULSO tip (`16/016-attest-access-fk-contract.sql`) is the autonomous cell source of truth.

## Code-side cutover (done)

1. Provider-owned PULSO / Access / Audit / LUMEN / NOVA migrators own live schema authority.
2. Global allow-list (`scripts/architecture/legacy-global-migrations.json`) only grows with append-only contracts.
3. CEDCO slug seed in `004-cedco-catalog.sql` stays sealed with acceptedFindings bound to DEBT-022.
4. Do not delete `001`–`046`; retirement is allow-list freeze + consumer migration to provider packages.

## Code-side consumer drain (done 2026-07-20)

- `packages/service-runtime` consumer-readiness gate asserts zero `requiredLegacyMigrationNames` runtime consumers.
- Provider-owned migrators own live schema authority; global chain is compatibility bytes only.

## Ops residual (blocks catalog retirement)

1. Confirm no production workload still boots via the global migrator Compose one-shot / image.
2. Observe deploy inventories for zero global-migrator consumers in the objective environment.
3. Schedule a dedicated tenant-bootstrap cut to replace CEDCO slug seed with provider-owned bootstrap.
4. Only then remove DEBT-022 acceptedFindings and archive the global chain `001`–`046`.

## Evidence

- `scripts/architecture/legacy-global-migrations.json`
- `packages/migrations/sql/047-contract-channel-access-tenant-fks.sql` … `052-drop-n-minus-one-legacy-adapters.sql`
- `packages/pulso-migrations` tip 015
- `packages/service-runtime/src/consumer-readiness.test.ts`
