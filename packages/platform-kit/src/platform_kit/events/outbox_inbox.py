from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from platform_kit.db import InboxEvent, OutboxEvent
from platform_kit.events.envelope import EventEnvelope
from platform_kit.events.transport import EventTransport


async def enqueue_outbox(session: AsyncSession, envelope: EventEnvelope) -> OutboxEvent:
    """Persist outbox row in the current business transaction. Do NOT publish here."""
    row = OutboxEvent(
        event_id=envelope.event_id,
        event_type=envelope.event_type,
        tenant_id=envelope.tenant_id,
        producer=envelope.producer,
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
    """
    Independent relay: claim pending rows (SKIP LOCKED when supported), publish, mark published.
    Must run in its own transaction AFTER the business+outbox commit.
    """
    dialect = session.bind.dialect.name if session.bind is not None else ""
    stmt = (
        select(OutboxEvent)
        .where(OutboxEvent.status == "pending")
        .order_by(OutboxEvent.created_at)
        .limit(limit)
    )
    if dialect == "postgresql":
        stmt = stmt.with_for_update(skip_locked=True)
    result = await session.execute(stmt)
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

    Uniqueness is (tenant_id, producer, event_type, business_idempotency_key)
    plus unique event_id. Concurrent workers rely on UNIQUE + IntegrityError.
    """
    if not apply_effect:
        return True

    existing = await session.execute(
        select(InboxEvent).where(InboxEvent.event_id == envelope.event_id)
    )
    if existing.scalar_one_or_none() is not None:
        return False
    by_key = await session.execute(
        select(InboxEvent).where(
            InboxEvent.tenant_id == envelope.tenant_id,
            InboxEvent.producer == envelope.producer,
            InboxEvent.event_type == envelope.event_type,
            InboxEvent.business_idempotency_key == envelope.business_idempotency_key,
        )
    )
    if by_key.scalar_one_or_none() is not None:
        return False

    try:
        async with session.begin_nested():
            session.add(
                InboxEvent(
                    event_id=envelope.event_id,
                    tenant_id=envelope.tenant_id,
                    producer=envelope.producer,
                    business_idempotency_key=envelope.business_idempotency_key,
                    event_type=envelope.event_type,
                    effect_marker="applied",
                )
            )
            await session.flush()
    except IntegrityError:
        return False
    return True
