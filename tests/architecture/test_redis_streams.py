from __future__ import annotations

import pytest
from platform_kit.events.envelope import build_synthetic_ping
from platform_kit.events.redis_streams import RedisStreamsTransport, _as_str
from platform_kit.settings import PlatformSettings


def test_as_str_decodes_bytes() -> None:
    assert _as_str(b"1234567890-0") == "1234567890-0"
    assert _as_str("1234567890-0") == "1234567890-0"


class _FakeRedis:
    def __init__(self) -> None:
        self.acked: list[tuple] = []
        self.published: list[dict] = []

    async def xgroup_create(self, *args, **kwargs):
        return True

    async def xadd(self, stream, fields, maxlen=None, approximate=None):
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

    async def xautoclaim(self, *args, **kwargs):
        return (b"0-0", [])

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
