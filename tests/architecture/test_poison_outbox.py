from __future__ import annotations

import pytest
from platform_kit.db import Base, OutboxEvent
from platform_kit.events.envelope import build_synthetic_ping
from platform_kit.events.outbox_inbox import enqueue_outbox, publish_pending_outbox
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


class _FailThenOkTransport:
    def __init__(self) -> None:
        self.calls = 0
        self.published: list[str] = []

    async def publish(self, envelope):  # noqa: ANN001
        self.calls += 1
        if "poison" in envelope.payload.get("marker", ""):
            raise RuntimeError("poison")
        self.published.append(envelope.event_id)
        return "1-0"


@pytest.mark.asyncio
async def test_poison_outbox_row_does_not_block_batch() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    poison = build_synthetic_ping(
        producer="pilot-core",
        tenant_id="t1",
        correlation_id="c1",
        marker="poison",
    )
    good = build_synthetic_ping(
        producer="pilot-core",
        tenant_id="t1",
        correlation_id="c2",
        marker="ok",
    )

    async with factory() as session:
        await enqueue_outbox(session, poison)
        await enqueue_outbox(session, good)
        await session.commit()

    transport = _FailThenOkTransport()
    async with factory() as session:
        stats = await publish_pending_outbox(session, transport, max_attempts=2)
        await session.commit()

    assert stats.published == 1
    assert stats.failed == 1
    assert stats.poisoned == 0  # first failure keeps pending

    async with factory() as session:
        stats2 = await publish_pending_outbox(session, transport, max_attempts=2)
        await session.commit()

    assert stats2.poisoned == 1
    async with factory() as session:
        rows = (await session.execute(__import__("sqlalchemy").select(OutboxEvent))).scalars().all()
        by_marker = {
            __import__("json").loads(r.payload_json)["payload"]["marker"]: r.status for r in rows
        }
    assert by_marker["poison"] == "failed"
    assert by_marker["ok"] == "published"
    await engine.dispose()
