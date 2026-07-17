"""Conversaciones advisor reply: accepted_pending must not 502."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pilot_core import ops_store
from pilot_core.main import app
from pilot_core.modules.activity import conversation_id_for_phone
from pilot_core.settings import get_settings
from platform_kit.correlation import tenant_id_ctx


@pytest.fixture(autouse=True)
def _tenant(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("LIWA_MODE", "real")
    monkeypatch.setenv("LIWA_API_TOKEN", "test-token")
    monkeypatch.setenv("LIWA_WEBHOOK_SECRET", "test-secret")
    get_settings.cache_clear()
    token = tenant_id_ctx.set("tenant-dev")
    ops_store.init_db()
    yield
    tenant_id_ctx.reset(token)
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_send_text_accepted_pending_is_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    from pilot_core.modules import liwa_whatsapp as mod

    async def fake_post(*_a: Any, **_k: Any) -> Any:
        class R:
            status_code = 200
            is_success = True

            def json(self) -> dict[str, Any]:
                return {"status": "accepted"}  # no message_id → accepted_pending

        return R()

    class FakeClient:
        async def __aenter__(self) -> FakeClient:
            return self

        async def __aexit__(self, *_a: Any) -> None:
            return None

        post = fake_post

    monkeypatch.setattr(mod.httpx, "AsyncClient", lambda **_k: FakeClient())
    monkeypatch.setattr(
        mod.LiwaWhatsAppService,
        "ensure_contact",
        AsyncMock(return_value={"ok": True, "contact_id": "573001112233"}),
    )

    out = await mod.liwa_whatsapp_service.send_text(
        phone="+573001112233",
        text="Hola Carlos",
        first_name="Carlos",
    )
    assert out["ok"] is True
    assert out["message"]["status"] == "accepted_pending"


def test_conversations_messages_accepts_pending(monkeypatch: pytest.MonkeyPatch) -> None:
    phone = "+573001112233"
    cid = conversation_id_for_phone(phone)
    ops_store.upsert_conversation_thread(
        {
            "id": cid,
            "name": "Carlos",
            "channel": "whatsapp",
            "snippet": "test",
            "tags": ["WhatsApp"],
            "botActive": False,
            "botPaused": True,
            "expediente": {"phone": phone},
            "messages": [],
        }
    )
    ops_store.upsert_conversation_claim(
        {
            "id": cid,
            "advisor": "ops",
            "owner_subject": "dev",
            "status": "human_control",
        }
    )

    async def fake_send_text(**_k: Any) -> dict[str, Any]:
        return {
            "ok": True,
            "mock_commercial": False,
            "delivery": "accepted_pending",
            "message": {
                "id": "wa_test",
                "status": "accepted_pending",
                "receipt_id": None,
            },
        }

    monkeypatch.setattr(
        "pilot_core.routers.ops.liwa_whatsapp_service.send_text",
        fake_send_text,
    )
    # compliance allow
    monkeypatch.setattr(
        "pilot_core.routers.ops.compliance_service.evaluate",
        lambda **_k: type("D", (), {"allowed": True, "reasons": []})(),
    )

    client = TestClient(app)
    r = client.post(
        "/ops/conversations/messages",
        json={"conversation_id": cid, "text": "Hola Carlos!, Como estas?", "role": "advisor"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["delivery"] == "liwa_whatsapp"
    assert body["channel_acked"] is False
    msgs = ops_store.list_conversation_messages(cid)
    assert any("Hola Carlos" in str(m.get("text")) for m in msgs)
