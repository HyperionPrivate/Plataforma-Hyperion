# Runbook — Backup y restore

> **Alcance:** fundación arquitectónica. Procedimiento productivo TBD por platform.

## Componentes a respaldar

| Componente | Método | Frecuencia sugerida | Owner |
|---|---|---|---|
| PostgreSQL (×4 DBs) | `pg_dump` / snapshots managed | Diario + PITR prod | `@TBD-platform` |
| **Ops SQLite + docs locales** (`PULSO_DATA_DIR`) | `infra/scripts/backup_ops_sqlite.sh` | Diario (AUD-022) | `@TBD-platform` |
| Redis Streams | RDB/AOF snapshot | Diario (retención corta) | `@TBD-platform` |
| Object storage (MinIO/S3) | Versioning + replication | Continuo | `@TBD-platform` |
| Secretos | Secret manager native backup | Según proveedor | `@TBD-security` |

> **AUD-022:** el estado funcional de Ops (contactos, CRM, post-calls, conversaciones, settings) vive en SQLite bajo `PULSO_DATA_DIR` (volumen `pilot_core_data`). Un dump solo de PostgreSQL **no** recupera la operación del piloto.

## Backup manual local (dev)

```powershell
# Postgres técnicos
./infra/scripts/backup_postgres.sh ./backups

# Estado funcional Ops (SQLite + documentos locales) — obligatorio para restore útil
./infra/scripts/backup_ops_sqlite.sh ./backups/ops

# Postgres — ejemplo db_pilot_core
docker compose exec postgres pg_dump -U postgres db_pilot_core > backup_pilot_core.sql

# Todas las DBs
docker compose exec postgres pg_dumpall -U postgres > backup_all.sql
```

## Restore local (dev)

```powershell
# ⚠️ Destructivo — solo entornos de desarrollo
docker compose exec -T postgres psql -U postgres db_pilot_core < backup_pilot_core.sql
```

## Restore producción (principios)

1. Detener tráfico a unidad afectada (drain)
2. Restore DB desde snapshot PITR al punto acordado
3. Verificar migraciones Alembic en sync (`alembic current`)
4. Replay eventos desde outbox no publicados si aplica
5. Restaurar tráfico; monitorear lag y errores

## RPO / RTO

| Métrica | Target piloto | Target prod |
|---|---|---|
| RPO (pérdida máxima datos) | 24h (dev) | TBD |
| RTO (tiempo recuperación) | Best effort | TBD |

Definir con `@TBD-platform` antes de producción.

## Aislamiento por unidad

Cada DB se restaura **independientemente**. Restore cross-unit no existe — reconciliar vía eventos si hay divergencia.

## Pruebas de restore

- Trimestral en staging (TBD)
- Documentar duración real vs RTO

## Referencias

- [ADR-004](../adr/ADR-004-database-ownership.md)
- [data-ownership.md](../architecture/data-ownership.md)

## Ownership

`@TBD-platform` — [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).
