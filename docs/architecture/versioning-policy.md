# Política de versionado

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Ámbitos versionados

| Artefacto | Esquema | Ubicación |
|---|---|---|
| Paquetes Python (`apps/*`) | SemVer en `pyproject.toml` | `apps/<unit>/pyproject.toml` |
| Eventos | Major folder `v{n}` | `contracts/events/v1/` |
| APIs HTTP | Path `/v{n}/` o header | `contracts/openapi/` (futuro) |
| Imágenes Docker | Git SHA + tag SemVer release | Registry TBD |
| ADRs | Secuencial ADR-NNN | `docs/adr/` |

## Eventos — reglas

Detalle completo: [ADR-012](../adr/ADR-012-contracts-versioning.md).

### Cambios compatibles (misma versión minor)

- Añadir campo **opcional** en payload
- Añadir nuevo `event_type`
- Ampliar enum con valor nuevo (consumidores tolerantes)

### Cambios breaking (nueva versión major)

- Renombrar o eliminar campo
- Cambiar tipo de campo
- Cambiar semántica de `event_type` existente

### Proceso de migración de eventos

1. Publicar schema `v2` en paralelo con `v1`
2. Productores dual-publish durante ventana acordada
3. Consumidores migran a `v2`
4. Deprecar `v1` con fecha en CHANGELOG

## APIs HTTP — reglas (futuro)

- Breaking → `/v2/` prefix
- Sunset header en respuestas de versión deprecada
- OpenAPI diff en CI

## Aplicaciones

- `0.x.y` mientras no haya features comerciales productivas
- Bump minor: contratos additive, nuevos endpoints
- Bump major: extracción de unidad o breaking API

## Compatibilidad de deploy

Orden expand/contract: ver [ADR-015](../adr/ADR-015-deploy-rollback.md) y [ADR-014](../adr/ADR-014-migrations-strategy.md).

## Ownership contratos

`@TBD-contracts` — [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

## Validación CI

```powershell
make contracts
```

Falla si schemas JSON inválidos o breaking change sin bump de versión (fase posterior).
