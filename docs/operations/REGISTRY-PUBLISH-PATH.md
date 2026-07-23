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

1. Use only the four `workflow_dispatch` publication workflows bound to environment `release-publication`.
2. Run `pnpm release:verify-registry-path` for an offline consistency check. The current normative scope is Platform
   catalog `2.4.0`; other cells fail closed until their next catalogs migrate repository and registry identity.
3. Every mutation workflow repeats the gate with `--verify-github-access` and the environment secret
   `RELEASE_GOVERNANCE_TOKEN`. Repository ownership is `verified-repository-access`: canonical teams have
   explicit `push` and CODEOWNERS rules are active. Publication still requires live environment secrets and
   registry readback.
4. Organization/environment credentials for GitHub, GHCR or npm remain outside the repository.
5. Until credentials and registry readback exist in the target organization, local `pnpm` workspace resolution remains
   the source of truth; an offline green check is not publication evidence.
6. DEBT-021 closed: `apps/api-gateway` no longer depends on `@hyperion/contracts` (local compatibility catalog).

## Evidence

- `.github/workflows/publish-shared-libraries.yml` (inline publish job; no separate `.mjs` publisher)
- `scripts/releases/shared-library-publication.test.mjs`
- `scripts/releases/verify-registry-publish-path.mjs`
- Release catalogs under `releases/`

## Remaining remote blockers (2026-07-23)

Ownership accreditation is complete for the Platform slice:

1. Teams `platform`, `architecture-reviewers` and `release-security` have explicit `push` on
   `HyperionPrivate/Plataforma-Hyperion`.
2. Environment `release-publication` exists.
3. `ownershipState` is `verified-repository-access` and CODEOWNERS Platform rules are active.

Publication remains blocked until:

1. Environment secrets `RELEASE_GOVERNANCE_TOKEN` and `NPM_TOKEN` are configured on protected `main`.
2. Publish workflows run and readback is archived under `releases/published/`.

No digest bundle is production-authoritative until those steps complete. Status is tracked in
[`docs/evidence/audit-open-findings-ledger.md`](../evidence/audit-open-findings-ledger.md) (AUD-007 =
`blocked-external` until secrets + readback exist).
