from __future__ import annotations

from platform_kit.events.envelope import EventEnvelope, validate_event_size
from platform_kit.settings import PlatformSettings


class RedisStreamsTransport:
    """Redis Streams transport — replaceable behind EventTransport protocol."""

    def __init__(self, redis: object, settings: PlatformSettings) -> None:
        self._redis = redis  # redis.asyncio.Redis
        self._settings = settings

    async def ensure_group(self) -> None:
        try:
            await self._redis.xgroup_create(  # type: ignore[attr-defined]
                self._settings.redis_stream_key,
                self._settings.redis_consumer_group,
                id="0",
                mkstream=True,
            )
        except Exception as exc:  # noqa: BLE001 — BUSYGROUP is expected
            if "BUSYGROUP" not in str(exc):
                raise

    async def publish(self, envelope: EventEnvelope) -> str:
        validate_event_size(envelope)
        msg_id = await self._redis.xadd(  # type: ignore[attr-defined]
            self._settings.redis_stream_key,
            envelope.as_redis_fields(),
        )
        return str(msg_id)

    async def read_group(
        self,
        *,
        group: str,
        consumer: str,
        count: int = 10,
        block_ms: int = 1000,
    ) -> list[tuple[str, EventEnvelope]]:
        rows = await self._redis.xreadgroup(  # type: ignore[attr-defined]
            group,
            consumer,
            streams={self._settings.redis_stream_key: ">"},
            count=count,
            block=block_ms,
        )
        out: list[tuple[str, EventEnvelope]] = []
        if not rows:
            return out
        for _stream, messages in rows:
            for message_id, fields in messages:
                raw = fields.get(b"envelope") or fields.get("envelope")
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                out.append((str(message_id), EventEnvelope.from_json(raw)))
        return out

    async def ack(self, group: str, message_id: str) -> None:
        await self._redis.xack(self._settings.redis_stream_key, group, message_id)  # type: ignore[attr-defined]

    async def dead_letter(self, envelope: EventEnvelope, *, reason: str) -> None:
        payload = envelope.as_redis_fields()
        payload["dlq_reason"] = reason
        await self._redis.xadd(self._settings.redis_dlq_stream_key, payload)  # type: ignore[attr-defined]

    async def ping(self) -> bool:
        return bool(await self._redis.ping())  # type: ignore[attr-defined]
