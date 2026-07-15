# apps/web — Ops UI (PULSO)

## Decisión arquitectónica

El monorepo en `feat/architecture-foundation` es **modular-first multi-service** (4 unidades FastAPI + `platform-kit`), **no** microfrontends. La UI aparece en C4 como *Cliente / UI* detrás de Traefik ([docs/architecture.md](../../docs/architecture.md)) y en el backlog como **ops UI** ([PRODUCT_BACKLOG.md](../../docs/PRODUCT_BACKLOG.md) #13).

Esta app es esa UI:

| Aspecto | Elección |
|---|---|
| Ubicación | `apps/web` (misma convención `apps/*` que las unidades desplegables) |
| Stack | Next.js 15 App Router, TypeScript, Tailwind |
| Datos hoy | **Mock** (`NEXT_PUBLIC_API_MODE=mock`, JSON en `src/data`) |
| Gateway | Dev local `:3000`. En `docker-compose.dev.yml`, servicio `web` detrás de Traefik en `/` (excluye `/pilot-core`, `/whatsapp`, `/documents`, `/handoff`) |
| Relación con pilot-core | Futuro: BFF/API vía Traefik; hoy cero llamadas HTTP a backends |

## Por qué no se metió dentro de pilot-core

- Separación de concerns: Python/FastAPI ≠ React/Next.
- Ciclo de release y tooling distintos (npm vs uv).
- ADR-005 permite unidades desplegables por evidencia; la UI es un cliente, no un módulo de dominio.

## Arranque

```powershell
cd apps/web
npm install
npm run dev
```

Abrir http://localhost:3000 → `/dashboard`.

Con stack Docker (`make up` / `docker compose -f docker-compose.dev.yml up`):

- UI vía Traefik: `http://127.0.0.1:8088/dashboard` (puerto `TRAEFIK_HTTP_PORT`, default 8088)
- APIs siguen en `/pilot-core`, `/whatsapp`, etc.

Imagen: `apps/web/Dockerfile` (`output: "standalone"`).

## Design system

Referencias en `/design` (raíz del monorepo), mockups en `design/mockups/`. Kit en vivo: `/dev/kit`.

## White-label

Sin nombres de proveedores externos (ElevenLabs, Meta, Evolution) en UI.
