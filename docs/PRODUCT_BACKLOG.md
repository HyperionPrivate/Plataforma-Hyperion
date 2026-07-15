# Next product tickets (prioritized)

Architecture foundation is in place. Product work should land as separate PRs:

1. ~~**contacts importer**~~ — preview/validate/commit, E.164, dedup (piloto local OK)
2. ~~**compliance gate**~~ — ventana 8–20 COT, opt-out (piloto local OK)
3. ~~**campaigns / enrollment / attempt**~~ — create + orchestration + batch (piloto local OK)
4. ~~**segmentation scoring**~~ — consume contactos importados (piloto local OK)
5. ~~**CRM funnels**~~ — move columnas vía `/ops/crm/move` (piloto local OK)
6. **orchestration + Dialer client** — URL configurable; falta contrato OpenAPI dialer productivo + live smoke
7. **whatsapp-adapter LIWA real** — only after credential rotation + official docs
8. **documents MinIO + validation** — metadata/validación mock listos; antivirus + MinIO reales TBD
9. **handoff-liwa real** — after LIWA rotation (handoff local SQLite OK)
10. **core adapter** — after Coopfuturo core API confirmed (stub `/ops/core/associate/{id}`)
11. **OIDC production wiring** — issuer/audience/JWKS from IdP
12. ~~**analytics projections**~~ — overlay dashboard + reportes JSON/CSV (piloto local OK)
13. **ops UI** — roles + PII masking — UI cableada a `/ops` (inbox claim/release/messages, handoff Atender, opt-out persistente); falta OIDC/roles prod
14. **E2E renovación VIP-II** — synthetic contacts only (demo local documentada en `DEMO_PULSO_LOCAL.md`)

Loop asesor local (sin LIWA): opt-out SQLite · mensajes inbox · release claim · handoff shape + Atender · flags `voz_enabled`/`whatsapp_enabled`.

Owners: confirm via `docs/OWNERSHIP_REQUEST.md` before CODEOWNERS enforce.
