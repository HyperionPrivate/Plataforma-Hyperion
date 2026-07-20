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
Provider-owned PULSO tip (`15/015-…`) is the autonomous cell source of truth.

## Code-side cutover (done)

1. Provider-owned PULSO / Access / Audit / LUMEN / NOVA migrators own live schema authority.
2. Global allow-list (`scripts/architecture/legacy-global-migrations.json`) only grows with append-only contracts.
3. CEDCO slug seed in `004-cedco-catalog.sql` stays sealed with acceptedFindings bound to DEBT-022.
4. Do not delete `001`–`046`; retirement is allow-list freeze + consumer migration to provider packages.

## Ops residual (blocks catalog retirement)

1. Confirm no production workload still boots via the global migrator path.
2. Observe telemetría / deploy inventories for zero global-migrator consumers.
3. Schedule a dedicated tenant-bootstrap cut to replace CEDCO slug seed with provider-owned bootstrap.
4. Only then remove DEBT-022 acceptedFindings and archive the global chain.

## Evidence

- `scripts/architecture/legacy-global-migrations.json`
- `packages/migrations/sql/047-contract-channel-access-tenant-fks.sql` … `052-drop-n-minus-one-legacy-adapters.sql`
- `packages/pulso-migrations` tip 015
