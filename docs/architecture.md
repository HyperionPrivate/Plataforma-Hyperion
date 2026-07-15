# Arquitectura Coopfuturo (índice)

> **Alcance actual:** fundación arquitectónica únicamente. **No hay features comerciales de producto implementadas todavía** — scaffold, contratos, mocks y health checks.

Estrategia: **modular primero, extracción por evidencia** ([ADR-001](adr/ADR-001-modular-architecture.md)).

## Unidades desplegables (4)

```text
Cliente / UI
    │
    ▼
Traefik (edge) ── OIDC/JWT (futuro)
    │
    ├── /pilot-core      → apps/pilot-core
    │         └── orchestration ──HTTP──► Dialer externo (único caller)
    ├── /whatsapp        → apps/whatsapp-adapter  (LIWA/WABA — mock)
    ├── /documents       → apps/documents         (+ MinIO/S3)
    └── /handoff         → apps/handoff-liwa

Redis Streams (bus) ← outbox/inbox por unidad
Postgres: db_pilot_core | db_whatsapp | db_documents | db_handoff
          (roles app_*; no POSTGRES_USER en apps)
```

## Documentación

### Diagramas C4 y flujos

- [Contexto](architecture/c4-context.md)
- [Contenedores](architecture/c4-containers.md)
- [Componentes pilot-core](architecture/c4-pilot-core-components.md)
- [Flujos HTTP](architecture/http-flow.md)
- [Flujos de eventos](architecture/event-flow.md)
- [Trust boundaries](architecture/trust-boundaries.md)

### Guías y catálogo

- [Data ownership](architecture/data-ownership.md)
- [Catálogo de servicios](architecture/service-catalog.md)
- [Guía de módulos](architecture/module-guide.md)
- [Guía de unidades](architecture/unit-guide.md)
- [Desarrollo local](architecture/local-dev.md)
- [Política de versionado](architecture/versioning-policy.md)

### ADRs

- [Índice ADR](adr/README.md) (001–015)

### Runbooks

- [Arranque](runbooks/startup.md)
- [Migraciones](runbooks/migrations.md)
- [Eventos fallidos](runbooks/failed-events.md)
- [Rotación de secretos](runbooks/secret-rotation.md)
- [Backup / restore](runbooks/backup-restore.md)

## Documentos relacionados (legacy / complemento)

- [Matriz ownership (histórica)](data-ownership-matrix.md)
- [Registro eventos](event-registry.md)
- [Anti-patrones](anti-patterns.md)
- [Bloqueos externos](EXTERNAL_BLOCKERS.md)
- [Ownership personas TBD](OWNERSHIP_REQUEST.md)
- [SECURITY](../SECURITY.md)

## Stubs legacy

`services/*` se mantienen hasta reemplazo verificado en `apps/*`. No usar para features nuevas.
