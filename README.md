# Coopfuturo — monorepo de microservicios autónomos

Scaffold de la plataforma PULSO / Hyperion One para Coopfuturo.  
**Solo arquitectura y stubs:** sin funnels, WhatsApp real ni lógica de negocio.

## Principios

- Cada carpeta bajo `services/` es un **microservicio autónomo** (imagen, env, DB, deploy propios).
- Sin librería runtime compartida. `contracts/` son esquemas versionados (JSON), no un paquete Python.
- El gateway es **Traefik** (proxy fino), no un BFF con lógica.
- Solo **orchestrator** habla con el Dialer externo (`C:\Users\pc\Desktop\dialer` u otro host).
- Comunicación: HTTP o eventos. Prohibido importar código o leer DB de otro servicio.

## Servicios

| Servicio | Prioridad | Puerto interno | Database |
|---|---|---|---|
| orchestrator | core | 8101 | db_orchestrator |
| crm | core | 8102 | db_crm |
| compliance | core | 8103 | db_compliance |
| whatsapp | core | 8104 | db_whatsapp |
| identity | core | 8105 | db_identity |
| documents | satélite | 8106 | db_documents |
| handoff | satélite | 8107 | db_handoff |
| segmentation | satélite | 8108 | db_segmentation |
| agent-config | satélite | 8109 | db_agent_config |
| analytics | satélite | 8110 | db_analytics |

Gateway Traefik: `http://localhost:8088` (dashboard `8089`).

## Arranque local

```powershell
copy .env.example .env
make up
# o un solo servicio:
make up svc=crm
```

Health de ejemplo: `http://localhost:8088/crm/health`

## Documentación

- [Arquitectura](docs/architecture.md)
- [Ownership](docs/service-ownership.md)
- [Anti-patrones](docs/anti-patterns.md)
- [Contribuir](CONTRIBUTING.md)
- ADRs en `docs/`

## Dialer externo

No se construye aquí. Ver [infra/README.md](infra/README.md) y [ADR-001](docs/ADR-001-dialer-boundary.md).
