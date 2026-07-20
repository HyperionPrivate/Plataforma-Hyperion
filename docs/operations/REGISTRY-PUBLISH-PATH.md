---
documentType: runbook
status: draft
owner: platform-release
issue: HYP-DEBT-024
reviewDue: 2027-01-31
---

# Registry publish path (DEBT-024)

## Intent

Move workspace `workspace:*` packages to versioned registry publishes without inventing credentials in-repo.

## Path

1. Use existing workflow `publish-shared-libraries.yml` (`workflow_dispatch` only).
2. Org / environment secrets for GHCR or npm remain outside the repository.
3. Until credentials exist in the target org, local `pnpm` workspace resolution remains the source of truth.
4. DEBT-021 closed: `apps/api-gateway` no longer depends on `@hyperion/contracts` (local compatibility catalog).
5. Dry-run gate: `pnpm release:verify-registry-path` (also part of `pnpm release:check`).

## Evidence

- `.github/workflows/publish-shared-libraries.yml` (inline publish job; no separate `.mjs` publisher)
- `scripts/releases/shared-library-publication.test.mjs`
- `scripts/releases/verify-registry-publish-path.mjs`
- Release catalogs under `releases/`
