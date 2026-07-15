from __future__ import annotations

from typing import Protocol

from platform_kit.events.envelope import EventEnvelope


class EventTransport(Protocol):
    async def publish(self, envelope: EventEnvelope) -> str:
        """Publish and return transport message id."""

    async def read_group(
        self,
        *,
        group: str,
        consumer: str,
        count: int = 10,
        block_ms: int = 1000,
    ) -> list[tuple[str, EventEnvelope]]: ...

    async def ack(self, group: str, message_id: str) -> None: ...

    async def dead_letter(self, envelope: EventEnvelope, *, reason: str) -> None: ...

    async def ping(self) -> bool: ...

    async def autoclaim(
        self,
        *,
        group: str,
        consumer: str,
        min_idle_ms: int,
        count: int = 10,
    ) -> list[tuple[str, EventEnvelope]]:
        """Optional; reclaim idle pending messages. Default transports may omit."""
        ...
