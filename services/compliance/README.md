# compliance

**Prioridad:** core  
**Puerto:** `8103`  
**Database:** `db_compliance`  
**Ruta Traefik:** `/compliance/*`

## Responsabilidad

Ley 1581, opt-out, ventanas. Gate antes de contactar.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/eligibility/check` | 501 |

## Eventos

- **Publica:** _ninguno aún_
- **Consume:** `optout.requested`, `contact.imported`

## Arranque local (sin Docker)

```powershell
cd services/compliance
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8103
```

## Arranque Compose

```powershell
make up svc=compliance
```

Health vía gateway: `http://localhost:8088/compliance/health`

## Owner

_TBD — ver docs/service-ownership.md_
