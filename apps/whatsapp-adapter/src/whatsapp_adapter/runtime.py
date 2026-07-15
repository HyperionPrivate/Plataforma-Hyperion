from __future__ import annotations

from platform_kit.db import create_engine, create_session_factory
from platform_kit.events.redis_streams import RedisStreamsTransport
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from whatsapp_adapter.settings import Settings

engine: AsyncEngine | None = None
session_factory: async_sessionmaker[AsyncSession] | None = None
redis: Redis | None = None
transport: RedisStreamsTransport | None = None


async def startup(settings: Settings) -> None:
    global engine, session_factory, redis, transport
    engine = create_engine(settings)
    session_factory = create_session_factory(engine)
    redis = Redis.from_url(settings.redis_url.get_secret_value(), decode_responses=False)
    transport = RedisStreamsTransport(redis, settings)
    await transport.ensure_group()


async def shutdown() -> None:
    global engine, session_factory, redis, transport
    if redis is not None:
        await redis.aclose()
    if engine is not None:
        await engine.dispose()
    engine = None
    session_factory = None
    redis = None
    transport = None


def get_engine() -> AsyncEngine | None:
    return engine


async def redis_ping() -> bool:
    if redis is None:
        return False
    return bool(await redis.ping())
