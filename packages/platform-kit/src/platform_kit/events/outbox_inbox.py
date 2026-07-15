from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from platform_kit.db import InboxEvent, OutboxEvent
from platform_kit.events.envelope import EventEnvelope
from platform_kit.events.transport import EventTransport


async def enqueue_outbox(session: AsyncSession, envelope: EventEnvelope) -> OutboxEvent:
    row = OutboxEvent(
        event_id=envelope.event_id,
        event_type=envelope.event_type,
        business_idempotency_key=envelope.business_idempotency_key,
        payload_json=envelope.to_json(),
        status="pending",
    )
    session.add(row)
    await session.flush()
    return row


async def publish_pending_outbox(
    session: AsyncSession,
    transport: EventTransport,
    *,
    limit: int = 50,
) -> int:
    result = await session.execute(
        select(OutboxEvent).where(OutboxEvent.status == "pending").limit(limit)
    )
    rows = list(result.scalars())
    published = 0
    for row in rows:
        envelope = EventEnvelope.from_json(row.payload_json)
        await transport.publish(envelope)
        row.status = "published"
        row.published_at = datetime.now(UTC)
        row.attempts += 1
        published += 1
    return published


async def process_inbox_once(
    session: AsyncSession,
    envelope: EventEnvelope,
    *,
    apply_effect: bool = True,
) -> bool:
    """
    Returns True if effect applied now, False if duplicate (already processed).
    Technical effect: insert inbox marker only — no commercial handlers.
    """
    existing = await session.execute(
        select(InboxEvent).where(InboxEvent.event_id == envelope.event_id)
    )
    if existing.scalar_one_or_none() is not None:
        return False
    # Also dedupe by business key for synthetic tests
    by_key = await session.execute(
        select(InboxEvent).where(
            InboxEvent.business_idempotency_key == envelope.business_idempotency_key
        )
    )
    if by_key.scalar_one_or_none() is not None:
        return False
    if apply_effect:
        session.add(
            InboxEvent(
                event_id=envelope.event_id,
                business_idempotency_key=envelope.business_idempotency_key,
                event_type=envelope.event_type,
                effect_marker="applied",
            )
        )
        await session.flush()
    return True
