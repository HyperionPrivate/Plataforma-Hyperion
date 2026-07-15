# Infraestructura local

## Componentes

| Componente | Rol |
|---|---|
| Traefik | Gateway fino (sin lógica de negocio) |
| Postgres | Una database por microservicio (`init-databases.sql`) |
| Redis | Bus de eventos futuro / cache |

## Dialer externo

El Dialer **no** se construye en este monorepo. Vive en su propio repo (p.ej. `C:\Users\pc\Desktop\dialer`).

Para desarrollo local:

1. Arranca Dialer en el host (puerto `8080` por defecto).
2. En `services/orchestrator/.env` define:
   - `DIALER_BASE_URL=http://host.docker.internal:8080` (desde contenedor)
   - o `http://127.0.0.1:8080` (si orchestrator corre en el host)
3. Solo **orchestrator** debe usar esas variables.

Ver [ADR-001](../docs/ADR-001-dialer-boundary.md).

## Traefik

- HTTP: `http://localhost:8088`
- Dashboard: `http://localhost:8089`
- Prefijos: `/orchestrator`, `/crm`, `/compliance`, `/whatsapp`, `/identity`, `/documents`, `/handoff`, `/segmentation`, `/agent-config`, `/analytics`

StripPrefix quita el prefijo antes de llegar al servicio (el servicio ve `/health`, no `/crm/health`).
