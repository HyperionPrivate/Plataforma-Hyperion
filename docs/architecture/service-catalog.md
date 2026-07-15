# Catálogo de servicios

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Unidades desplegables (`apps/`)

| Servicio | Carpeta | Puerto | Health | Database | Owner GitHub |
|---|---|---|---|---|---|
| pilot-core | `apps/pilot-core` | 8201 | `/health` | `db_pilot_core` | `@TBD-pilot-core` |
| whatsapp-adapter | `apps/whatsapp-adapter` | 8202 | `/health` | `db_whatsapp` | `@TBD-whatsapp` |
| documents | `apps/documents` | 8203 | `/health` | `db_documents` | `@TBD-documents` |
| handoff-liwa | `apps/handoff-liwa` | 8204 | `/health` | `db_handoff` | `@TBD-handoff` |

Confirmar owners reales: [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

## Infraestructura compartida

| Componente | Rol | Owner |
|---|---|---|
| Traefik | API gateway | `@TBD-platform` |
| PostgreSQL | Persistencia | `@TBD-platform` |
| Redis | Bus + cache | `@TBD-platform` |
| MinIO/S3 | Object storage | `@TBD-platform` |

## Sistemas externos

| Sistema | Tipo | Cliente autorizado | Estado |
|---|---|---|---|
| Dialer | Voz / ASR / AMD | `pilot-core.orchestration` | Contrato TBD |
| LIWA / WABA | WhatsApp | `whatsapp-adapter`, `handoff-liwa` | Mock |
| Core financiero Coopfuturo | Outcomes | `pilot-core.core_adapter` | Mock |
| IdP OIDC | Identidad | Edge + apps | Pendiente |
| ElevenLabs | TTS | Via Dialer (externo) | N/A en monorepo |

## Stubs legacy (`services/`) — deprecación planificada

| Stub | Puerto | Reemplazo target |
|---|---|---|
| orchestrator | 8101 | `pilot-core.orchestration` |
| crm | 8102 | `pilot-core.crm` |
| whatsapp | 8103 | `whatsapp-adapter` |
| documents | 8104 | `documents` |
| handoff | 8105 | `handoff-liwa` |
| compliance | 8106 | `pilot-core.compliance` |
| segmentation | 8107 | `pilot-core.segmentation` |
| agent-config | 8108 | `pilot-core.agent_config` |
| analytics | 8109 | `pilot-core.analytics` |
| identity | 8110 | Edge OIDC (futuro) |

**No usar stubs para features nuevas.**

## Contratos

| Tipo | Ubicación | Owner |
|---|---|---|
| Eventos v1 | `contracts/events/v1/` | `@TBD-contracts` |
| OpenAPI (futuro) | `contracts/openapi/` | `@TBD-contracts` |

## Enlaces

- [C4 contenedores](c4-containers.md)
- [Data ownership](data-ownership.md)
- [service-ownership.md](../service-ownership.md)
