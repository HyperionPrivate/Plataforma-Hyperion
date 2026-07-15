# whatsapp

**Prioridad:** core  
**Puerto:** `8104`  
**Database:** `db_whatsapp`  
**Ruta Traefik:** `/whatsapp/*`

## Responsabilidad

Adaptador de canal WhatsApp. No conoce SIP ni Dialer.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/threads/{thread_id}/messages` | 501 |

## Eventos

- **Publica:** `wa.message.received`, `optout.requested`
- **Consume:** `lead.qualified`, `call.completed`

## Arranque local (sin Docker)

```powershell
cd services/whatsapp
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8104
```

## Arranque Compose

```powershell
make up svc=whatsapp
```

Health vía gateway: `http://localhost:8088/whatsapp/health`

## Owner

_TBD — ver docs/service-ownership.md_
