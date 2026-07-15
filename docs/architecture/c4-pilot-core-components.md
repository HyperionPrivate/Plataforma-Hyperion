# C4 — Nivel 3: Componentes de pilot-core

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Diagrama de componentes

```mermaid
C4Component
    title Componentes — apps/pilot-core

    Container_Boundary(pilot, "pilot-core") {
        Component(api, "HTTP API", "FastAPI routers", "Endpoints REST / health")
        Component(contacts, "contacts", "Módulo Python", "Ingesta, normalización, dedup")
        Component(campaigns, "campaigns", "Módulo Python", "Campañas, enrollments")
        Component(crm, "crm", "Módulo Python", "Funnels, tipificaciones")
        Component(compliance, "compliance", "Módulo Python", "Gate pre-contacto")
        Component(segmentation, "segmentation", "Módulo Python", "Scores versionados")
        Component(orchestration, "orchestration", "Módulo Python", "Sagas + cliente Dialer")
        Component(agent_config, "agent_config", "Módulo Python", "Versionado agentes")
        Component(analytics, "analytics", "Módulo Python", "Proyecciones sin PII")
        Component(core_adapter, "core_adapter", "Módulo Python", "Outcome financiero")
        Component(outbox, "Outbox relay", "Worker", "Publica eventos a Redis")
        ComponentDb(db, "PostgreSQL", "db_pilot_core")
    }

    System_Ext(dialer, "Dialer externo", "Voz")
    Container(wa, "whatsapp-adapter", "Canal WA")
    Container(handoff, "handoff-liwa", "Handoff")
    ContainerDb(redis, "Redis Streams", "Bus")

    Rel(api, contacts, "Invoca")
    Rel(api, campaigns, "Invoca")
    Rel(api, crm, "Invoca")
    Rel(compliance, orchestration, "Eligibility OK")
    Rel(orchestration, dialer, "HTTP", "Único caller")
    Rel(orchestration, outbox, "Escribe eventos")
    Rel(outbox, redis, "XADD")
    Rel(campaigns, db, "R/W")
    Rel(contacts, db, "R/W")
    Rel(crm, db, "R/W")
    Rel(redis, wa, "Eventos wa.*")
    Rel(redis, handoff, "lead.qualified")
```

## Módulos y responsabilidades

| Módulo | Paquete | Escritor canónico de |
|---|---|---|
| contacts | `pilot_core.modules.contacts` | Contactos, importación |
| campaigns | `pilot_core.modules.campaigns` | Campañas, enrollments |
| crm | `pilot_core.modules.crm` | Funnels, disposiciones, leads |
| compliance | `pilot_core.modules.compliance` | Decisiones de elegibilidad |
| segmentation | `pilot_core.modules.segmentation` | Scores |
| orchestration | `pilot_core.modules.orchestration` | Attempts, llamadas |
| agent_config | `pilot_core.modules.agent_config` | Versiones de agente |
| analytics | `pilot_core.modules.analytics` | Proyecciones agregadas |
| core_adapter | `pilot_core.modules.core_adapter` | Outcomes financieros |

## Reglas de frontera

- Imports directos entre módulos prohibidos (ver [module-guide.md](module-guide.md)).
- Solo `orchestration` llama al Dialer ([ADR-003](../adr/ADR-003-external-dialer.md)).
- `analytics` no recibe PII ([ADR-011](../adr/ADR-011-pii-handling.md)).

## Estado actual del código

Módulos existen como stubs con `service.py` y health check. Sin lógica comercial productiva.

## Decisiones relacionadas

- [ADR-002](../adr/ADR-002-bounded-contexts.md)
- [ADR-006](../adr/ADR-006-outbox-inbox-idempotency.md)
