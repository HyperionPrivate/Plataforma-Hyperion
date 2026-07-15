# analytics

**Prioridad:** satélite  
**Puerto:** `8110`  
**Database:** `db_analytics`  
**Ruta Traefik:** `/analytics/*`

## Responsabilidad

Proyecciones de lectura para BI. No escribe CRM.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/kpis/pilot` | 501 |

## Eventos

- **Publica:** _ninguno aún_
- **Consume:** `call.completed`, `lead.qualified`, `wa.message.received`, `optout.requested`

## Arranque local (sin Docker)

```powershell
cd services/analytics
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8110
```

## Arranque Compose

```powershell
make up svc=analytics
```

Health vía gateway: `http://localhost:8088/analytics/health`

## Owner

_TBD — ver docs/service-ownership.md_
