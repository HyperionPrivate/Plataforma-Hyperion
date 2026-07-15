from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ErrorEnvelope(BaseModel):
    error_code: str
    message: str
    correlation_id: str | None = None
    details: dict[str, Any] | None = None


class PlatformError(Exception):
    def __init__(
        self,
        error_code: str,
        message: str,
        *,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.status_code = status_code
        self.details = details


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(PlatformError)
    async def _platform_error(request: Request, exc: PlatformError) -> JSONResponse:
        from platform_kit.correlation import get_correlation_id

        body = ErrorEnvelope(
            error_code=exc.error_code,
            message=exc.message,
            correlation_id=get_correlation_id() or None,
            details=exc.details,
        )
        return JSONResponse(status_code=exc.status_code, content=body.model_dump())

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        from platform_kit.correlation import get_correlation_id

        body = ErrorEnvelope(
            error_code="internal_error",
            message="Internal server error",
            correlation_id=get_correlation_id() or None,
        )
        return JSONResponse(status_code=500, content=body.model_dump())
