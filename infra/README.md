# Infraestructura local

## Componentes

| Componente | Rol |
|---|---|
| Traefik | Gateway fino; dashboard **off** por defecto |
| Postgres | DBs por unidad + roles `app_*` (`init-databases.sh`) |
| Redis | Bus (Streams en Fase 4) / cache |

Redes: `coopfuturo_edge`, `coopfuturo_app`, `coopfuturo_data`.  
Postgres/Redis publicados solo en `127.0.0.1`.

## Apps

| Ruta | Unidad |
|---|---|
| `/pilot-core` | apps/pilot-core |
| `/whatsapp` | apps/whatsapp-adapter |
| `/documents` | apps/documents |
| `/handoff` | apps/handoff-liwa |

Stubs legacy: `docker compose --profile legacy-stubs up` (no para features nuevas).

## Dialer externo

Solo `pilot-core` / orchestration. Ver [ADR-001](../docs/ADR-001-dialer-boundary.md).

```env
DIALER_BASE_URL=http://host.docker.internal:8080
DIALER_API_TOKEN=
```

## Seguridad local

- No usar `POSTGRES_USER` como credencial de aplicación.
- `LIWA_MODE=mock` hasta rotar credencial comprometida ([EXTERNAL_BLOCKERS](../docs/EXTERNAL_BLOCKERS.md)).
- Dashboard Traefik no publicado.
