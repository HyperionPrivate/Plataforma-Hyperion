"""Regression: post-call must honor compliance before WhatsApp."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("EVENT_WORKERS_ENABLED", "false")
    monkeypatch.setenv("LIWA_MODE", "mock")
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    # Fresh settings / storage singletons
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()

    from pilot_core.main import app

    return TestClient(app)


def test_post_call_blocks_whatsapp_on_opt_out(client: TestClient) -> None:
    phone = "+573009998877"
    r = client.post("/ops/compliance/opt-out", json={"phone": phone})
    assert r.status_code == 200

    r = client.post(
        "/ops/calls/complete",
        json={"phone": phone, "first_name": "Ana", "intent": "interesado", "flow": "A"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("whatsapp_sent") is False
    assert body.get("whatsapp", {}).get("blocked") is True
    assert "opt_out_suppressed" in (body.get("compliance") or {}).get("reasons", [])


def test_pilot_core_main_imports() -> None:
    import pilot_core.main as main

    assert main.app is not None
