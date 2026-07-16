"""AUD2-001/002/006/007 — anti double-WA, lease recovery, pending idempotency, webhook binding."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

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
    with ops_store.tenant_scope("tenant-dev"):
        ops_store.set_setting(
            "channels",
            {
                "voz_enabled": True,
                "whatsapp_enabled": True,
                "ventana_8_20": False,
            },
        )

    from pilot_core.main import app

    app.state.settings = get_settings()
    return TestClient(app)


def test_accepted_pending_completes_and_second_process_does_not_resend(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    from pilot_core.modules.post_call.service import post_call_service
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "liwa_mode", "real")
    monkeypatch.setattr(s, "liwa_api_token", "tok")

    calls = {"n": 0}

    async def _no_receipt(**_kwargs: object) -> dict[str, object]:
        calls["n"] += 1
        return {
            "ok": False,
            "delivery": "accepted_pending",
            "message": {"id": "local_1", "status": "accepted_pending", "receipt_id": None},
        }

    monkeypatch.setattr(
        "pilot_core.modules.liwa_whatsapp.liwa_whatsapp_service.send",
        _no_receipt,
    )

    first = asyncio.run(
        post_call_service.process(
            phone="+573001113344",
            intent="interesado",
            flow="A",
            conversation_id="conv_aud2_001",
            source="test",
        )
    )
    assert first.get("status") == "completed"
    assert first.get("ok") is True
    assert first.get("whatsapp_status") == "accepted_pending"
    assert first.get("whatsapp_sent") is False
    assert calls["n"] == 1

    second = asyncio.run(
        post_call_service.process(
            phone="+573001113344",
            intent="interesado",
            flow="A",
            conversation_id="conv_aud2_001",
            source="test",
        )
    )
    assert second.get("idempotent") is True or second.get("status") == "completed"
    assert calls["n"] == 1  # no second LIWA call
    get_settings.cache_clear()


def test_stale_recovery_respects_future_lease(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()
    future = (datetime.now(tz=UTC) + timedelta(hours=1)).isoformat()
    with ops_store.tenant_scope("tenant-dev"):
        ops_store.insert_post_call(
            {
                "id": "pc_lease_keep",
                "conversation_id": "conv_lease_keep",
                "phone": "+573001110001",
                "status": "processing",
                "lease_until": future,
            }
        )
    # Force recovery path as if created_at were old.
    conn = ops_store._connect()
    try:
        conn.execute(
            "UPDATE post_calls SET created_at=? WHERE id=?",
            ("2000-01-01 00:00:00", "pc_lease_keep"),
        )
        conn.commit()
        ops_store._recover_stale_post_call_claims(conn, max_age_sec=300)
        conn.commit()
        row = conn.execute("SELECT id FROM post_calls WHERE id=?", ("pc_lease_keep",)).fetchone()
        assert row is not None
    finally:
        conn.close()


def test_pending_send_idempotent(client: TestClient) -> None:
    client.post(
        "/ops/calls/complete",
        json={
            "phone": "+573005550200",
            "first_name": "Idem",
            "intent": "interesado",
            "flow": "A",
            "conversation_id": "conv_pend_idem",
            "skip_whatsapp": True,
        },
    )
    r1 = client.post(
        "/ops/whatsapp/pending/send",
        json={"conversation_id": "conv_pend_idem"},
    )
    assert r1.status_code == 200
    r2 = client.post(
        "/ops/whatsapp/pending/send",
        json={"conversation_id": "conv_pend_idem"},
    )
    assert r2.status_code == 200
    body = r2.json()
    assert body.get("idempotent") is True


def test_webhook_requires_conversation_id(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pilot_core.settings import get_settings

    monkeypatch.setenv("ELEVENLABS_WEBHOOK_SECRET", "")
    get_settings.cache_clear()
    r = client.post(
        "/ops/webhooks/elevenlabs/post-call",
        json={"type": "post_call_transcription", "data": {"analysis": {}}},
    )
    assert r.status_code == 422
    get_settings.cache_clear()


def test_webhook_phone_prefers_dispatch_store(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    import pilot_core.ops_store as ops_store
    from pilot_core.modules.post_call.service import post_call_service

    with ops_store.tenant_scope("tenant-dev"):
        ops_store.insert_dispatch(
            {
                "id": "orch_bind_1",
                "conversation_id": "conv_phone_bind",
                "mode": "elevenlabs_sip",
                "status": "sent",
                "lead": {"phone": "+573009998877", "first_name": "Store"},
                "flow": "A",
            }
        )

    seen: dict[str, str] = {}

    async def _capture(*, phone: str, **_kwargs: object) -> dict[str, object]:
        seen["phone"] = phone
        return {
            "ok": True,
            "delivery": "queued_mock",
            "message": {"status": "queued_mock"},
        }

    monkeypatch.setattr(
        "pilot_core.modules.liwa_whatsapp.liwa_whatsapp_service.send",
        _capture,
    )
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "liwa_mode", "real")
    monkeypatch.setattr(s, "liwa_api_token", "tok")

    result = asyncio.run(
        post_call_service.process(
            phone="+573001111111",  # misleading explicit — store must win with conv_id
            intent="interesado",
            flow="A",
            conversation_id="conv_phone_bind",
            source="elevenlabs_webhook",
            raw_payload={
                "data": {
                    "conversation_id": "conv_phone_bind",
                    "phone": "+573000000000",
                }
            },
        )
    )
    assert result.get("phone") == "+573009998877" or seen.get("phone") == "+573009998877"
    get_settings.cache_clear()
