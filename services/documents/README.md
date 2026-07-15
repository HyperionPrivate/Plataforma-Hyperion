# documents

**Prioridad:** satélite  
**Puerto:** `8106`  
**Database:** `db_documents`  
**Ruta Traefik:** `/documents/*`

## Responsabilidad

Validación básica de orden de matrícula / docs.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/documents` | 501 |

## Eventos

- **Publica:** _ninguno aún_
- **Consume:** `wa.message.received`

## Arranque local (sin Docker)

```powershell
cd services/documents
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8106
```

## Arranque Compose

```powershell
make up svc=documents
```

Health vía gateway: `http://localhost:8088/documents/health`

## Owner

_TBD — ver docs/service-ownership.md_
