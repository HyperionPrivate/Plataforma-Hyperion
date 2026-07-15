from __future__ import annotations

from platform_kit.events.envelope import EventEnvelope, validate_event_size
from platform_kit.settings import PlatformSettings


def _as_str(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _field_map(fields: dict[object, object]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in fields.items():
        out[_as_str(key)] = _as_str(value)
    return out


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
            maxlen=self._settings.redis_stream_maxlen,
            approximate=True,
        )
        return _as_str(msg_id)

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
        return self._parse_stream_rows(rows)

    async def autoclaim(
        self,
        *,
        group: str,
        consumer: str,
        min_idle_ms: int,
        count: int = 10,
    ) -> list[tuple[str, EventEnvelope]]:
        """Reclaim idle pending messages after a crash (XAUTOCLAIM)."""
        result = await self._redis.xautoclaim(  # type: ignore[attr-defined]
            self._settings.redis_stream_key,
            group,
            consumer,
            min_idle_ms,
            "0-0",
            count=count,
        )
        # redis-py returns (next_id, messages[, deleted])
        messages = result[1] if isinstance(result, (list, tuple)) and len(result) >= 2 else []
        out: list[tuple[str, EventEnvelope]] = []
        for message_id, fields in messages:
            parsed = self._envelope_from_fields(fields)
            if parsed is not None:
                out.append((_as_str(message_id), parsed))
        return out

    async def ack(self, group: str, message_id: str) -> None:
        await self._redis.xack(  # type: ignore[attr-defined]
            self._settings.redis_stream_key, group, _as_str(message_id)
        )

    async def dead_letter(self, envelope: EventEnvelope, *, reason: str) -> None:
        payload = envelope.as_redis_fields()
        payload["dlq_reason"] = reason
        await self._redis.xadd(  # type: ignore[attr-defined]
            self._settings.redis_dlq_stream_key,
            payload,
            maxlen=self._settings.redis_dlq_maxlen,
            approximate=True,
        )

    async def ping(self) -> bool:
        return bool(await self._redis.ping())  # type: ignore[attr-defined]

    def _parse_stream_rows(self, rows: object) -> list[tuple[str, EventEnvelope]]:
        out: list[tuple[str, EventEnvelope]] = []
        if not rows:
            return out
        assert isinstance(rows, (list, tuple))
        for _stream, messages in rows:
            for message_id, fields in messages:
                parsed = self._envelope_from_fields(fields)
                if parsed is not None:
                    out.append((_as_str(message_id), parsed))
        return out

    def _envelope_from_fields(self, fields: object) -> EventEnvelope | None:
        if not isinstance(fields, dict):
            return None
        mapped = _field_map(fields)
        raw = mapped.get("envelope")
        if raw is None:
            return None
        return EventEnvelope.from_json(raw)
