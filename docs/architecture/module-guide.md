# Guía de módulos (pilot-core)

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Estructura

```text
apps/pilot-core/src/pilot_core/
├── main.py
├── settings.py
└── modules/
    ├── contacts/
    ├── campaigns/
    ├── crm/
    ├── compliance/
    ├── segmentation/
    ├── orchestration/
    ├── agent_config/
    ├── analytics/
    └── core_adapter/
```

Cada módulo expone al menos `service.py` con lógica de dominio stub.

## Reglas de frontera

### Permitido

- Importar desde `pilot_core.settings`, utilidades compartidas de `pilot_core` (sin lógica de dominio).
- Publicar eventos vía outbox (misma unidad).
- Invocar interfaces públicas documentadas de otro módulo (facade/application service).

### Prohibido

- Importar `*.repository`, modelos ORM o queries SQL de otro módulo.
- Acceder a tablas de otro bounded context directamente.
- Llamar al Dialer desde cualquier módulo que no sea `orchestration`.
- Pasar PII a `analytics`.

## Comunicación entre módulos

| Mecanismo | Cuándo usar |
|---|---|
| Evento de dominio (outbox) | Efectos asíncronos, desacoplamiento temporal |
| Application service / facade | Orquestación síncrona intra-unidad |
| Shared kernel | **Evitar** — solo tipos/value objects truly shared |

## Añadir un módulo nuevo

1. Crear paquete bajo `pilot_core.modules.<nombre>/`.
2. Documentar en [c4-pilot-core-components.md](c4-pilot-core-components.md).
3. Actualizar [data-ownership.md](data-ownership.md) y [event-registry.md](../event-registry.md).
4. Si el módulo justifica extracción, evaluar [ADR-013](../adr/ADR-013-extraction-criteria.md).

## Tests de frontera (fase posterior)

- Archunit-style import linter: `orchestration` es único importador de cliente Dialer.
- Ningún módulo excepto `analytics` importa proyecciones sin PII filter.

## Ownership

Owner transversal: `@TBD-pilot-core`. Desglose por módulo TBD en [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

## Referencias

- [ADR-002](../adr/ADR-002-bounded-contexts.md)
- [anti-patterns.md](../anti-patterns.md)
