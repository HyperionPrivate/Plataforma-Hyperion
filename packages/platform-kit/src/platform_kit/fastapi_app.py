from __future__ import annotations

import contextlib
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import CONTENT_TYPE_LATEST, Counter, generate_latest
from starlette.responses import JSONResponse, Response

from platform_kit.auth import jwks_cache
from platform_kit.correlation import CorrelationIdMiddleware
from platform_kit.errors import register_exception_handlers
from platform_kit.health import build_health_router
from platform_kit.http_paths import normalize_route_path
from platform_kit.logging import configure_logging
from platform_kit.settings import PlatformSettings

_RATE_BUCKET_CAP = 4_096


async def _auth_readiness(settings: PlatformSettings) -> dict[str, Any]:
    """Fail readiness in staging/production when OIDC/JWKS is incomplete."""
    if settings.app_env not in ("staging", "production"):
        return {"ok": True, "mode": settings.app_env}
    ok = (
        not settings.auth_disabled
        and settings.oidc_configured()
        and jwks_cache.is_configured()
    )
    return {
        "ok": ok,
        "auth_disabled": settings.auth_disabled,
        "oidc_configured": settings.oidc_configured(),
        "jwks_configured": jwks_cache.is_configured(),
    }

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
    expose_docs: bool = True,
    product_available: bool = True,
    extra_checks: Callable[[], Any] | None = None,
) -> FastAPI:
    configure_logging(json_logs=settings.log_json, level=settings.log_level)
    jwks_cache.configure(settings)

    app = FastAPI(
        title=title,
        version=version,
        lifespan=lifespan,
        docs_url="/docs" if expose_docs else None,
        redoc_url="/redoc" if expose_docs else None,
        openapi_url="/openapi.json" if expose_docs else None,
    )
    app.state.settings = settings
    app.state.product_available = product_available
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

    # In-memory rate limit (per process) — foundation guardrail
    buckets: dict[str, list[float]] = defaultdict(list)
    _self_capped = ("/documents/upload", "/webhooks/elevenlabs/post-call")

    @app.middleware("http")
    async def _limits_mw(request: Request, call_next: Any) -> Any:
        content_length = request.headers.get("content-length")
        path = request.url.path or ""
        # AUD-029: reject unbounded bodies unless the route self-caps the stream.
        if (
            request.method in {"POST", "PUT", "PATCH"}
            and content_length is None
            and not any(path.endswith(p) for p in _self_capped)
        ):
            return JSONResponse(
                status_code=411, content={"error": "content_length_required"}
            )
        if content_length:
            try:
                if int(content_length) > settings.max_request_bytes:
                    return JSONResponse(
                        status_code=413, content={"error": "payload_too_large"}
                    )
            except ValueError:
                return JSONResponse(
                    status_code=400, content={"error": "invalid_content_length"}
                )

        client = request.client.host if request.client else "unknown"
        # AUD-025: quota by route template, not raw client-controlled path.
        route = normalize_route_path(path)
        key = f"{client}:{route}"
        now = time.monotonic()
        window = buckets[key]
        buckets[key] = [t for t in window if now - t < 60.0]
        if len(buckets[key]) >= settings.rate_limit_per_minute:
            return JSONResponse(status_code=429, content={"error": "rate_limited"})
        buckets[key].append(now)
        # Bound memory: drop emptied / oldest keys when the map grows too large.
        if len(buckets) > _RATE_BUCKET_CAP:
            stale = [k for k, v in buckets.items() if not v]
            for k in stale[: max(1, len(stale) // 2)]:
                buckets.pop(k, None)
            if len(buckets) > _RATE_BUCKET_CAP:
                for k in list(buckets.keys())[: len(buckets) - _RATE_BUCKET_CAP]:
                    buckets.pop(k, None)
        return await call_next(request)

    if not product_available:

        @app.get("/")
        async def _unavailable_root() -> JSONResponse:
            return JSONResponse(
                status_code=503,
                content={
                    "status": "unavailable",
                    "reason": "mock_satellite",
                    "service": settings.service_name,
                },
            )

    async def _merged_extra_checks() -> dict[str, Any]:
        out: dict[str, Any] = {"auth": await _auth_readiness(settings), "ok": True}
        if out["auth"].get("ok") is False:
            out["ok"] = False
        if extra_checks is not None:
            try:
                more = await extra_checks()
                if isinstance(more, dict):
                    out.update(more)
                    if more.get("ok") is False:
                        out["ok"] = False
            except Exception:  # noqa: BLE001
                out["app_checks"] = {"ok": False, "error": "extra_check_failed"}
                out["ok"] = False
        return out

    app.include_router(
        build_health_router(
            service_name=settings.service_name,
            version=version,
            engine_provider=engine_provider,
            redis_ping=redis_ping,
            extra_checks=_merged_extra_checks,
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
            # AUD-026: never label metrics with raw unbounded paths / PII-ish segments.
            HTTP_REQUESTS.labels(
                settings.service_name,
                request.method,
                normalize_route_path(request.url.path),
                str(response.status_code),
            ).inc()
        return response

    return app


@asynccontextmanager
async def empty_lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
