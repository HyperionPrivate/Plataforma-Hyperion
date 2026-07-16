from __future__ import annotations

from contextlib import asynccontextmanager

from platform_kit.fastapi_app import create_app

from documents_app import __version__, runtime
from documents_app.routers.tech import router as tech_router
from documents_app.settings import get_settings

settings = get_settings()


@asynccontextmanager
async def lifespan(app):  # type: ignore[no-untyped-def]
    await runtime.startup(settings)
    try:
        yield
    finally:
        await runtime.shutdown()


# AUD-032: mock satellite — not a product surface (no docs / Traefik in Contabo).
app = create_app(
    settings=settings,
    version=__version__,
    title="Coopfuturo documents (MOCK storage)",
    engine_provider=runtime.get_engine,
    redis_ping=runtime.redis_ping,
    routers=[tech_router],
    lifespan=lifespan,
    expose_docs=False,
    product_available=False,
)
