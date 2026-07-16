"""RBAC helpers for Ops product routes (AUD-003)."""

from __future__ import annotations

from datetime import time

from fastapi import Depends
from platform_kit.auth import AuthContext, require_auth
from platform_kit.errors import PlatformError

from pilot_core import ops_store
from pilot_core.modules.compliance.service import compliance_service
from pilot_core.settings import get_settings

# Role sets used by Ops endpoints.
OPS_OPERATE = ("admin", "supervisor", "advisor")  # CRM, conversaciones, WA, docs
OPS_MANAGE = ("admin", "supervisor")  # campañas, import, orquestación, e2e
OPS_ADMIN = ("admin",)  # settings privilegiados / dialer


def hydrate_ops_runtime() -> None:
    """Apply dialer/channels persisted for the current tenant (ContextVar)."""
    dialer = ops_store.get_setting("dialer")
    if isinstance(dialer, dict):
        s = get_settings()
        # base_url is env-owned (AUD-005); never hydrate attacker-controlled URLs.
        if "default_phone_number_id" in dialer:
            object.__setattr__(
                s,
                "dialer_default_phone_number_id",
                str(dialer.get("default_phone_number_id") or ""),
            )
    channels = ops_store.get_setting("channels")
    if isinstance(channels, dict) and channels.get("ventana_8_20") is False:
        compliance_service.window_start = time(0, 0)
        compliance_service.window_end = time(23, 59)
    else:
        compliance_service.window_start = time(8, 0)
        compliance_service.window_end = time(20, 0)
    compliance_service.hydrate()


async def require_ops_auth(ctx: AuthContext = Depends(require_auth)) -> AuthContext:
    """Authenticate and hydrate per-tenant runtime settings."""
    hydrate_ops_runtime()
    return ctx


def require_ops_roles(*needed: str):
    """Like require_roles, but runs after Ops tenant hydrate."""

    async def _dep(ctx: AuthContext = Depends(require_ops_auth)) -> AuthContext:
        if "admin" in ctx.roles:
            return ctx
        if not set(needed) & set(ctx.roles):
            raise PlatformError("forbidden", "Insufficient role", status_code=403)
        return ctx

    return _dep


def can_manage_conversation(ctx: AuthContext, claim: dict | None) -> bool:
    if "admin" in ctx.roles or "supervisor" in ctx.roles:
        return True
    if not claim:
        return True
    owner = str(claim.get("owner_subject") or "")
    return bool(owner) and owner == ctx.subject
