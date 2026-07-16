from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from platform_kit.fastapi_app import create_app

from pilot_core import __version__, ops_store, runtime
from pilot_core.routers.ops import router as ops_router
from pilot_core.routers.tech import router as tech_router
from pilot_core.settings import get_settings

settings = get_settings()


async def _pilot_extra_checks() -> dict[str, Any]:
    """AUD-034: readiness must prove Ops SQLite is usable."""
    checks: dict[str, Any] = {"ok": True}
    try:
        with ops_store.tenant_scope("health"):
            ops_store.init_db()
            ver = ops_store.schema_version()
            checks["ops_store"] = {"ok": True, "schema_version": ver}
    except Exception as exc:  # noqa: BLE001
        checks["ops_store"] = {"ok": False, "error": type(exc).__name__}
        checks["ok"] = False
    if settings.app_env in ("staging", "production"):
        secret = (settings.elevenlabs_webhook_secret or "").strip()
        checks["webhook_secret"] = {"ok": bool(secret)}
        if not secret:
            checks["ok"] = False
    return checks


@asynccontextmanager
async def lifespan(app):  # type: ignore[no-untyped-def]
    await runtime.startup(settings)
    from pilot_core.modules.post_call import watcher as post_call_watcher

    await post_call_watcher.start_background()
    try:
        yield
    finally:
        await post_call_watcher.stop_background()
        await runtime.shutdown()


app = create_app(
    settings=settings,
    version=__version__,
    title="Coopfuturo pilot-core",
    engine_provider=runtime.get_engine,
    redis_ping=runtime.redis_ping,
    routers=[tech_router, ops_router],
    lifespan=lifespan,
    # AUD2-011: hide OpenAPI in staging/production.
    expose_docs=settings.app_env not in ("staging", "production"),
    extra_checks=_pilot_extra_checks,
)
