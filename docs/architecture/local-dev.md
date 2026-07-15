# Desarrollo local

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Prerrequisitos

- Python 3.12+
- Docker + Docker Compose
- `uv` (gestor de paquetes)
- Make (o ejecutar comandos equivalentes en PowerShell)

## Bootstrap

```powershell
git clone https://github.com/AdministracionHyperion/CoopFuturo_.git
cd CoopFuturo_
git checkout feat/architecture-foundation
copy .env.example .env
make bootstrap
```

## Variables críticas (`.env`)

```env
# Postgres — apps usan roles app_*, no POSTGRES_USER
# LIWA — mock obligatorio hasta rotación externa
LIWA_MODE=mock
LIWA_BASE_URL=
LIWA_API_TOKEN=

# Dialer — opcional en local
DIALER_BASE_URL=http://host.docker.internal:8080
DIALER_API_TOKEN=
```

Ver [EXTERNAL_BLOCKERS.md](../EXTERNAL_BLOCKERS.md) para bloqueos externos.

## Levantar stack

```powershell
make up
# o: docker compose -f docker-compose.dev.yml up -d
```

## Endpoints locales (vía Traefik)

| Ruta | Unidad |
|---|---|
| `http://localhost/pilot-core/health` | pilot-core |
| `http://localhost/whatsapp/health` | whatsapp-adapter |
| `http://localhost/documents/health` | documents |
| `http://localhost/handoff-liwa/health` | handoff-liwa |

Puertos directos: 8201–8204 (ver [service-catalog.md](service-catalog.md)).

## Desarrollo sin Docker (una app)

```powershell
cd apps/pilot-core
uv sync
uvicorn pilot_core.main:app --reload --port 8201
```

Requiere Postgres y Redis locales o tunelados.

## Calidad

```powershell
make format && make lint && make typecheck && make test && make contracts
```

## Stubs legacy (no recomendado)

```powershell
docker compose -f docker-compose.dev.yml --profile legacy-stubs up
```

## Redes y seguridad local

- Postgres/Redis en `127.0.0.1` únicamente
- Dashboard Traefik deshabilitado
- Sin secretos reales — ver [ADR-009](../adr/ADR-009-secrets-strategy.md)

## Runbooks

- [startup.md](../runbooks/startup.md)
- [migrations.md](../runbooks/migrations.md)

## Ownership / soporte

Issues de infra: `@TBD-platform` (TBD — [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md)).
