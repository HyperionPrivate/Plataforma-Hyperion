# Service ownership (unidades desplegables + stubs legacy)

Asigna owners reales vía [OWNERSHIP_REQUEST.md](OWNERSHIP_REQUEST.md).

## Unidades (`apps/`)

| Unidad | Carpeta | Puerto | Database | Owner |
|---|---|---|---|---|
| pilot-core | `apps/pilot-core` | 8201 | `db_pilot_core` | TBD → `@TBD-pilot-core` |
| whatsapp-adapter | `apps/whatsapp-adapter` | 8202 | `db_whatsapp` | TBD → `@TBD-whatsapp` |
| documents | `apps/documents` | 8203 | `db_documents` | TBD → `@TBD-documents` |
| handoff-liwa | `apps/handoff-liwa` | 8204 | `db_handoff` | TBD → `@TBD-handoff` |

## Stubs legacy (`services/`) — no features nuevas

| Stub | Puerto | Estado |
|---|---|---|
| orchestrator … analytics | 8101–8110 | Conservados hasta reemplazo verificado |

## Externos

| Sistema | Cliente permitido |
|---|---|
| Dialer / ElevenLabs | solo `pilot-core.orchestration` |
| LIWA | `whatsapp-adapter`, `handoff-liwa` (mock hasta rotación) |
| Core Coopfuturo | `pilot-core.core_adapter` |
