from fastapi import FastAPI, Header, Response
from fastapi.responses import JSONResponse

from app.settings import get_settings

settings = get_settings()

app = FastAPI(
    title="Coopfuturo crm",
    version="0.1.0-stub",
    description="Dueño canónico de funnel_state y tipificaciones.",
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": settings.service_name}


@app.get("/health/ready")
def ready() -> dict[str, str]:
    # Stub: listo sin comprobar DB/Redis reales todavía.
    return {"status": "ready", "service": settings.service_name, "env": settings.app_env}


@app.api_route("/contacts/{contact_id}/state", methods=["GET", "POST", "PUT", "PATCH"])
def business_stub(
    response: Response,
    x_correlation_id: str | None = Header(default=None, alias="X-Correlation-ID"),
) -> JSONResponse:
    """Endpoint de negocio aún no implementado."""
    response.status_code = 501
    return JSONResponse(
        status_code=501,
        content={
            "detail": "Not implemented — stub",
            "service": settings.service_name,
            "path": "/contacts/{contact_id}/state",
            "summary": "Actualiza funnel_state (stub).",
            "correlation_id": x_correlation_id,
        },
    )
