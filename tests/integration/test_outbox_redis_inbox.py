from __future__ import annotations

import os

import pytest
import redis.asyncio as redis
from platform_kit.db import Base, create_engine, create_session_factory, session_scope
from platform_kit.events.consumer import consume_batch, relay_outbox
from platform_kit.events.envelope import build_synthetic_ping
from platform_kit.events.handlers import architecture_effect
from platform_kit.events.outbox_inbox import enqueue_outbox, process_inbox_once
from platform_kit.events.redis_streams import RedisStreamsTransport
from platform_kit.settings import PlatformSettings
from sqlalchemy import text


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_outbox_commit_then_relay_then_inbox_ack() -> None:
    db_url = _env(
        "DATABASE_URL",
        "postgresql+asyncpg://app_pilot_core:test_pilot@localhost:5432/db_pilot_core",
    )
    redis_url = _env("REDIS_URL", "redis://localhost:6379/0")
    settings = PlatformSettings(
        service_name="pilot-core",
        app_env="test",
        auth_disabled=True,
        database_url=db_url,
        redis_url=redis_url,
        redis_stream_key="coopfuturo.test.events",
        redis_consumer_group="test-group",
        redis_dlq_stream_key="coopfuturo.test.events.dlq",
        redis_claim_min_idle_ms=1000,
        event_max_retries=2,
    )

    engine = create_engine(settings)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
        # Simulate alembic_version for readiness semantics elsewhere
        await conn.execute(
            text("CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(32) PRIMARY KEY)")
        )
        await conn.execute(text("DELETE FROM alembic_version"))
        await conn.execute(
            text("INSERT INTO alembic_version(version_num) VALUES ('0001_technical')")
        )

    factory = create_session_factory(engine)
    client = redis.from_url(redis_url, decode_responses=False)
    transport = RedisStreamsTransport(client, settings)
    await client.delete(settings.redis_stream_key, settings.redis_dlq_stream_key)
    await transport.ensure_group()

    envelope = build_synthetic_ping(
        producer="pilot-core",
        tenant_id="tenant-a",
        correlation_id="corr-int-1",
        marker="integration-1",
    )

    async with session_scope(factory) as session:
        await enqueue_outbox(session, envelope)
    # Must not publish inside business txn — relay after commit
    relay_stats = await relay_outbox(factory, transport, settings)
    assert relay_stats.published == 1
    assert relay_stats.poisoned == 0

    stats = await consume_batch(
        factory,
        transport,
        settings,
        consumer_name="pilot-core-it",
        count=5,
        block_ms=500,
        effect=architecture_effect,
    )
    assert stats.applied == 1
    assert stats.failed == 0

    # Duplicate delivery should be idempotent
    async with session_scope(factory) as session:
        again = await process_inbox_once(session, envelope)
    assert again is False

    # Multi-tenant: same business key, different tenant → allowed
    other = build_synthetic_ping(
        producer="pilot-core",
        tenant_id="tenant-b",
        correlation_id="corr-int-2",
        marker="integration-other",
    ).model_copy(update={"business_idempotency_key": envelope.business_idempotency_key})
    async with session_scope(factory) as session:
        ok = await process_inbox_once(session, other)
    assert ok is True

    await client.aclose()
    await engine.dispose()
