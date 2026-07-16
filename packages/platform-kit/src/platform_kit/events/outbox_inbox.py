from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from platform_kit.db import InboxEvent, OutboxEvent
from platform_kit.events.envelope import EventEnvelope
from platform_kit.events.transport import EventTransport


@dataclass
class RelayStats:
    published: int = 0
    failed: int = 0
    poisoned: int = 0


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
    max_attempts: int = 3,
) -> RelayStats:
    """
    Independent relay: claim pending rows (SKIP LOCKED when supported), publish, mark published.
    Poison / unparseable rows are marked failed and do not abort the batch.
    """
    stats = RelayStats()
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
    for row in rows:
        try:
            envelope = EventEnvelope.from_json(row.payload_json)
            await transport.publish(envelope)
            row.status = "published"
            row.published_at = datetime.now(UTC)
            row.attempts += 1
            row.last_error = None
            stats.published += 1
        except Exception as exc:  # noqa: BLE001 — isolate poison rows
            row.attempts += 1
            row.last_error = f"{type(exc).__name__}:{exc}"[:500]
            stats.failed += 1
            # AUD-012: transport/transient errors stay pending for replay after recovery.
            transient = isinstance(
                exc, (ConnectionError, TimeoutError, OSError)
            ) or type(exc).__name__ in {
                "ConnectionError",
                "TimeoutError",
                "RedisConnectionError",
                "ConnectionResetError",
                "BrokenPipeError",
            }
            if transient:
                row.status = "pending"
            elif row.attempts >= max_attempts:
                row.status = "failed"
                stats.poisoned += 1
            # else leave status=pending under max_attempts for retry
    return stats


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
