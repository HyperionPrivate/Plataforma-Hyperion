from __future__ import annotations

import pytest
from platform_kit.events.envelope import build_synthetic_ping
from platform_kit.events.redis_streams import RedisStreamsTransport, StreamMessage, _as_str
from platform_kit.settings import PlatformSettings


def test_as_str_decodes_bytes() -> None:
    assert _as_str(b"1234567890-0") == "1234567890-0"
    assert _as_str("1234567890-0") == "1234567890-0"


class _FakeRedis:
    def __init__(self) -> None:
        self.acked: list[tuple] = []
        self.published: list[dict] = []
        self.attempts: dict[str, int] = {}
        self.dlq: list[dict] = []

    async def xgroup_create(self, *args, **kwargs):
        return True

    async def xadd(self, stream, fields, maxlen=None, approximate=None):
        if "dlq" in str(stream):
            self.dlq.append(fields)
        else:
            self.published.append(fields)
        return b"1700000000000-0"

    async def xreadgroup(self, group, consumer, streams=None, count=10, block=1000):
        env = build_synthetic_ping(
            producer="pilot-core",
            tenant_id="t1",
            correlation_id="c1",
            marker="m",
        )
        return [
            (
                b"stream",
                [
                    (
                        b"1700000000000-0",
                        {b"envelope": env.to_json().encode("utf-8")},
                    )
                ],
            )
        ]

    async def xack(self, stream, group, message_id):
        self.acked.append((stream, group, message_id))
        return 1

    async def xpending(self, stream, group):
        return [0, None, None, []]

    async def xrevrange(self, stream, max="+", min="-", count=1):
        return [(b"1700000000000-0", {})]

    async def xtrim(self, stream, minid=None, approximate=None):
        self.trimmed = getattr(self, "trimmed", [])
        self.trimmed.append({"stream": stream, "minid": minid, "approximate": approximate})
        return 3

    async def xautoclaim(self, *args, **kwargs):
        return (b"0-0", [])

    async def xpending_range(self, *args, **kwargs):
        return []

    async def hget(self, key, field):
        val = self.attempts.get(_as_str(field))
        return None if val is None else str(val).encode()

    async def hincrby(self, key, field, amount):
        k = _as_str(field)
        self.attempts[k] = self.attempts.get(k, 0) + int(amount)
        return self.attempts[k]

    async def hdel(self, key, field):
        self.attempts.pop(_as_str(field), None)
        return 1

    async def ping(self):
        return True


@pytest.mark.asyncio
async def test_redis_transport_acks_decoded_message_id() -> None:
    settings = PlatformSettings(
        service_name="pilot-core",
        app_env="test",
        auth_disabled=True,
        redis_stream_key="s",
        redis_consumer_group="g",
        redis_dlq_stream_key="dlq",
    )
    fake = _FakeRedis()
    transport = RedisStreamsTransport(fake, settings)
    rows = await transport.read_group(group="g", consumer="c1", count=1, block_ms=1)
    assert len(rows) == 1
    message_id, envelope = rows[0]
    assert message_id == "1700000000000-0"
    assert not message_id.startswith("b'")
    await transport.ack("g", message_id)
    assert fake.acked[0][2] == "1700000000000-0"
    published_id = await transport.publish(envelope)
    assert published_id == "1700000000000-0"


@pytest.mark.asyncio
async def test_malformed_message_parsed_as_stream_message() -> None:
    settings = PlatformSettings(
        service_name="pilot-core",
        app_env="test",
        auth_disabled=True,
        redis_stream_key="s",
        redis_consumer_group="g",
        redis_dlq_stream_key="dlq",
    )
    fake = _FakeRedis()

    async def bad_read(*args, **kwargs):
        return [(b"stream", [(b"1-0", {b"envelope": b"{not-json}"})])]

    fake.xreadgroup = bad_read  # type: ignore[method-assign]
    transport = RedisStreamsTransport(fake, settings)
    msgs = await transport.read_group_messages(group="g", consumer="c", count=1, block_ms=1)
    assert len(msgs) == 1
    assert isinstance(msgs[0], StreamMessage)
    assert msgs[0].envelope is None
    assert msgs[0].parse_error is not None


@pytest.mark.asyncio
async def test_ack_triggers_safe_minid_trim() -> None:
    settings = PlatformSettings(
        service_name="pilot-core",
        app_env="test",
        auth_disabled=True,
        redis_stream_key="s",
        redis_consumer_group="g",
        redis_dlq_stream_key="dlq",
        redis_trim_acked=True,
        redis_trim_every_n_acks=1,
    )
    fake = _FakeRedis()
    transport = RedisStreamsTransport(fake, settings)
    await transport.ack("g", "1700000000000-0")
    assert getattr(fake, "trimmed", [])
    assert str(fake.trimmed[0]["minid"]).startswith("(")


@pytest.mark.asyncio
async def test_durable_attempt_counter() -> None:
    settings = PlatformSettings(
        service_name="pilot-core",
        app_env="test",
        auth_disabled=True,
        redis_stream_key="s",
        redis_consumer_group="g",
        redis_dlq_stream_key="dlq",
    )
    fake = _FakeRedis()
    transport = RedisStreamsTransport(fake, settings)
    assert await transport.incr_delivery_attempts("1-0") == 1
    assert await transport.incr_delivery_attempts("1-0") == 2
    await transport.clear_delivery_attempts("1-0")
    assert fake.attempts.get("1-0") is None
