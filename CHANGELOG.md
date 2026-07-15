# Changelog

## [Unreleased] — architecture foundation

### Added

- `packages/platform-kit`: settings, correlation, auth JWT/OIDC base, DB, outbox/inbox, Redis Streams transport, health live/ready, mocks, FastAPI factory.
- Four deployable units under `apps/` with Alembic technical migrations (outbox/inbox/probe).
- Corrected event envelope (`tenant_id`, `business_idempotency_key`, `data_classification`, `schema_version`).
- Commercial event schemas + synthetic examples (handlers not implemented).
- OpenAPI stubs for Dialer, WhatsApp, LIWA, storage, core, OIDC.
- Hardened local Compose (localhost binds, Traefik dashboard off, least-privilege DB roles, non-root images).
- ADRs, C4 docs, runbooks, CI workflow, pre-commit, backup/restore scripts.
- Architecture tests: contracts, JWT, mocks, outbox idempotency.

### Security

- Documented mandatory rotation of historically exposed LIWA credential (external action).
- Fail-fast secrets policy for staging/production in platform settings.

### Notes

- Product features intentionally NOT implemented.
