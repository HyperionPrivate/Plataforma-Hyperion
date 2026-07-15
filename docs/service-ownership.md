# Service ownership

Asigna un dueño real por servicio. Mientras tanto queda `TBD`.

| Servicio | Carpeta | Puerto | Database | Ruta Traefik | Prioridad | Owner |
|---|---|---|---|---|---|---|
| orchestrator | `services/orchestrator` | 8101 | `db_orchestrator` | `/orchestrator` | core | TBD |
| crm | `services/crm` | 8102 | `db_crm` | `/crm` | core | TBD |
| compliance | `services/compliance` | 8103 | `db_compliance` | `/compliance` | core | TBD |
| whatsapp | `services/whatsapp` | 8104 | `db_whatsapp` | `/whatsapp` | core | TBD |
| identity | `services/identity` | 8105 | `db_identity` | `/identity` | core | TBD |
| documents | `services/documents` | 8106 | `db_documents` | `/documents` | satélite | TBD |
| handoff | `services/handoff` | 8107 | `db_handoff` | `/handoff` | satélite | TBD |
| segmentation | `services/segmentation` | 8108 | `db_segmentation` | `/segmentation` | satélite | TBD |
| agent-config | `services/agent-config` | 8109 | `db_agent_config` | `/agent-config` | satélite | TBD |
| analytics | `services/analytics` | 8110 | `db_analytics` | `/analytics` | satélite | TBD |

## Infra compartida (no dominio)

| Componente | Owner |
|---|---|
| Traefik / Compose / Postgres init | Platform / TBD |
| `contracts/` | Acuerdo de equipo; PRs con revisión cruzada |

## Dialer externo

Repo aparte. No tiene fila aquí. Cliente permitido: solo `orchestrator`.
