from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from platform_kit.db import session_scope
from platform_kit.events.envelope import EventEnvelope
from platform_kit.events.outbox_inbox import (
    RelayStats,
    process_inbox_once,
    publish_pending_outbox,
)
from platform_kit.events.redis_streams import StreamMessage
from platform_kit.events.transport import EventTransport
from platform_kit.settings import PlatformSettings

logger = logging.getLogger(__name__)

EffectHandler = Callable[[AsyncSession, EventEnvelope], Awaitable[None]]


@dataclass
class ConsumeStats:
    applied: int = 0
    duplicates: int = 0
    dead_lettered: int = 0
    reclaimed: int = 0
    failed: int = 0
    malformed: int = 0


async def relay_outbox(
    factory: async_sessionmaker[AsyncSession],
    transport: EventTransport,
    settings: PlatformSettings,
    *,
    limit: int = 50,
) -> RelayStats:
    """Publish committed pending outbox rows; poison rows do not block the batch."""
    async with session_scope(factory) as session:
        return await publish_pending_outbox(
            session,
            transport,
            limit=limit,
            max_attempts=settings.event_max_retries,
        )


async def consume_batch(
    factory: async_sessionmaker[AsyncSession],
    transport: EventTransport,
    settings: PlatformSettings,
    *,
    consumer_name: str,
    count: int = 10,
    block_ms: int = 200,
    effect: EffectHandler | None = None,
) -> ConsumeStats:
    """
    Correct ordering:
      process + inbox insert → commit → ACK
    Delivery attempts are durable in Redis (survive process restarts).
    Failures stay pending for XAUTOCLAIM; after max retries → DLQ + ACK.
    Malformed payloads go to DLQ immediately.
    """
    stats = ConsumeStats()
    group = settings.redis_consumer_group
    max_retries = settings.event_max_retries

    messages: list[StreamMessage] = []
    if hasattr(transport, "autoclaim"):
        reclaimed = await transport.autoclaim(  # type: ignore[attr-defined]
            group=group,
            consumer=consumer_name,
            min_idle_ms=settings.redis_claim_min_idle_ms,
            count=count,
        )
        stats.reclaimed = len(reclaimed)
        messages.extend(list(reclaimed))  # type: ignore[arg-type]

    if hasattr(transport, "read_group_messages"):
        fresh = await transport.read_group_messages(  # type: ignore[attr-defined]
            group=group,
            consumer=consumer_name,
            count=count,
            block_ms=block_ms,
        )
    else:
        # Protocol fallback — envelope-only transports
        pairs = await transport.read_group(
            group=group,
            consumer=consumer_name,
            count=count,
            block_ms=block_ms,
        )
        fresh = [
            StreamMessage(message_id=mid, envelope=env, raw_fields={}, delivery_count=1)
            for mid, env in pairs
        ]
    messages.extend(fresh)

    for msg in messages:
        if msg.envelope is None:
            stats.malformed += 1
            await _dead_letter_raw(transport, msg, reason=msg.parse_error or "malformed")
            await transport.ack(group, msg.message_id)
            if hasattr(transport, "clear_delivery_attempts"):
                await transport.clear_delivery_attempts(msg.message_id)  # type: ignore[attr-defined]
            continue

        try:
            if effect is None:
                raise RuntimeError("consume_batch requires an effect handler")
            async with session_scope(factory) as session:
                # Effect first — failures leave the message pending (no inbox / no ACK).
                await effect(session, msg.envelope)
                applied = await process_inbox_once(session, msg.envelope)
            await transport.ack(group, msg.message_id)
            if hasattr(transport, "clear_delivery_attempts"):
                await transport.clear_delivery_attempts(msg.message_id)  # type: ignore[attr-defined]
            if applied:
                stats.applied += 1
            else:
                stats.duplicates += 1
        except Exception as exc:  # noqa: BLE001
            stats.failed += 1
            n = msg.delivery_count
            if hasattr(transport, "incr_delivery_attempts"):
                n = await transport.incr_delivery_attempts(msg.message_id)  # type: ignore[attr-defined]
            else:
                n = msg.delivery_count + 1
            logger.warning(
                "consume_failed message_id=%s attempt=%s error=%s",
                msg.message_id,
                n,
                type(exc).__name__,
            )
            if n >= max_retries:
                await transport.dead_letter(
                    msg.envelope, reason=f"max_retries:{type(exc).__name__}"
                )
                await transport.ack(group, msg.message_id)
                if hasattr(transport, "clear_delivery_attempts"):
                    await transport.clear_delivery_attempts(msg.message_id)  # type: ignore[attr-defined]
                stats.dead_lettered += 1
            else:
                backoff = settings.event_backoff_base_seconds * (2 ** max(0, n - 1))
                await asyncio.sleep(min(backoff, 30.0))

    return stats


async def _dead_letter_raw(transport: EventTransport, msg: StreamMessage, *, reason: str) -> None:
    if msg.envelope is not None:
        await transport.dead_letter(msg.envelope, reason=reason)
        return
    if hasattr(transport, "dead_letter_raw"):
        await transport.dead_letter_raw(msg.raw_fields, reason=reason)  # type: ignore[attr-defined]


@dataclass
class EventWorker:
    """Continuous relay + consumer loop (architecture foundation)."""

    factory: async_sessionmaker[AsyncSession]
    transport: EventTransport
    settings: PlatformSettings
    consumer_name: str
    effect: EffectHandler
    _stop: asyncio.Event = field(default_factory=asyncio.Event)
    _task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._loop(), name=f"event-worker-{self.consumer_name}")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=15.0)
            except TimeoutError:
                self._task.cancel()
            self._task = None

    async def _loop(self) -> None:
        poll = self.settings.worker_poll_seconds
        while not self._stop.is_set():
            try:
                await relay_outbox(self.factory, self.transport, self.settings)
                await consume_batch(
                    self.factory,
                    self.transport,
                    self.settings,
                    consumer_name=self.consumer_name,
                    count=self.settings.worker_batch_size,
                    block_ms=int(min(poll, 1.0) * 1000),
                    effect=self.effect,
                )
            except Exception:  # noqa: BLE001
                logger.exception("event_worker_iteration_failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=poll)
            except TimeoutError:
                continue
