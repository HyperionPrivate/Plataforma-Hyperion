# Runbook — Arranque del stack

> **Alcance:** fundación arquitectónica. Entorno local / piloto.

## Arranque completo (Docker Compose)

```powershell
cd C:\Users\pc\Desktop\coopfuturo
copy .env.example .env
make bootstrap
make up
```

## Verificación post-arranque

```powershell
# Health checks
curl http://localhost/pilot-core/health
curl http://localhost/whatsapp/health
curl http://localhost/documents/health
curl http://localhost/handoff/health

# Smoke imports
make smoke
```

Respuesta esperada: HTTP 200 con `{"status":"ok",...}`.

## Orden de dependencias

1. **PostgreSQL** — init DBs y roles (`init-databases.sh`)
2. **Redis**
3. **MinIO/S3** (documents)
4. **Apps** — pilot-core, whatsapp-adapter, documents, handoff-liwa
5. **Traefik** — enruta cuando apps están healthy

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
