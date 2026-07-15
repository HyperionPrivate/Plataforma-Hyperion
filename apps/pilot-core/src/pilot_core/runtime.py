from __future__ import annotations

from platform_kit.db import create_engine, create_session_factory
from platform_kit.events.consumer import EventWorker
from platform_kit.events.handlers import architecture_effect
from platform_kit.events.redis_streams import RedisStreamsTransport
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from pilot_core.settings import Settings

engine: AsyncEngine | None = None
session_factory: async_sessionmaker[AsyncSession] | None = None
redis: Redis | None = None
transport: RedisStreamsTransport | None = None
worker: EventWorker | None = None


async def startup(settings: Settings) -> None:
    global engine, session_factory, redis, transport, worker
    engine = create_engine(settings)
    session_factory = create_session_factory(engine)
    redis = Redis.from_url(settings.redis_url.get_secret_value(), decode_responses=False)
    transport = RedisStreamsTransport(redis, settings)
    try:
        await transport.ensure_group()
    except Exception:
        # Dev/demo: allow Ops API to boot without Redis Streams ready.
        if settings.app_env not in ("development", "test"):
            raise
        transport = None
    if settings.event_workers_enabled and transport is not None and session_factory is not None:
        worker = EventWorker(
            factory=session_factory,
            transport=transport,
            settings=settings,
            consumer_name=f"{settings.service_name}-worker",
            effect=architecture_effect,
        )
        worker.start()


async def shutdown() -> None:
    global engine, session_factory, redis, transport, worker
    if worker is not None:
        await worker.stop()
    if redis is not None:
        await redis.aclose()
    if engine is not None:
        await engine.dispose()
    engine = None
    session_factory = None
    redis = None
    transport = None
    worker = None


def get_engine() -> AsyncEngine | None:
    return engine


async def redis_ping() -> bool:
    if redis is None:
        return False
    return bool(await redis.ping())
