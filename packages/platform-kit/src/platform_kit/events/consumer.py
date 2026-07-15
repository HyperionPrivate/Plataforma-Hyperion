from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from platform_kit.db import session_scope
from platform_kit.events.envelope import EventEnvelope
from platform_kit.events.outbox_inbox import process_inbox_once
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


async def relay_outbox(
    factory: async_sessionmaker[AsyncSession],
    transport: EventTransport,
    *,
    limit: int = 50,
) -> int:
    """Publish committed pending outbox rows in an independent transaction."""
    from platform_kit.events.outbox_inbox import publish_pending_outbox

    async with session_scope(factory) as session:
        return await publish_pending_outbox(session, transport, limit=limit)


async def consume_batch(
    factory: async_sessionmaker[AsyncSession],
    transport: EventTransport,
    settings: PlatformSettings,
    *,
    consumer_name: str,
    count: int = 10,
    block_ms: int = 200,
    attempt_counts: dict[str, int] | None = None,
    effect: EffectHandler | None = None,
) -> ConsumeStats:
    """
    Correct ordering:
      process + inbox insert → commit → ACK
    Failures stay pending for XAUTOCLAIM; after max retries → DLQ + ACK.
    """
    stats = ConsumeStats()
    attempts = attempt_counts if attempt_counts is not None else {}
    group = settings.redis_consumer_group
    max_retries = settings.event_max_retries

    # Reclaim abandoned deliveries first
    if hasattr(transport, "autoclaim"):
        reclaimed = await transport.autoclaim(  # type: ignore[attr-defined]
            group=group,
            consumer=consumer_name,
            min_idle_ms=settings.redis_claim_min_idle_ms,
            count=count,
        )
        stats.reclaimed = len(reclaimed)
    else:
        reclaimed = []

    fresh = await transport.read_group(
        group=group,
        consumer=consumer_name,
        count=count,
        block_ms=block_ms,
    )
    messages = list(reclaimed) + list(fresh)

    for message_id, envelope in messages:
        try:
            async with session_scope(factory) as session:
                applied = await process_inbox_once(session, envelope)
                if effect is not None and applied:
                    await effect(session, envelope)
            # Commit succeeded — safe to ACK
            await transport.ack(group, message_id)
            attempts.pop(message_id, None)
            if applied:
                stats.applied += 1
            else:
                stats.duplicates += 1
        except Exception as exc:  # noqa: BLE001
            stats.failed += 1
            n = attempts.get(message_id, 0) + 1
            attempts[message_id] = n
            logger.warning(
                "consume_failed",
                extra={"message_id": message_id, "attempt": n, "error": type(exc).__name__},
            )
            if n >= max_retries:
                await transport.dead_letter(envelope, reason=f"max_retries:{type(exc).__name__}")
                await transport.ack(group, message_id)
                attempts.pop(message_id, None)
                stats.dead_lettered += 1
            # else: leave pending for XAUTOCLAIM

    return stats
