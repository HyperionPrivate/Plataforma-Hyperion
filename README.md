# Coopfuturo — architecture foundation (PULSO / Hyperion One)

Base técnica + **piloto Ops** (campañas/import/CRM/revisión post-llamada) sobre `pilot-core` `/ops`.  
Canales reales (LIWA/Dialer/IdP/TLS) siguen sujetos a [docs/EXTERNAL_BLOCKERS.md](docs/EXTERNAL_BLOCKERS.md).

## Unidades desplegables

| App | Rol técnico |
|---|---|
| `apps/pilot-core` | Ops API + orchestration / post-call / CRM (SQLite ops + Postgres plataforma) |
| `apps/whatsapp-adapter` | Interfaces + **MOCK** proveedor (satélite) |
| `apps/documents` | Interfaces + object storage |
| `apps/handoff-liwa` | Interfaces + **MOCK** LIWA (satélite) |
| `apps/web` | Ops UI PULSO (Next.js) — `API_MODE=live` habla `/ops`; `mock` usa JSON local |

Kit técnico compartido: `packages/platform-kit` (sin lógica comercial).

## Ops UI (frontend)

```powershell
cd apps/web
npm install
npm run dev
```

http://localhost:3000 — ver [apps/web/ARCHITECTURE.md](apps/web/ARCHITECTURE.md) y [apps/web/README.md](apps/web/README.md).

Con Traefik (compose): `http://127.0.0.1:8088/dashboard` tras `docker compose -f docker-compose.dev.yml up`.

## Quick start

```powershell
git clone https://github.com/AdministracionHyperion/CoopFuturo_.git
cd CoopFuturo_
git checkout main
copy .env.example .env
make bootstrap
make test
make contracts
make smoke
make up
```

Health: `http://127.0.0.1:8088/pilot-core/health/live`

## Seguridad

- Ver [SECURITY.md](SECURITY.md)
- Credencial LIWA histórica expuesta → **rotar fuera del repo** ([EXTERNAL_BLOCKERS](docs/EXTERNAL_BLOCKERS.md))
- Owners reales pendientes ([OWNERSHIP_REQUEST](docs/OWNERSHIP_REQUEST.md))

## Documentación

- [Arquitectura](docs/architecture/)
- [ADRs](docs/adr/)
- [Runbooks](docs/runbooks/)
- [Contratos](contracts/)

## Stubs legacy

`services/*` solo con profile `legacy-stubs`. No features nuevas.
