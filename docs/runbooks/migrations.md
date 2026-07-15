# Runbook — Migraciones de base de datos

> **Alcance:** fundación arquitectónica. Alembic pendiente de implementación por unidad.

## Principios

- Una cadena Alembic **por unidad** en `apps/<unit>/migrations/`
- Forward-only en producción ([ADR-014](../adr/ADR-014-migrations-strategy.md))
- Migraciones antes del deploy de código dependiente

## Desarrollo local

```powershell
# Ejemplo futuro — pilot-core
cd apps/pilot-core
uv run alembic upgrade head
```

## Crear migración

```powershell
uv run alembic revision -m "descripcion_cambio"
# Editar script generado
uv run alembic upgrade head
```

## CI

Pipeline ejecutará `alembic upgrade head` contra Postgres efímero antes de merge.

## Expand / Contract (cambios breaking)

### Fase 1 — Expand

- Añadir columna nullable o con default
- Deploy código que escribe en columna nueva y lee ambas

### Fase 2 — Migrate

- Backfill datos en job controlado

### Fase 3 — Contract

- Deploy código que solo usa columna nueva
- Migración que elimina columna antigua

## Rollback

- **No** usar `alembic downgrade` en producción con datos
- Crear migración compensatoria forward
- Redeploy imagen anterior si el código nuevo falla

## Por unidad

| Unidad | Database | Owner migraciones |
|---|---|---|
| pilot-core | `db_pilot_core` | `@TBD-pilot-core` |
| whatsapp-adapter | `db_whatsapp` | `@TBD-whatsapp` |
| documents | `db_documents` | `@TBD-documents` |
| handoff-liwa | `db_handoff` | `@TBD-handoff` |

Owners TBD: [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

## Init infra vs Alembic

- `infra/init-databases.sh` — crea DBs y roles únicamente
- Alembic — schema de aplicación

## Backup antes de migración prod

Ver [backup-restore.md](backup-restore.md).
