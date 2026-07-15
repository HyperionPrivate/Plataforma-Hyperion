# Next product tickets (prioritized)

Architecture foundation is in place. Product work should land as separate PRs:

1. ~~**contacts importer**~~ — preview/validate/commit, E.164, dedup (piloto local OK)
2. ~~**compliance gate**~~ — ventana 8–20 COT, opt-out (piloto local OK)
3. ~~**campaigns / enrollment / attempt**~~ — create + orchestration + batch (piloto local OK)
4. ~~**segmentation scoring**~~ — consume contactos importados (piloto local OK)
5. ~~**CRM funnels**~~ — move columnas vía `/ops/crm/move` (piloto local OK)
6. **orchestration + Dialer client** — URL configurable; falta contrato OpenAPI dialer productivo + live smoke
7. ~~**WhatsApp LIWA vía Ops**~~ — `kind=flow|text`, flujos LIWA, Laboratorio (fase 2 eventos/webhooks adapter TBD)
8. ~~**documents filesystem/MinIO**~~ — `POST /ops/documents/upload` + backend filesystem|minio (antivirus real TBD)
9. ~~**handoff LIWA tag**~~ — `handoff_to_agency` + tag `LIWA_HANDOFF_TAG` / `agency_tag` (grupo Agencias UI LIWA = ops)
10. ~~**core adapter HTTP**~~ — stub si `CORE_BASE_URL` vacío; live GET si configurado
11. **OIDC production wiring** — scaffolding + `GET /ops/auth/status`; falta IdP prod + `AUTH_DISABLED=false`
12. ~~**analytics projections**~~ — overlay dashboard + reportes JSON/CSV (piloto local OK)
13. **ops UI** — PII masking en GET `/ops` + toggle Configuración → Privacidad; falta OIDC/roles prod
14. ~~**E2E renovación**~~ — `POST /ops/e2e/renovacion` + botón Laboratorio (voz opcional → WA flow → doc → handoff → CRM)
15. ~~**post-call → WhatsApp**~~ — `POST /ops/calls/complete` + webhook ElevenLabs `/ops/webhooks/elevenlabs/post-call` (intención continuar → flujo LIWA)
16. ~~**Flujo B Reactivación**~~ — mismo puente A/B (`product_flow`), E2E `/ops/e2e/reactivacion`, tag `REACTIVACION_VIP` (plantilla LIWA B opcional vía `LIWA_FLOW_ID_B`)

Loop asesor: opt-out SQLite · mensajes inbox · release claim · handoff shape + Atender · flags `voz_enabled`/`whatsapp_enabled` · WhatsApp LIWA live opcional.

CRM: transiciones estrictas + tipificación requerida en `no_interes`/`renovado`.

Owners: confirm via `docs/OWNERSHIP_REQUEST.md` before CODEOWNERS enforce.
