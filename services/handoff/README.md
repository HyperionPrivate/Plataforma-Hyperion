# handoff

**Prioridad:** satélite  
**Puerto:** `8107`  
**Database:** `db_handoff`  
**Ruta Traefik:** `/handoff/*`

## Responsabilidad

Transferencia humana con expediente. Integración LIWA futura.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/handoffs` | 501 |

## Eventos

- **Publica:** _ninguno aún_
- **Consume:** `lead.qualified`

## Arranque local (sin Docker)

```powershell
cd services/handoff
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8107
```

## Arranque Compose

```powershell
make up svc=handoff
```

Health vía gateway: `http://localhost:8088/handoff/health`

## Owner

_TBD — ver docs/service-ownership.md_
