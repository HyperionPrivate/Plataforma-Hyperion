from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import DateTime, Integer, MetaData, String, Text, UniqueConstraint, select, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from platform_kit.settings import PlatformSettings

NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


class OutboxEvent(Base):
    __tablename__ = "outbox_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    event_id: Mapped[str] = mapped_column(String(36), unique=True, nullable=False)
    event_type: Mapped[str] = mapped_column(String(128), nullable=False)
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    producer: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    business_idempotency_key: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class InboxEvent(Base):
    __tablename__ = "inbox_events"
    __table_args__ = (
        UniqueConstraint(
            "tenant_id",
            "producer",
            "event_type",
            "business_idempotency_key",
            name="uq_inbox_events_tenant_producer_type_bizkey",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    event_id: Mapped[str] = mapped_column(String(36), unique=True, nullable=False)
    tenant_id: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    producer: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    business_idempotency_key: Mapped[str] = mapped_column(String(256), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(128), nullable=False)
    processed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    effect_marker: Mapped[str] = mapped_column(String(128), nullable=False, default="applied")


class TechnicalProbe(Base):
    """Single-row technical table for backup/restore verification (no commercial data)."""

    __tablename__ = "technical_probe"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    marker: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


def create_engine(settings: PlatformSettings) -> AsyncEngine:
    url = settings.database_url.get_secret_value()
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    kwargs: dict[str, object] = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        # Unit/architecture tests only
        return create_async_engine(url, connect_args={"check_same_thread": False})
    kwargs["pool_size"] = settings.db_pool_size
    kwargs["pool_timeout"] = settings.db_pool_timeout_seconds
    return create_async_engine(url, **kwargs)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


@asynccontextmanager
async def session_scope(factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    session = factory()
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


async def check_database(engine: AsyncEngine) -> dict[str, Any]:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
        # Alembic version present after migrations
        try:
            result = await conn.execute(text("SELECT version_num FROM alembic_version LIMIT 1"))
            version = result.scalar()
        except Exception:
            version = None
    return {"ok": True, "alembic_version": version}


async def inbox_already_processed(session: AsyncSession, event_id: str) -> bool:
    result = await session.execute(select(InboxEvent).where(InboxEvent.event_id == event_id))
    return result.scalar_one_or_none() is not None
