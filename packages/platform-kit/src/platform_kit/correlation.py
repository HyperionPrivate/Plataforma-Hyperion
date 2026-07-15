from __future__ import annotations

import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

correlation_id_ctx: ContextVar[str] = ContextVar("correlation_id", default="")
tenant_id_ctx: ContextVar[str] = ContextVar("tenant_id", default="")


def get_correlation_id() -> str:
    return correlation_id_ctx.get() or ""


def get_tenant_id() -> str:
    return tenant_id_ctx.get() or ""


def new_correlation_id() -> str:
    return str(uuid.uuid4())


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: object, header_name: str = "X-Correlation-ID") -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self.header_name = header_name

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        cid = request.headers.get(self.header_name) or new_correlation_id()
        token = correlation_id_ctx.set(cid)
        try:
            response = await call_next(request)
            response.headers[self.header_name] = cid
            return response
        finally:
            correlation_id_ctx.reset(token)
