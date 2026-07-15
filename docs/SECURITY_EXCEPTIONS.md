# Security exceptions — image / dependency scanning

Last reviewed: 2026-07-15

## Policy

- CI Trivy scans all four app images with `--severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed`.
- Unfixed upstream CVEs in the Debian/Python base image are **not** merge blockers while tracked here.
- Fixable HIGH/CRITICAL findings **must** be remediated (base bump, package pin, or rebuild) before merge.
- Accepted exceptions require owner, expiry, and rationale.

## Current accepted exceptions

| ID / CVE | Image / package | Severity | Rationale | Owner | Expiry |
|---|---|---|---|---|---|
| _(none)_ | — | — | Pipeline uses `--ignore-unfixed`; no manual accepts yet | `@TBD-security` | — |

## Notes

- SBOMs are published as CycloneDX artifacts from the `image-build` job (`sbom/*.cdx.json`).
- Shared-secret service auth was removed; service calls require JWT with `tenant_id` claim.
- LIWA production credentials remain blocked until rotation (see `EXTERNAL_BLOCKERS.md`).
