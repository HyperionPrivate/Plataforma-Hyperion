from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncEngine

from platform_kit.db import check_database


def build_health_router(
    *,
    service_name: str,
    version: str,
    engine_provider: Callable[[], AsyncEngine | None],
    redis_ping: Callable[[], Awaitable[bool]] | None = None,
    extra_checks: Callable[[], Awaitable[dict[str, Any]]] | None = None,
) -> APIRouter:
    router = APIRouter(tags=["health"])

    @router.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "alive", "service": service_name}

    @router.get("/health/ready")
    async def ready(response: Response) -> JSONResponse:
        checks: dict[str, Any] = {}
        ok = True
        engine = engine_provider()
        if engine is None:
            checks["database"] = {"ok": False, "error": "engine_not_initialized"}
            ok = False
        else:
            try:
                checks["database"] = await check_database(engine)
                if checks["database"].get("alembic_version") is None:
                    checks["database"]["migrations"] = "missing"
                    ok = False
                else:
                    checks["database"]["migrations"] = "ok"
            except Exception as exc:  # noqa: BLE001
                checks["database"] = {"ok": False, "error": str(exc)}
                ok = False

        if redis_ping is not None:
            try:
                checks["redis"] = {"ok": await redis_ping()}
                if not checks["redis"]["ok"]:
                    ok = False
            except Exception as exc:  # noqa: BLE001
                checks["redis"] = {"ok": False, "error": str(exc)}
                ok = False

        if extra_checks is not None:
            try:
                checks["extra"] = await extra_checks()
            except Exception as exc:  # noqa: BLE001
                checks["extra"] = {"ok": False, "error": str(exc)}
                ok = False

        status = "ready" if ok else "not_ready"
        code = 200 if ok else 503
        return JSONResponse(
            status_code=code,
            content={
                "status": status,
                "service": service_name,
                "version": version,
                "checks": checks,
            },
        )

    @router.get("/version")
    async def version_endpoint() -> dict[str, str]:
        return {"service": service_name, "version": version}

    return router
