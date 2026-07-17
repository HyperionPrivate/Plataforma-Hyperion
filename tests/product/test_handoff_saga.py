"""AUD-021 — handoff/E2E durable saga idempotency."""

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
    monkeypatch.setenv("POST_CALL_WHATSAPP_AUTO_SEND", "false")
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
            {"voz_enabled": True, "whatsapp_enabled": True, "ventana_8_20": False},
        )
    compliance_service.window_start = dt_time(0, 0)
    compliance_service.window_end = dt_time(23, 59)

    from pilot_core.main import app

    app.state.settings = get_settings()
    return TestClient(app)


def test_claim_saga_preserves_steps_on_reclaim(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()
    with ops_store.tenant_scope("tenant-dev"):
        claimed, saga = ops_store.claim_saga(
            "e2e",
            "saga-preserve-1",
            {"steps": {"voice": {"ok": True}, "whatsapp": {"ok": True}}},
        )
        assert claimed is True
        assert saga is not None
        saga["status"] = "failed"
        saga["error"] = "boom"
        ops_store.save_saga(saga)

        claimed2, resumed = ops_store.claim_saga(
            "e2e",
            "saga-preserve-1",
            {"steps": {}},
        )
        assert claimed2 is True
        assert resumed is not None
        steps = resumed.get("steps") or {}
        assert steps.get("voice", {}).get("ok") is True
        assert steps.get("whatsapp", {}).get("ok") is True


def test_handoff_fails_when_liwa_live_does_not_sync(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "liwa_mode", "real")
    monkeypatch.setattr(s, "liwa_api_token", "tok")

    async def _fail(**_kwargs: object) -> dict[str, object]:
        return {"ok": False, "error": "liwa_down", "synced": False}

    monkeypatch.setattr(
        "pilot_core.modules.liwa_whatsapp.liwa_whatsapp_service.handoff_to_agency",
        _fail,
    )
    r = client.post(
        "/ops/handoff",
        json={
            "name": "Ana",
            "segment": "Renovacion",
            "motivo": "Calificado",
            "phone": "+573001115588",
            "idempotency_key": "handoff-liwa-fail-1",
        },
    )
    assert r.status_code == 502
    get_settings.cache_clear()


def test_handoff_idempotent_on_replay(client: TestClient) -> None:
    body = {
        "name": "Ana",
        "segment": "Renovacion",
        "motivo": "Calificado",
        "phone": "+573001115566",
        "idempotency_key": "handoff-test-1",
    }
    first = client.post("/ops/handoff", json=body)
    assert first.status_code == 200
    hid1 = first.json().get("id")
    assert hid1

    second = client.post("/ops/handoff", json=body)
    assert second.status_code == 200
    assert second.json().get("idempotent") is True
    assert second.json().get("id") == hid1


def test_transfer_reuses_existing_conversation_thread(client: TestClient) -> None:
    """Transferir a asesor must not clone a new cv_* for the selected inbox row."""
    import pilot_core.ops_store as ops_store

    with ops_store.tenant_scope("tenant-dev"):
        ops_store.upsert_conversation_thread(
            {
                "id": "cv_573001119999",
                "name": "Pedro",
                "topic": "Llamada de voz",
                "snippet": "Original",
                "tags": ["Voz"],
                "botActive": True,
                "botPaused": False,
                "messages": [
                    {
                        "id": "m_orig",
                        "role": "bot",
                        "text": "Hola original",
                        "at": "ahora",
                    }
                ],
                "expediente": {"phone": "+573001119999", "estadoCrm": "Contactado"},
            }
        )

    body = {
        "name": "Pedro",
        "segment": "Llamada de voz",
        "motivo": "Transferido desde Conversaciones",
        "phone": "+573001119999",
        "conversation_id": "cv_573001119999",
        "idempotency_key": "handoff:cv_573001119999",
    }
    first = client.post("/ops/handoff", json=body)
    assert first.status_code == 200
    payload = first.json()
    assert payload.get("conversationId") == "cv_573001119999"
    hid = payload.get("id")
    assert hid

    second = client.post("/ops/handoff", json=body)
    assert second.status_code == 200
    assert second.json().get("idempotent") is True
    assert second.json().get("id") == hid

    with ops_store.tenant_scope("tenant-dev"):
        threads = ops_store.list_conversation_threads()
        matching = [t for t in threads if t.get("id") == "cv_573001119999"]
        assert len(matching) == 1
        assert matching[0].get("botPaused") is True
        assert "Handoff" in (matching[0].get("tags") or [])
        # No orphan clone with the transfer motivo as a brand-new id.
        clones = [
            t
            for t in threads
            if t.get("id") != "cv_573001119999"
            and (t.get("snippet") or "") == "Transferido desde Conversaciones"
        ]
        assert clones == []

        queue = ops_store.list_handoffs(20, queued_only=True)
        linked = [
            h
            for h in queue
            if (h.get("conversationId") or h.get("conversation_id")) == "cv_573001119999"
        ]
        assert len(linked) == 1

    claim = client.post(
        "/ops/conversations/claim",
        json={"conversation_id": "cv_573001119999", "advisor": "Admin"},
    )
    assert claim.status_code == 200
    assert claim.json().get("handoffs_claimed", 0) >= 1

    listed = client.get("/ops/handoff")
    assert listed.status_code == 200
    queue_ids = [row.get("id") for row in (listed.json().get("queue") or [])]
    assert hid not in queue_ids


def test_transfer_reuses_queued_handoff_from_liwa_bridge(client: TestClient) -> None:
    import pilot_core.ops_store as ops_store

    with ops_store.tenant_scope("tenant-dev"):
        ops_store.upsert_conversation_thread(
            {
                "id": "cv_573001118888",
                "name": "Lucia",
                "topic": "WhatsApp",
                "snippet": "Live chat",
                "tags": ["WhatsApp", "Handoff", "RENOVACION_PIEDE_25062026"],
                "botActive": False,
                "botPaused": True,
                "expediente": {"phone": "+573001118888"},
            }
        )
        ops_store.insert_handoff(
            {
                "id": "ho_liwa_pre",
                "name": "Lucia",
                "segment": "WhatsApp",
                "motivo": "Live chat LIWA · Piedecuesta",
                "priority": "alta",
                "phone": "+573001118888",
                "conversation_id": "cv_573001118888",
                "status": "queued",
                "source": "liwa_bridge_poll",
            }
        )

    r = client.post(
        "/ops/handoff",
        json={
            "name": "Lucia",
            "segment": "WhatsApp",
            "motivo": "Transferido desde Conversaciones",
            "phone": "+573001118888",
            "conversation_id": "cv_573001118888",
            "idempotency_key": "handoff:cv_573001118888",
        },
    )
    assert r.status_code == 200
    assert r.json().get("id") == "ho_liwa_pre"
    assert r.json().get("conversationId") == "cv_573001118888"

    with ops_store.tenant_scope("tenant-dev"):
        queued = ops_store.list_handoffs(20, queued_only=True)
        linked = [
            h
            for h in queued
            if (h.get("conversationId") or h.get("conversation_id")) == "cv_573001118888"
        ]
        assert len(linked) == 1
        assert linked[0]["id"] == "ho_liwa_pre"


def test_e2e_idempotent_skips_rerun(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"voice": 0}

    async def _voice(**_kwargs):
        calls["voice"] += 1
        return {"ok": True, "mode": "mock"}

    monkeypatch.setattr(
        "pilot_core.modules.orchestration.service.orchestration_service.attempt_call",
        _voice,
    )
    body = {
        "phone": "+573001115577",
        "first_name": "Ana",
        "flow": "A",
        "skip_voice": False,
        "skip_whatsapp": True,
        "idempotency_key": "e2e-test-1",
    }
    first = client.post("/ops/e2e/campaign", json=body)
    assert first.status_code == 200
    assert first.json().get("saga_id")
    assert calls["voice"] == 1

    second = client.post("/ops/e2e/campaign", json=body)
    assert second.status_code == 200
    assert second.json().get("idempotent") is True
    assert calls["voice"] == 1
