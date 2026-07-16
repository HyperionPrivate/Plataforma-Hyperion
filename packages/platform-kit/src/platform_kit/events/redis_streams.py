from __future__ import annotations

from dataclasses import dataclass, field

from platform_kit.events.envelope import EventEnvelope, validate_event_size
from platform_kit.settings import PlatformSettings

# Re-export for consumers that validate after parse.


def _as_str(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _field_map(fields: dict[object, object]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in fields.items():
        out[_as_str(key)] = _as_str(value)
    return out


@dataclass(frozen=True)
class StreamMessage:
    message_id: str
    envelope: EventEnvelope | None
    raw_fields: dict[str, str] = field(default_factory=dict)
    delivery_count: int = 1
    parse_error: str | None = None


class RedisStreamsTransport:
    """Redis Streams transport — replaceable behind EventTransport protocol."""

    def __init__(self, redis: object, settings: PlatformSettings) -> None:
        self._redis = redis  # redis.asyncio.Redis
        self._settings = settings
        self._acks_since_trim = 0

    @property
    def _attempts_key(self) -> str:
        return f"{self._settings.redis_stream_key}:delivery_attempts"

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
        kwargs: dict[str, object] = {}
        # Avoid MAXLEN on the primary stream: approximate trim can drop unacked
        # pending entries. Retention is operational (XTRIM MINID of ACK'd ids).
        if self._settings.redis_stream_maxlen > 0 and self._settings.redis_allow_maxlen_trim:
            kwargs["maxlen"] = self._settings.redis_stream_maxlen
            kwargs["approximate"] = True
        msg_id = await self._redis.xadd(  # type: ignore[attr-defined]
            self._settings.redis_stream_key,
            envelope.as_redis_fields(),
            **kwargs,
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
        messages = await self.read_group_messages(
            group=group, consumer=consumer, count=count, block_ms=block_ms
        )
        return [(m.message_id, m.envelope) for m in messages if m.envelope is not None]

    async def read_group_messages(
        self,
        *,
        group: str,
        consumer: str,
        count: int = 10,
        block_ms: int = 1000,
    ) -> list[StreamMessage]:
        rows = await self._redis.xreadgroup(  # type: ignore[attr-defined]
            group,
            consumer,
            streams={self._settings.redis_stream_key: ">"},
            count=count,
            block=block_ms,
        )
        return await self._parse_stream_rows(rows, default_delivery_count=1)

    async def autoclaim(
        self,
        *,
        group: str,
        consumer: str,
        min_idle_ms: int,
        count: int = 10,
    ) -> list[StreamMessage]:
        """Reclaim idle pending messages after a crash (XAUTOCLAIM)."""
        result = await self._redis.xautoclaim(  # type: ignore[attr-defined]
            self._settings.redis_stream_key,
            group,
            consumer,
            min_idle_ms,
            "0-0",
            count=count,
        )
        messages = result[1] if isinstance(result, (list, tuple)) and len(result) >= 2 else []
        out: list[StreamMessage] = []
        for message_id, fields in messages:
            mid = _as_str(message_id)
            delivery = await self._delivery_count(group, mid)
            out.append(self._message_from_fields(mid, fields, delivery_count=delivery))
        return out

    async def incr_delivery_attempts(self, message_id: str) -> int:
        """Durable attempt counter (survives consume_batch / process restarts)."""
        return int(
            await self._redis.hincrby(self._attempts_key, _as_str(message_id), 1)  # type: ignore[attr-defined]
        )

    async def clear_delivery_attempts(self, message_id: str) -> None:
        await self._redis.hdel(self._attempts_key, _as_str(message_id))  # type: ignore[attr-defined]

    async def ack(self, group: str, message_id: str) -> None:
        await self._redis.xack(  # type: ignore[attr-defined]
            self._settings.redis_stream_key, group, _as_str(message_id)
        )
        self._acks_since_trim += 1
        every = int(getattr(self._settings, "redis_trim_every_n_acks", 32) or 32)
        if (
            getattr(self._settings, "redis_trim_acked", True)
            and every > 0
            and self._acks_since_trim >= every
        ):
            self._acks_since_trim = 0
            await self.trim_acked(group)

    async def trim_acked(self, group: str) -> int:
        """AUD-013: drop entries older than the oldest pending ID (never pending).

        If the PEL is empty, trim exclusively below the stream's last entry so
        ACKed history does not grow without bound while leaving the tip intact.
        """
        stream = self._settings.redis_stream_key
        try:
            pending = await self._redis.xpending(stream, group)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            return 0
        min_id: str | None = None
        if isinstance(pending, (list, tuple)) and len(pending) >= 2 and pending[0]:
            raw_min = pending[1]
            if raw_min is not None:
                min_id = _as_str(raw_min)
        if not min_id:
            try:
                rows = await self._redis.xrevrange(stream, count=1)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                return 0
            if not rows:
                return 0
            tip = _as_str(rows[0][0] if isinstance(rows[0], (list, tuple)) else rows[0])
            # Exclusive MINID keeps the tip; drops everything older (all ACKed).
            min_id = f"({tip}"
        try:
            removed = await self._redis.xtrim(  # type: ignore[attr-defined]
                stream, minid=min_id, approximate=True
            )
            return int(removed or 0)
        except Exception:  # noqa: BLE001
            return 0

    async def dead_letter(self, envelope: EventEnvelope, *, reason: str) -> None:
        payload = envelope.as_redis_fields()
        payload["dlq_reason"] = reason
        await self._xadd_dlq(payload)

    async def dead_letter_raw(self, fields: dict[str, str], *, reason: str) -> None:
        payload = dict(fields)
        payload["dlq_reason"] = reason
        await self._xadd_dlq(payload)

    async def ping(self) -> bool:
        return bool(await self._redis.ping())  # type: ignore[attr-defined]

    async def _xadd_dlq(self, payload: dict[str, str]) -> None:
        kwargs: dict[str, object] = {}
        if self._settings.redis_dlq_maxlen > 0:
            kwargs["maxlen"] = self._settings.redis_dlq_maxlen
            kwargs["approximate"] = True
        await self._redis.xadd(self._settings.redis_dlq_stream_key, payload, **kwargs)  # type: ignore[attr-defined]

    async def _delivery_count(self, group: str, message_id: str) -> int:
        stored = await self._redis.hget(self._attempts_key, message_id)  # type: ignore[attr-defined]
        if stored is not None:
            return int(_as_str(stored))
        try:
            rows = await self._redis.xpending_range(  # type: ignore[attr-defined]
                self._settings.redis_stream_key,
                group,
                min=message_id,
                max=message_id,
                count=1,
            )
            if rows:
                entry = rows[0]
                if isinstance(entry, dict):
                    return int(entry.get("times_delivered") or entry.get("delivery_count") or 1)
                if isinstance(entry, (list, tuple)) and len(entry) >= 4:
                    return int(entry[3])
        except Exception:  # noqa: BLE001
            pass
        return 1

    async def _parse_stream_rows(
        self, rows: object, *, default_delivery_count: int
    ) -> list[StreamMessage]:
        out: list[StreamMessage] = []
        if not rows:
            return out
        assert isinstance(rows, (list, tuple))
        for _stream, messages in rows:
            for message_id, fields in messages:
                mid = _as_str(message_id)
                attempts = await self._redis.hget(self._attempts_key, mid)  # type: ignore[attr-defined]
                delivery = (
                    int(_as_str(attempts)) if attempts is not None else default_delivery_count
                )
                out.append(self._message_from_fields(mid, fields, delivery_count=delivery))
        return out

    def _message_from_fields(
        self, message_id: str, fields: object, *, delivery_count: int
    ) -> StreamMessage:
        if not isinstance(fields, dict):
            return StreamMessage(
                message_id=message_id,
                envelope=None,
                raw_fields={},
                delivery_count=delivery_count,
                parse_error="fields_not_dict",
            )
        mapped = _field_map(fields)
        raw = mapped.get("envelope")
        if raw is None:
            return StreamMessage(
                message_id=message_id,
                envelope=None,
                raw_fields=mapped,
                delivery_count=delivery_count,
                parse_error="missing_envelope",
            )
        try:
            envelope = EventEnvelope.from_json(raw)
            # AUD-029: reject oversized envelopes on consume, not only publish.
            validate_event_size(envelope)
        except Exception as exc:  # noqa: BLE001
            return StreamMessage(
                message_id=message_id,
                envelope=None,
                raw_fields=mapped,
                delivery_count=delivery_count,
                parse_error=f"parse_error:{type(exc).__name__}",
            )
        return StreamMessage(
            message_id=message_id,
            envelope=envelope,
            raw_fields=mapped,
            delivery_count=delivery_count,
        )
