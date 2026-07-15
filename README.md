# Coopfuturo — architecture foundation (PULSO / Hyperion One)

Base técnica **lista para desarrollar el producto**.  
**No** incluye lógica comercial de campañas, funnels, WhatsApp real, Dialer real, ni handoff funcional.

## Unidades desplegables

| App | Rol técnico |
|---|---|
| `apps/pilot-core` | Módulos internos + orchestration interface al Dialer externo |
| `apps/whatsapp-adapter` | Interfaces + **MOCK** proveedor |
| `apps/documents` | Interfaces + **MOCK** object storage |
| `apps/handoff-liwa` | Interfaces + **MOCK** LIWA |

Kit técnico compartido: `packages/platform-kit` (sin lógica comercial).

## Quick start

```powershell
git clone https://github.com/AdministracionHyperion/CoopFuturo_.git
cd CoopFuturo_
git checkout feat/architecture-foundation   # o main tras merge
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
