# segmentation

**Prioridad:** satélite  
**Puerto:** `8108`  
**Database:** `db_segmentation`  
**Ruta Traefik:** `/segmentation/*`

## Responsabilidad

Scoring y priorización. No despacha llamadas.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/score` | 501 |

## Eventos

- **Publica:** `contact.imported`
- **Consume:** `call.completed`, `wa.message.received`

## Arranque local (sin Docker)

```powershell
cd services/segmentation
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8108
```

## Arranque Compose

```powershell
make up svc=segmentation
```

Health vía gateway: `http://localhost:8088/segmentation/health`

## Owner

_TBD — ver docs/service-ownership.md_
