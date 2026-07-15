# orchestrator

**Prioridad:** core  
**Puerto:** `8101`  
**Database:** `db_orchestrator`  
**Ruta Traefik:** `/orchestrator/*`

## Responsabilidad

Único cliente HTTP del Dialer externo. Solo sagas/coreografía.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/sagas/renovacion` | 501 |

## Eventos

- **Publica:** `call.requested`, `call.completed`
- **Consume:** `contact.imported`, `lead.qualified`, `optout.requested`

## Arranque local (sin Docker)

```powershell
cd services/orchestrator
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8101
```

## Arranque Compose

```powershell
make up svc=orchestrator
```

Health vía gateway: `http://localhost:8088/orchestrator/health`

## Owner

_TBD — ver docs/service-ownership.md_
