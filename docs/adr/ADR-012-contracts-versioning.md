# ADR-012 — Versionado de contratos

## Estado

Accepted — 2026-07-15

## Contexto

APIs HTTP y eventos asíncronos son el contrato entre unidades, equipos y sistemas externos. Cambios breaking sin versionado rompen consumidores.

**Alcance actual:** schemas iniciales en `contracts/`; envelope v1 parcial. Sin consumidores productivos.

## Decisión

1. **Eventos:** directorio `contracts/events/v{n}/`; envelope común `_envelope.json`. Cambio breaking → nueva versión de carpeta (`v2`).

2. **APIs HTTP:** OpenAPI por unidad en `contracts/openapi/` (fase posterior). Versionado en path (`/v1/`) o header `Accept-Version`.

3. **Reglas de compatibilidad:**
   - **Additive changes** (campos opcionales nuevos): permitidos en misma versión minor.
   - **Breaking changes** (renombrar, eliminar, cambiar tipo): nueva versión major; periodo de dual-publish acordado.

4. **Validación CI:** `make contracts` valida schemas JSON/OpenAPI; PRs que rompan contratos requieren bump de versión y changelog.

5. Owner de contratos: `@TBD-contracts` (ver [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md)).

6. Registro de productores/consumidores: [event-registry.md](../event-registry.md).

## Consecuencias

- Disciplina de release coordinada entre productores y consumidores.
- Posible duplicación temporal de schemas durante migraciones.
- Documentación de breaking changes obligatoria en CHANGELOG.
