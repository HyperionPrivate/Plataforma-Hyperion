from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from platform_kit.errors import PlatformError
from platform_kit.events.envelope import EventEnvelope

# Event types the architecture foundation may consume without a commercial handler.
_ARCHITECTURE_EVENT_TYPES = frozenset({"platform.synthetic.ping"})


async def architecture_effect(_session: AsyncSession, envelope: EventEnvelope) -> None:
    """
    Default worker effect for the foundation.

    Only technical synthetic events are allowed. Unknown types fail so the message
    is NOT ACKed as successfully handled (retry / DLQ path).
    """
    if envelope.event_type in _ARCHITECTURE_EVENT_TYPES:
        return
    raise PlatformError(
        "no_handler",
        f"No commercial handler registered for event_type={envelope.event_type}",
        status_code=500,
    )
