from __future__ import annotations

from contextlib import asynccontextmanager

from platform_kit.fastapi_app import create_app

from pilot_core import __version__, runtime
from pilot_core.routers.ops import router as ops_router
from pilot_core.routers.tech import router as tech_router
from pilot_core.settings import get_settings

settings = get_settings()


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
)
