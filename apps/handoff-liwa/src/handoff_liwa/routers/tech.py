from __future__ import annotations

from fastapi import APIRouter, Depends
from platform_kit.auth import AuthContext, require_auth, require_roles, require_roles_and_scopes
from platform_kit.correlation import get_correlation_id, new_correlation_id
from platform_kit.db import TechnicalProbe, session_scope
from platform_kit.errors import PlatformError
from platform_kit.events.consumer import consume_batch, relay_outbox
from platform_kit.events.envelope import build_synthetic_ping
from platform_kit.events.handlers import architecture_effect
from platform_kit.events.outbox_inbox import enqueue_outbox
from pydantic import BaseModel

from handoff_liwa import runtime
from handoff_liwa.settings import get_settings

router = APIRouter(prefix="/_tech", tags=["technical"])


class PingBody(BaseModel):
    marker: str = "architecture"


@router.post("/synthetic-event")
async def synthetic_event(
    body: PingBody,
    ctx: AuthContext = Depends(
        require_roles_and_scopes("service", "admin", scopes=("tech:write",))
    ),
) -> dict[str, object]:
    """Enqueue synthetic ping via outbox, then relay after commit."""
    if runtime.session_factory is None or runtime.transport is None:
        raise PlatformError("not_ready", "Runtime not started", status_code=503)
    settings = get_settings()
    cid = get_correlation_id() or new_correlation_id()
    envelope = build_synthetic_ping(
        producer=settings.service_name,
        tenant_id=ctx.tenant_id,
        correlation_id=cid,
        marker=body.marker,
    )
    async with session_scope(runtime.session_factory) as session:
        await enqueue_outbox(session, envelope)
    stats = await relay_outbox(runtime.session_factory, runtime.transport, settings)
    return {
        "mock_commercial": False,
        "event_id": envelope.event_id,
        "published": stats.published,
        "relay_failed": stats.failed,
        "relay_poisoned": stats.poisoned,
        "correlation_id": cid,
        "event_type": envelope.event_type,
    }


@router.post("/relay-outbox")
async def relay_outbox_endpoint(
    ctx: AuthContext = Depends(
        require_roles_and_scopes("service", "admin", scopes=("tech:write",))
    ),
) -> dict[str, object]:
    if runtime.session_factory is None or runtime.transport is None:
        raise PlatformError("not_ready", "Runtime not started", status_code=503)
    settings = get_settings()
    stats = await relay_outbox(runtime.session_factory, runtime.transport, settings)
    return {
        "published": stats.published,
        "failed": stats.failed,
        "poisoned": stats.poisoned,
        "tenant": ctx.tenant_id,
    }


@router.post("/consume-once")
async def consume_once(
    ctx: AuthContext = Depends(
        require_roles_and_scopes("service", "admin", scopes=("tech:write",))
    ),
) -> dict[str, object]:
    if runtime.session_factory is None or runtime.transport is None:
        raise PlatformError("not_ready", "Runtime not started", status_code=503)
    settings = get_settings()
    stats = await consume_batch(
        runtime.session_factory,
        runtime.transport,
        settings,
        consumer_name=f"{settings.service_name}-1",
        count=10,
        block_ms=200,
        effect=architecture_effect,
    )
    return {
        "applied": stats.applied,
        "duplicates": stats.duplicates,
        "dead_lettered": stats.dead_lettered,
        "reclaimed": stats.reclaimed,
        "failed": stats.failed,
        "malformed": stats.malformed,
        "tenant": ctx.tenant_id,
    }


@router.post("/probe")
async def write_probe(
    body: PingBody,
    ctx: AuthContext = Depends(
        require_roles_and_scopes("admin", "service", scopes=("tech:write",))
    ),
) -> dict[str, str]:
    if runtime.session_factory is None:
        raise PlatformError("not_ready", "Runtime not started", status_code=503)
    async with session_scope(runtime.session_factory) as session:
        row = TechnicalProbe(marker=f"{body.marker}:{ctx.tenant_id}")
        session.add(row)
        await session.flush()
        return {"id": row.id, "marker": row.marker}


@router.get("/secure-ping")
async def secure_ping(ctx: AuthContext = Depends(require_auth)) -> dict[str, object]:
    return {
        "subject": ctx.subject,
        "tenant_id": ctx.tenant_id,
        "roles": sorted(ctx.roles),
        "token_type": ctx.token_type,
    }


@router.get("/admin-only")
async def admin_only(ctx: AuthContext = Depends(require_roles("admin"))) -> dict[str, str]:
    return {"ok": "true", "subject": ctx.subject}
