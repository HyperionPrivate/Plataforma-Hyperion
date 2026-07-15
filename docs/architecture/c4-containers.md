# C4 — Nivel 2: Contenedores

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Diagrama de contenedores

```mermaid
C4Container
    title Contenedores — Coopfuturo PULSO

    Person(operador, "Operador", "Administra campañas")

    System_Boundary(coop, "Coopfuturo monorepo") {
        Container(gateway, "Traefik", "Reverse proxy", "Termina TLS, enruta, JWT (futuro)")
        Container(pilot, "pilot-core", "FastAPI / Python", "Dominio central: contactos, CRM, compliance, orchestration")
        Container(wa, "whatsapp-adapter", "FastAPI / Python", "Canal WhatsApp / LIWA (mock)")
        Container(docs, "documents", "FastAPI / Python", "Metadatos + object storage")
        Container(handoff, "handoff-liwa", "FastAPI / Python", "Expedientes handoff (mock)")
        ContainerDb(pg, "PostgreSQL", "Persistencia", "4 DBs aisladas")
        ContainerDb(redis, "Redis", "Cache + Streams", "Bus de eventos (Fase 4)")
        ContainerDb(s3, "MinIO / S3", "Object storage", "Binarios de documentos")
    }

    System_Ext(dialer, "Dialer externo", "Voz")
    System_Ext(liwa, "LIWA", "WhatsApp API")
    System_Ext(idp, "IdP OIDC", "Identidad")

    Rel(operador, gateway, "HTTPS")
    Rel(gateway, pilot, "/pilot-core")
    Rel(gateway, wa, "/whatsapp")
    Rel(gateway, docs, "/documents")
    Rel(gateway, handoff, "/handoff")
    Rel(pilot, pg, "db_pilot_core")
    Rel(wa, pg, "db_whatsapp")
    Rel(docs, pg, "db_documents")
    Rel(docs, s3, "Binarios")
    Rel(handoff, pg, "db_handoff")
    Rel(pilot, redis, "Pub/sub eventos")
    Rel(wa, redis, "Consume/publica")
    Rel(docs, redis, "Consume/publica")
    Rel(handoff, redis, "Consume/publica")
    Rel(pilot, dialer, "HTTP", "Solo orchestration")
    Rel(wa, liwa, "HTTP", "Mock")
    Rel(gateway, idp, "JWKS")
```

## Unidades desplegables

| Contenedor | Ruta | Puerto | Database |
|---|---|---|---|
| pilot-core | `/pilot-core` | 8201 | `db_pilot_core` |
| whatsapp-adapter | `/whatsapp` | 8202 | `db_whatsapp` |
| documents | `/documents` | 8203 | `db_documents` |
| handoff-liwa | `/handoff` | 8204 | `db_handoff` |

## Infraestructura compartida

| Componente | Rol |
|---|---|
| Traefik | Edge gateway; dashboard off por defecto |
| PostgreSQL | Una DB por unidad; roles `app_*` |
| Redis | Streams (bus) + cache |
| MinIO/S3 | Almacenamiento de documentos |

## Stubs legacy

`services/*` (puertos 8101–8110) — perfil `legacy-stubs` en Compose. No usar para desarrollo de dominio nuevo.

## Decisiones relacionadas

- [ADR-001](../adr/ADR-001-modular-architecture.md)
- [ADR-004](../adr/ADR-004-database-ownership.md)
- [ADR-005](../adr/ADR-005-redis-streams-transport.md)

## Ownership

Ver [service-catalog.md](service-catalog.md) y [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).
