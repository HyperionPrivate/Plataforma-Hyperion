# identity

**Prioridad:** core  
**Puerto:** `8105`  
**Database:** `db_identity`  
**Ruta Traefik:** `/identity/*`

## Responsabilidad

Stub de identidad. JWT en edge documentado; sin auth productiva aún.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/auth/token` | 501 |

## Eventos

- **Publica:** _ninguno aún_
- **Consume:** _ninguno aún_

## Arranque local (sin Docker)

```powershell
cd services/identity
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8105
```

## Arranque Compose

```powershell
make up svc=identity
```

Health vía gateway: `http://localhost:8088/identity/health`

## Owner

_TBD — ver docs/service-ownership.md_
