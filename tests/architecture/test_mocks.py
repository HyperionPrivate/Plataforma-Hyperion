from __future__ import annotations

import pytest
from platform_kit.mocks import MockDialerClient, MockWhatsAppProvider


@pytest.mark.asyncio
async def test_mock_dialer_never_needs_network() -> None:
    client = MockDialerClient(mode="success")
    result = await client.dispatch_call({"idempotency_key": "k1", "to": "+570000000000"})
    assert result["mock"] is True
    assert len(client.calls) == 1


@pytest.mark.asyncio
async def test_mock_whatsapp_failure_modes() -> None:
    client = MockWhatsAppProvider(mode="error")
    with pytest.raises(RuntimeError):
        await client.send_message({"to": "synth"})
