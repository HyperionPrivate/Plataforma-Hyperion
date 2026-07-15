from __future__ import annotations

import pytest
from platform_kit.db import Base
from platform_kit.events.envelope import build_synthetic_ping
from platform_kit.events.outbox_inbox import enqueue_outbox, process_inbox_once
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


@pytest.mark.asyncio
async def test_outbox_inbox_idempotent_effect() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    envelope = build_synthetic_ping(
        producer="pilot-core",
        tenant_id="tenant-synth",
        correlation_id="corr-1",
        marker="idem-1",
    )

    async with factory() as session:
        await enqueue_outbox(session, envelope)
        first = await process_inbox_once(session, envelope)
        second = await process_inbox_once(session, envelope)
        await session.commit()

    assert first is True
    assert second is False
    await engine.dispose()


def test_envelope_requires_business_key_distinct_concept() -> None:
    env = build_synthetic_ping(
        producer="pilot-core",
        tenant_id="t1",
        correlation_id="c1",
        marker="m1",
    )
    assert env.business_idempotency_key != env.event_id
    assert env.tenant_id == "t1"
    assert env.schema_version == "v1"
