# Next product tickets (prioritized)

Architecture foundation is in place. Product work should land as separate PRs:

1. **contacts importer** — preview/validate/commit, E.164, dedup (pilot-core.contacts)
2. **compliance gate** — configurable policies, evidence, opt-out (pilot-core.compliance)
3. **campaigns / enrollment / attempt** — state machine scaffolding
4. **segmentation scoring** — versioned scores consuming `contact.imported`
5. **CRM funnels** — renovacion/reactivacion/nuevo/microcredito state machines
6. **orchestration + Dialer client** — real adapter behind interface (creds external)
7. **whatsapp-adapter LIWA real** — only after credential rotation + official docs
8. **documents MinIO + validation** — antivirus interface, retention
9. **handoff-liwa real** — after LIWA rotation
10. **core adapter** — after Coopfuturo core API confirmed
11. **OIDC production wiring** — issuer/audience/JWKS from IdP
12. **analytics projections** — no PII
13. **ops UI** — roles + PII masking — **scaffold en `apps/web` (mock)**; conectar API/OIDC después
14. **E2E renovación VIP-II** — synthetic contacts only

Owners: confirm via `docs/OWNERSHIP_REQUEST.md` before CODEOWNERS enforce.
