# agent-config

**Prioridad:** satélite  
**Puerto:** `8109`  
**Database:** `db_agent_config`  
**Ruta Traefik:** `/agent-config/*`

## Responsabilidad

Versionado de prompts/agentes. Orchestrator consume por HTTP.

## Endpoints stub

| Método | Ruta | Estado |
|---|---|---|
| GET | `/health` | 200 |
| GET | `/health/ready` | 200 |
| * | `/agents/{agent_id}` | 501 |

## Eventos

- **Publica:** _ninguno aún_
- **Consume:** _ninguno aún_

## Arranque local (sin Docker)

```powershell
cd services/agent-config
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
cd src
uvicorn app.main:app --reload --port 8109
```

## Arranque Compose

```powershell
make up svc=agent-config
```

Health vía gateway: `http://localhost:8088/agent-config/health`

## Owner

_TBD — ver docs/service-ownership.md_
