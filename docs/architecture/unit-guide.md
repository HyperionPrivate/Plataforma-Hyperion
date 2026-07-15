# Guía de unidades desplegables

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Las cuatro unidades

| Unidad | Cuándo crear código aquí | Cuándo NO |
|---|---|---|
| `pilot-core` | Dominio central: contactos, campañas, CRM, compliance, voz orchestration | Integraciones LIWA directas |
| `whatsapp-adapter` | Todo lo WhatsApp/WABA/LIWA canal | Lógica CRM o campañas |
| `documents` | Metadatos, validación, storage refs | Binarios en Postgres |
| `handoff-liwa` | Expedientes, SLA, asignación asesores | Funnels o scoring |

## Anatomía de una unidad

```text
apps/<unit>/
├── Dockerfile
├── pyproject.toml
├── .env.example          # placeholders only
├── migrations/           # Alembic (fase posterior)
├── src/<package>/
│   ├── main.py           # FastAPI app
│   └── settings.py
└── tests/
```

## Checklist nueva unidad (solo con ADR)

Extracción desde `pilot-core` requiere [ADR-013](../adr/ADR-013-extraction-criteria.md) y ADR dedicado.

1. DB propia + rol `app_*` en `init-databases.sh`
2. Entrada en Traefik (`infra/`)
3. OpenAPI + eventos en `contracts/`
4. CODEOWNERS placeholder TBD
5. Health + readiness endpoints
6. Outbox/inbox tables
7. Entrada en [service-catalog.md](service-catalog.md)

## Comunicación entre unidades

| Tipo | Mecanismo | Auth |
|---|---|---|
| Async preferido | Redis Streams + contratos | Redis ACL + schema validation |
| Sync cuando necesario | HTTP interno | Service token ([ADR-008](../adr/ADR-008-service-to-service-auth.md)) |
| Prohibido | SQL cross-DB, shared tables | — |

## Variables de entorno comunes

```env
SERVICE_NAME=
DATABASE_URL=          # rol app_* only
REDIS_URL=
LOG_LEVEL=INFO
```

Secretos: ver [ADR-009](../adr/ADR-009-secrets-strategy.md). **Nunca valores reales en repo.**

## CI local

```powershell
make format && make lint && make typecheck && make test
```

## Stubs legacy

No añadir endpoints nuevos en `services/*`. Migrar a `apps/*` con paridad de tests.

## Ownership

Ver [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

## Referencias

- [ADR-001](../adr/ADR-001-modular-architecture.md)
- [unit-guide vs module-guide](module-guide.md)
- [local-dev.md](local-dev.md)
