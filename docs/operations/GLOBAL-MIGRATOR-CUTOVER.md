---
documentType: runbook
status: draft
owner: platform-data
issue: HYP-DEBT-022
reviewDue: 2027-03-31
---

# Global migrator cutover (DEBT-022)

## Status

`retiring` — historical chain `001`–`046` remains frozen for N-1 / allow-list compatibility.
Append-only contract migrations `047`–`052` clear Access FK and N-1 adapter debt without deleting history.

## Cutover path

1. Provider-owned PULSO tip (`packages/pulso-migrations`) is the source of truth for autonomous cells.
2. Global allow-list (`scripts/architecture/legacy-global-migrations.json`) may only grow with append-only contracts.
3. CEDCO slug seed in `004-cedco-catalog.sql` stays sealed until a dedicated tenant-bootstrap cut.
4. Do not delete `001`–`046`; retirement is allow-list freeze + consumer migration to provider packages.

## Evidence

- `scripts/architecture/legacy-global-migrations.json`
- `packages/migrations/sql/047-contract-channel-access-tenant-fks.sql` … `052-drop-n-minus-one-legacy-adapters.sql`
