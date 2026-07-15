from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import CONTENT_TYPE_LATEST, Counter, generate_latest
from starlette.responses import Response

from platform_kit.auth import jwks_cache
from platform_kit.correlation import CorrelationIdMiddleware
from platform_kit.errors import register_exception_handlers
from platform_kit.health import build_health_router
from platform_kit.logging import configure_logging
from platform_kit.settings import PlatformSettings

HTTP_REQUESTS = Counter(
    "coopfuturo_http_requests_total",
    "HTTP requests",
    ["service", "method", "path", "status"],
)


def create_app(
    *,
    settings: PlatformSettings,
    version: str,
    title: str,
    engine_provider: Callable[[], Any],
    redis_ping: Callable[[], Any] | None = None,
    routers: Sequence[Any] = (),
    lifespan: Any | None = None,
) -> FastAPI:
    configure_logging(json_logs=settings.log_json, level=settings.log_level)
    jwks_cache.configure(settings)

    app = FastAPI(title=title, version=version, lifespan=lifespan)
    app.state.settings = settings
    register_exception_handlers(app)
    app.add_middleware(CorrelationIdMiddleware, header_name=settings.correlation_header)

    origins = [o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["*"],
        )

    app.include_router(
        build_health_router(
            service_name=settings.service_name,
            version=version,
            engine_provider=engine_provider,
            redis_ping=redis_ping,
        )
    )
    for r in routers:
        app.include_router(r)

    if settings.metrics_enabled:

        @app.get("/metrics")
        async def metrics() -> Response:
            return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.middleware("http")
    async def _metrics_mw(request: Any, call_next: Any) -> Any:
        response = await call_next(request)
        with contextlib.suppress(Exception):
            HTTP_REQUESTS.labels(
                settings.service_name,
                request.method,
                request.url.path,
                str(response.status_code),
            ).inc()
        return response

    return app


@asynccontextmanager
async def empty_lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
