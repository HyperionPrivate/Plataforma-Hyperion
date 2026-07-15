"""Post-call review mode: interested lead + pending WhatsApp (no false 'sent')."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("EVENT_WORKERS_ENABLED", "false")
    monkeypatch.setenv("LIWA_MODE", "mock")
    monkeypatch.setenv("POST_CALL_WHATSAPP_AUTO_SEND", "false")
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))

    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()

    from pilot_core.main import app

    return TestClient(app)


def test_review_mode_marks_pending_not_sent(client: TestClient) -> None:
    r = client.post(
        "/ops/calls/complete",
        json={
            "phone": "+573005550123",
            "first_name": "Ana",
            "intent": "pedir_whatsapp",
            "flow": "A",
            "conversation_id": "conv_review_1",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("whatsapp_sent") is False
    assert body.get("whatsapp", {}).get("pending_review") is True
    assert body.get("wants_whatsapp") is True

    pend = client.get("/ops/whatsapp/pending").json()
    cids = {row["conversation_id"] for row in pend["items"]}
    assert "conv_review_1" in cids


def test_pending_skip_removes_from_queue(client: TestClient) -> None:
    client.post(
        "/ops/calls/complete",
        json={
            "phone": "+573005550124",
            "first_name": "Leo",
            "intent": "interesado",
            "flow": "A",
            "conversation_id": "conv_review_2",
        },
    )
    r = client.post("/ops/whatsapp/pending/skip", json={"conversation_id": "conv_review_2"})
    assert r.status_code == 200
    pend = client.get("/ops/whatsapp/pending").json()
    cids = {row["conversation_id"] for row in pend["items"]}
    assert "conv_review_2" not in cids
