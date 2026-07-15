# crm

**Prioridad:** core  
**Puerto:** `8102`  
**Database:** `db_crm`  
**Ruta Traefik:** `/crm/*`

## Responsabilidad

Dueño canónico de funnel_state y tipificaciones.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/contacts/{contact_id}/state` | 501 |

## Eventos

- **Publica:** `lead.qualified`
- **Consume:** `contact.imported`, `call.completed`, `wa.message.received`

## Arranque local (sin Docker)

```powershell
cd services/crm
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8102
```

## Arranque Compose

```powershell
make up svc=crm
```

Health vía gateway: `http://localhost:8088/crm/health`

## Owner

_TBD — ver docs/service-ownership.md_
