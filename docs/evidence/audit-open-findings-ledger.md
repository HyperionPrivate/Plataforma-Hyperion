# Ledger — hallazgos abiertos de auditoría (remediación)

Regla: `fixed-verified` solo con Gate command exit code `0`.  
Estados: `open` | `fixed-verified` | `blocked-external`.

| AUD-ID | Status | Gate command | Exit code | Evidence | Notes |
|--------|--------|--------------|-----------|----------|-------|
| AUD-005 | fixed-verified | `pnpm --filter @hyperion/durable-events test` | 0 | delivered_unacked + outbox fail terminal | 2026-07-23T16:00Z |
| AUD-013 | fixed-verified | `pnpm --filter @hyperion/identity-service test` + `pnpm --filter @hyperion/access-migrations test` | 0 | 005-access-jwt-denylist.sql; denylist on logout/me | 2026-07-23T16:00Z |
| AUD-014 | fixed-verified | `pnpm --filter @hyperion/lumen-service exec vitest run src/clinical-write-authorization.test.ts` | 0 | requireClinicalReadGrant on GET PHI | 2026-07-23T16:02Z |
| AUD-017 | fixed-verified | `pnpm --filter @hyperion/voice-channel-service exec vitest run src/app.test.ts` | 0 | unsigned webhooks only when deployment=local | 2026-07-23T16:02Z |
| AUD-015 | fixed-verified | `pnpm --filter @hyperion/pulso-iris-service exec vitest run src/analytics-routes.test.ts` | 0 | agenda_settings.timezone parametrized | 2026-07-23T16:02Z |
| AUD-011 | fixed-verified | `pnpm --filter @hyperion/pulso-iris-service exec vitest run src/appointment-routes.test.ts` | 0 | reserve+verify single TX without holdId | 2026-07-23T16:02Z |
| AUD-006 | fixed-verified | `pnpm --filter @hyperion/lumen-console test` + `pnpm docs:check` | 0 | hide demo nav in staging/prod; badges | 2026-07-23T16:03Z |
| AUD-007 | blocked-external | `node scripts/releases/verify-registry-publish-path.mjs --verify-github-access` | 0 (ownership) | ownership verified; NPM_TOKEN / RELEASE_GOVERNANCE_TOKEN env secrets absent; no publish dispatch | Checklist humano: configurar secretos environment + workflow_dispatch + releases/published/ |

## Verification log

- 2026-07-23T16:00Z AUD-005 durable-events 126 pass / 18 skip
- 2026-07-23T16:00Z AUD-013 access-migrations 63 pass; identity-service 82 pass
- 2026-07-23T16:02Z AUD-014 clinical-write-authorization 14 pass
- 2026-07-23T16:02Z AUD-017 voice app.test 12 pass
- 2026-07-23T16:02Z AUD-015 analytics-routes 3 pass; AUD-011 appointment-routes 1 pass
- 2026-07-23T16:03Z AUD-006 lumen-console 62 pass; docs:check OK
- 2026-07-23T16:03Z AUD-007 ownership live verified; publication blocked on missing env secrets (NPM_TOKEN unset)

## AUD-007 human checklist (remaining)

1. Create PAT with org team visibility → environment secret `RELEASE_GOVERNANCE_TOKEN`.
2. Set environment secret `NPM_TOKEN` on `release-publication`.
3. `workflow_dispatch` publish workflows; archive readback under `releases/published/`.
4. Flip this row to `fixed-verified` only after readback evidence exists.
