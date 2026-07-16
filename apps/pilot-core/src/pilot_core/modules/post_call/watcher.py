"""Post-call watcher — poll ElevenLabs until hangup, then tipify + WhatsApp.

Primary path remains the ElevenLabs webhook. This watcher is the reliability
fallback so WhatsApp still goes out when the webhook is delayed or missing.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from pilot_core import ops_store
from pilot_core.modules.elevenlabs_conversations import (
    conversation_has_usable_content,
    conversation_is_finished,
    fetch_conversation,
)
from pilot_core.modules.post_call.service import post_call_service
from pilot_core.settings import get_settings

logger = logging.getLogger(__name__)

_active: set[str] = set()
_lock = asyncio.Lock()
_sweep_task: asyncio.Task[None] | None = None
_watch_tasks: set[asyncio.Task[Any]] = set()
_sem: asyncio.Semaphore | None = None


def _watch_semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        cap = int(getattr(get_settings(), "post_call_watch_concurrency", 32) or 32)
        _sem = asyncio.Semaphore(max(1, cap))
    return _sem


def _already_done(conversation_id: str) -> bool:
    prior = ops_store.get_post_call_by_conversation(conversation_id)
    if not prior:
        return False
    return str(prior.get("status") or "") == "completed"


async def _claim_watch(conversation_id: str) -> bool:
    async with _lock:
        if conversation_id in _active:
            return False
        if _already_done(conversation_id):
            return False
        _active.add(conversation_id)
        return True


async def _release_watch(conversation_id: str) -> None:
    async with _lock:
        _active.discard(conversation_id)


async def watch_conversation(
    conversation_id: str,
    *,
    dispatch_id: str | None = None,
    phone: str | None = None,
    first_name: str | None = None,
    flow: str | None = None,
    tenant_id: str | None = None,
) -> dict[str, Any] | None:
    """Poll until the SIP call ends, then run post_call_service.process."""
    cid = (conversation_id or "").strip()
    if not cid:
        return None
    settings = get_settings()
    if not bool(getattr(settings, "post_call_poller_enabled", True)):
        return None
    tid = (tenant_id or "").strip() or ops_store.find_tenant_for_conversation(cid) or "tenant-dev"
    with ops_store.tenant_scope(tid):
        if not await _claim_watch(cid):
            return None

    interval = float(getattr(settings, "post_call_poll_interval_sec", 5.0) or 5.0)
    max_wait = int(getattr(settings, "post_call_poll_max_wait_sec", 1200) or 1200)
    content_grace = int(getattr(settings, "post_call_content_grace_sec", 45) or 45)

    try:
        async with _watch_semaphore():
            with ops_store.tenant_scope(tid):
                elapsed = 0.0
                finished_at: float | None = None
                last: dict[str, Any] | None = None
                while elapsed <= max_wait:
                    if _already_done(cid):
                        return ops_store.get_post_call_by_conversation(cid)
                    last = await fetch_conversation(cid)
                    if last is not None and conversation_is_finished(last):
                        if finished_at is None:
                            finished_at = elapsed
                        if conversation_has_usable_content(last) or (
                            finished_at is not None and (elapsed - finished_at) >= content_grace
                        ):
                            return await _process(
                                cid, last, dispatch_id, phone, first_name, flow, tid
                            )
                    await asyncio.sleep(interval)
                    elapsed += interval
                if last and conversation_is_finished(last):
                    return await _process(cid, last, dispatch_id, phone, first_name, flow, tid)
                logger.warning("post_call_watcher_timeout conversation_id=%s", cid)
                return None
    except Exception:
        logger.exception("post_call_watcher_failed conversation_id=%s", cid)
        return None
    finally:
        await _release_watch(cid)


async def _process(
    conversation_id: str,
    conv: dict[str, Any],
    dispatch_id: str | None,
    phone: str | None,
    first_name: str | None,
    flow: str | None,
    tenant_id: str,
) -> dict[str, Any]:
    payload = {
        "type": "post_call_transcription",
        "conversation_id": conversation_id,
        "data": {
            **conv,
            "conversation_id": conv.get("conversation_id") or conversation_id,
        },
    }
    result = await post_call_service.process(
        phone=phone,
        first_name=first_name or "Asociado",
        flow=flow,
        conversation_id=conversation_id,
        dispatch_id=dispatch_id,
        raw_payload=payload,
        source="elevenlabs_poller",
        tenant_id=tenant_id,
    )
    if result.get("in_flight"):
        # Webhook ganó la carrera: esperar a que termine el claim.
        with ops_store.tenant_scope(tenant_id):
            for _ in range(24):
                await asyncio.sleep(2.5)
                prior = ops_store.get_post_call_by_conversation(conversation_id)
                if prior and str(prior.get("status") or "") == "completed":
                    return prior
        return result
    if result.get("ok") is False and result.get("retryable"):
        await asyncio.sleep(3.0)
        result = await post_call_service.process(
            phone=phone,
            first_name=first_name or "Asociado",
            flow=flow,
            conversation_id=conversation_id,
            dispatch_id=dispatch_id,
            raw_payload=payload,
            source="elevenlabs_poller",
            tenant_id=tenant_id,
        )
    logger.info(
        "post_call_watcher_done conversation_id=%s ok=%s whatsapp_sent=%s intent=%s",
        conversation_id,
        result.get("ok"),
        result.get("whatsapp_sent"),
        result.get("intent"),
    )
    return result


def schedule_watch(
    conversation_id: str,
    *,
    dispatch_id: str | None = None,
    phone: str | None = None,
    first_name: str | None = None,
    flow: str | None = None,
    tenant_id: str | None = None,
) -> None:
    """Fire-and-forget watch from the request path (dispatch)."""
    cid = (conversation_id or "").strip()
    if not cid:
        return
    settings = get_settings()
    if not bool(getattr(settings, "post_call_poller_enabled", True)):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(
        watch_conversation(
            cid,
            dispatch_id=dispatch_id,
            phone=phone,
            first_name=first_name,
            flow=flow,
            tenant_id=tenant_id,
        ),
        name=f"postcall-watch-{cid[:24]}",
    )
    _watch_tasks.add(task)
    task.add_done_callback(_watch_tasks.discard)


async def sweep_pending_dispatches() -> int:
    """Catch SIP dispatches that ended without webhook / without an active watch."""
    settings = get_settings()
    if not bool(getattr(settings, "post_call_poller_enabled", True)):
        return 0
    started = 0
    # Sweep each known tenant from recent dispatches (unscoped scan).
    init = ops_store.db_path()
    if not init.exists():
        return 0
    import sqlite3

    conn = sqlite3.connect(str(init))
    conn.row_factory = sqlite3.Row
    try:
        tenants = [
            str(r["tenant_id"])
            for r in conn.execute(
                "SELECT DISTINCT tenant_id FROM dispatches ORDER BY tenant_id"
            ).fetchall()
        ]
    finally:
        conn.close()
    for tid in tenants:
        with ops_store.tenant_scope(tid):
            offset = 0
            page = 40
            while True:
                batch = ops_store.list_dispatches(page, offset=offset)
                if not batch:
                    break
                for d in batch:
                    if str(d.get("mode") or "") != "elevenlabs_sip":
                        continue
                    if str(d.get("status") or "") == "failed":
                        continue
                    cid = str(d.get("conversation_id") or "").strip()
                    if not cid or _already_done(cid):
                        continue
                    raw_lead = d.get("lead")
                    lead = raw_lead if isinstance(raw_lead, dict) else {}
                    schedule_watch(
                        cid,
                        dispatch_id=str(d.get("id") or "") or None,
                        phone=str(lead.get("phone") or "") or None,
                        first_name=str(lead.get("first_name") or "") or None,
                        flow=str(d.get("flow") or "") or None,
                        tenant_id=tid,
                    )
                    started += 1
                if len(batch) < page:
                    break
                offset += page
    return started


async def _sweep_loop() -> None:
    settings = get_settings()
    interval = float(getattr(settings, "post_call_sweep_interval_sec", 20.0) or 20.0)
    while True:
        try:
            await sweep_pending_dispatches()
        except Exception:
            logger.exception("post_call_sweep_failed")
        await asyncio.sleep(interval)


async def start_background() -> None:
    global _sweep_task
    settings = get_settings()
    if not bool(getattr(settings, "post_call_poller_enabled", True)):
        return
    if _sweep_task and not _sweep_task.done():
        return
    _sweep_task = asyncio.create_task(_sweep_loop(), name="postcall-sweep")
    logger.info("post_call_poller_started")


async def stop_background() -> None:
    global _sweep_task
    task = _sweep_task
    _sweep_task = None
    if task is not None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    # AUD-017: cancel and await in-flight watches on shutdown.
    pending = list(_watch_tasks)
    for t in pending:
        t.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    _watch_tasks.clear()
