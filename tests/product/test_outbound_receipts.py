"""AUD-015/016/019/020 — outbound receipts, intent neutrality, Flow B."""

from __future__ import annotations

from datetime import time as dt_time

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("EVENT_WORKERS_ENABLED", "false")
    monkeypatch.setenv("LIWA_MODE", "mock")
    monkeypatch.setenv("POST_CALL_WHATSAPP_AUTO_SEND", "true")
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()

    from pilot_core.modules.compliance.service import compliance_service

    with ops_store.tenant_scope("tenant-dev"):
        ops_store.set_setting(
            "channels",
            {
                "voz_enabled": True,
                "whatsapp_enabled": True,
                "ventana_8_20": False,
            },
        )
    compliance_service._suppressed_by_tenant.clear()
    compliance_service.window_start = dt_time(0, 0)
    compliance_service.window_end = dt_time(23, 59)

    from pilot_core.main import app

    app.state.settings = get_settings()
    return TestClient(app)


@pytest.mark.asyncio
async def test_elevenlabs_ok_requires_conversation_id(monkeypatch: pytest.MonkeyPatch) -> None:
    from pilot_core.modules import elevenlabs_outbound as el
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "elevenlabs_api_key", "test-key")
    monkeypatch.setattr(
        el,
        "resolve_flow",
        lambda flow="A": {
            "flow": "flujo_a",
            "agent_id": "agent_1",
            "agent_phone_number_id": "phone_1",
            "name": "A",
        },
    )

    class _Resp:
        is_success = True
        status_code = 200

        def json(self):
            return {"success": True}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            return _Resp()

    monkeypatch.setattr(el.httpx, "AsyncClient", lambda **kwargs: _Client())
    out = await el.place_sip_outbound(
        to_number="+573001110000",
        flow="A",
        lead={"phone": "+573001110000", "first_name": "Ana"},
    )
    assert out["ok"] is False
    assert out["error"] == "missing_conversation_id"
    get_settings.cache_clear()


def test_liwa_accepted_pending_is_not_whatsapp_sent(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    from pilot_core.modules.post_call.service import post_call_service
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "liwa_mode", "real")
    monkeypatch.setattr(s, "liwa_api_token", "tok")

    async def _no_receipt(**_kwargs: object) -> dict[str, object]:
        return {
            "ok": False,
            "delivery": "accepted_pending",
            "message": {"id": "local_1", "status": "accepted_pending", "receipt_id": None},
        }

    monkeypatch.setattr(
        "pilot_core.modules.liwa_whatsapp.liwa_whatsapp_service.send",
        _no_receipt,
    )

    result = asyncio.run(
        post_call_service.process(
            phone="+573001113344",
            intent="interesado",
            flow="A",
            conversation_id="conv_receipt_1",
            source="test",
        )
    )
    assert result.get("whatsapp_sent") is False
    assert result.get("whatsapp_status") == "accepted_pending"
    get_settings.cache_clear()


def test_call_successful_alone_is_unknown_intent() -> None:
    from pilot_core.modules.post_call.service import infer_intent_from_payload

    intent, source = infer_intent_from_payload(
        {
            "data": {
                "analysis": {
                    "call_successful": "success",
                    "transcript_summary": "Se contestó la llamada.",
                }
            }
        }
    )
    assert intent == "unknown"
    assert source == "default"


def test_flow_b_without_liwa_flow_is_not_runnable(monkeypatch: pytest.MonkeyPatch) -> None:
    from pilot_core.modules.product_flow import resolve_product_flow
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "liwa_flow_id_b", "")
    monkeypatch.setattr(s, "liwa_default_flow_id", "flow_a_default")

    monkeypatch.setattr(
        "pilot_core.modules.product_flow.agent_config_service.get",
        lambda: {
            "flujo_a": {"agent_id": "a1", "liwa_flow_id": "flow_a"},
            "flujo_b": {"agent_id": "b1"},
        },
    )
    product = resolve_product_flow("B")
    assert product["flow"] == "B"
    assert product["liwa_flow_id"] == ""
    assert product["whatsapp_runnable"] is False
    assert product["liwa_flow_fallback_to_a"] is False
    get_settings.cache_clear()


def test_mocks_fail_closed_outside_dev(monkeypatch: pytest.MonkeyPatch) -> None:
    from pilot_core.modules.whatsapp_mock import whatsapp_mock_service
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "app_env", "production")
    monkeypatch.setattr(s, "allow_mock_commercial", False)
    out = whatsapp_mock_service.send_text(phone="+573001110001", text="hola")
    assert out["ok"] is False
    assert out["error"] == "whatsapp_mock_disabled"
    get_settings.cache_clear()


def test_claim_lease_is_renewable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """AUD-014: processing claim with expired lease_until can be reclaimed."""
    import asyncio
    from datetime import UTC, datetime, timedelta

    import pilot_core.ops_store as ops_store
    from pilot_core.modules.post_call.service import post_call_service
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "post_call_claim_lease_sec", 120)
    monkeypatch.setattr(s, "liwa_mode", "real")
    monkeypatch.setattr(s, "liwa_api_token", "tok")

    async def _hang(**_kwargs: object) -> dict[str, object]:
        # Leave claim in processing via slow path: we seed the row instead.
        return {"ok": True, "delivery": "sent", "message": {"id": "x", "receipt_id": "x"}}

    monkeypatch.setattr(
        "pilot_core.modules.liwa_whatsapp.liwa_whatsapp_service.send",
        _hang,
    )

    with ops_store.tenant_scope("tenant-dev"):
        expired = (datetime.now(tz=UTC) - timedelta(seconds=5)).isoformat()
        ops_store.insert_post_call(
            {
                "id": "pc_stale",
                "conversation_id": "conv_lease_1",
                "phone": "+573001114455",
                "status": "processing",
                "lease_until": expired,
                "owner_id": "other",
            }
        )

    result = asyncio.run(
        post_call_service.process(
            phone="+573001114455",
            intent="interesado",
            flow="A",
            conversation_id="conv_lease_1",
            source="test",
        )
    )
    assert result.get("status") == "completed"
    assert result.get("whatsapp_sent") is True
    get_settings.cache_clear()
