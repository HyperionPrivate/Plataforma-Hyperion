# Runbook — Arranque del stack

> **Alcance:** fundación arquitectónica. Entorno local / piloto.

## Arranque completo (Docker Compose)

```powershell
cd C:\Users\pc\Desktop\coopfuturo
copy .env.example .env
make bootstrap
make up
```

Traefik escucha en `http://127.0.0.1:8088` (ver `TRAEFIK_HTTP_PORT`).

## Verificación post-arranque

```powershell
# Health checks (live)
curl http://127.0.0.1:8088/pilot-core/health/live
curl http://127.0.0.1:8088/whatsapp/health/live
curl http://127.0.0.1:8088/documents/health/live
curl http://127.0.0.1:8088/handoff/health/live

# Readiness (DB + Redis + migraciones)
curl http://127.0.0.1:8088/pilot-core/health/ready

# Smoke imports
make smoke
```

Respuesta live esperada: HTTP 200 con `{"status":"alive",...}`.
Respuesta ready esperada: HTTP 200 con `{"status":"ready",...}` o 503 si DB/Redis caídos.

## Orden de dependencias

1. **PostgreSQL** — init DBs y roles (`init-databases.sh`); usuario admin `coopfuturo_admin`, apps usan `app_*`
2. **Redis**
3. **MinIO/S3** (documents)
4. **Migraciones** — servicios `migrate-*`
5. **Apps** — pilot-core, whatsapp-adapter, documents, handoff-liwa
6. **Traefik** — enruta cuando apps están healthy

## Variables obligatorias

| Variable | Valor local recomendado |
|---|---|
| `LIWA_MODE` | `mock` (hasta rotación credencial) |
| `POSTGRES_*` | Ver `.env.example` |
| `REDIS_URL` | `redis://redis:6379/0` |

## Arranque individual (debug)

```powershell
cd apps/pilot-core
uv run uvicorn pilot_core.main:app --reload --port 8201
```

## Fallos comunes

| Síntoma | Causa | Acción |
|---|---|---|
| App no conecta a Postgres | DB no inicializada | `docker compose down -v` y `make up` (solo dev) |
| LIWA errors | Token real sin rotar | Forzar `LIWA_MODE=mock` |
| Puerto en uso | Instancia previa | `docker compose down` |
| Traefik 502 | App no ready | Revisar logs: `docker compose logs pilot-core` |

## Escalado / producción

Procedimiento TBD por `@TBD-platform`. Ver [ADR-015](../adr/ADR-015-deploy-rollback.md).

## Referencias

- [local-dev.md](../architecture/local-dev.md)
- [EXTERNAL_BLOCKERS.md](../EXTERNAL_BLOCKERS.md)
- [SECURITY_EXCEPTIONS.md](../SECURITY_EXCEPTIONS.md)
