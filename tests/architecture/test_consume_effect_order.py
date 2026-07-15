from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from platform_kit.db import Base
from platform_kit.events.consumer import consume_batch
from platform_kit.events.envelope import build_synthetic_ping
from platform_kit.events.redis_streams import StreamMessage
from platform_kit.settings import PlatformSettings
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


class _Transport:
    def __init__(self, messages: list[StreamMessage]) -> None:
        self._messages = messages
        self.acked: list[str] = []

    async def read_group(self, **kwargs):  # noqa: ANN003
        return []

    async def read_group_messages(self, **kwargs):  # noqa: ANN003
        out, self._messages = self._messages, []
        return out

    async def ack(self, group: str, message_id: str) -> None:
        self.acked.append(message_id)

    async def dead_letter(self, envelope, *, reason: str) -> None:  # noqa: ANN001
        return None

    async def ping(self) -> bool:
        return True


@pytest.mark.asyncio
async def test_redelivery_skips_effect_when_inbox_exists() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    settings = PlatformSettings(
        service_name="pilot-core",
        app_env="test",
        auth_disabled=True,
        event_max_retries=3,
        redis_consumer_group="g",
    )
    envelope = build_synthetic_ping(
        producer="pilot-core",
        tenant_id="t1",
        correlation_id="c1",
        marker="idem-effect",
    )
    effect = AsyncMock()
    transport = _Transport(
        [
            StreamMessage(message_id="1-0", envelope=envelope, delivery_count=1),
            StreamMessage(message_id="1-0", envelope=envelope, delivery_count=2),
        ]
    )

    stats = await consume_batch(
        factory,
        transport,  # type: ignore[arg-type]
        settings,
        consumer_name="c1",
        count=10,
        block_ms=1,
        effect=effect,
    )
    assert stats.applied == 1
    assert stats.duplicates == 1
    assert effect.await_count == 1  # second delivery must not re-run effect
    assert transport.acked == ["1-0", "1-0"]
    await engine.dispose()
