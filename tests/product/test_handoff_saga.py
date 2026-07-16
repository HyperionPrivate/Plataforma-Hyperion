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
