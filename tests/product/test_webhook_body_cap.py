"""AUD-007 — webhook size cap + secret required outside local fail-open."""

from __future__ import annotations

from datetime import time as dt_time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("EVENT_WORKERS_ENABLED", "false")
    monkeypatch.setenv("ELEVENLABS_WEBHOOK_SECRET", "")
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()
    from pilot_core.modules.compliance.service import compliance_service

    with ops_store.tenant_scope("tenant-dev"):
        ops_store.set_setting("channels", {"ventana_8_20": False})
    compliance_service.window_start = dt_time(0, 0)
    compliance_service.window_end = dt_time(23, 59)

    from pilot_core.main import app

    app.state.settings = get_settings()
    return TestClient(app)


def test_oversized_webhook_rejected_before_process(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    called = {"n": 0}

    async def _boom(**_kwargs):
        called["n"] += 1
        return {"ok": True}

    monkeypatch.setattr(
        "pilot_core.modules.post_call.service.post_call_service.process",
        _boom,
    )
    huge = b"{" + (b"x" * (2 * 1024 * 1024 + 10)) + b"}"
    r = client.post(
        "/ops/webhooks/elevenlabs/post-call",
        content=huge,
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413
    assert called["n"] == 0


def test_staging_requires_webhook_secret(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pilot_core.settings import get_settings

    s = get_settings()
    monkeypatch.setattr(s, "app_env", "staging")
    monkeypatch.setattr(s, "auth_disabled", False)
    monkeypatch.setattr(s, "elevenlabs_webhook_secret", "")
    r = client.post(
        "/ops/webhooks/elevenlabs/post-call",
        json={"type": "post_call_transcription"},
    )
    assert r.status_code == 503


def test_valid_secret_verifies_before_json(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib
    import hmac
    import time

    from pilot_core.settings import get_settings

    secret = "whsec_test"
    s = get_settings()
    monkeypatch.setattr(s, "elevenlabs_webhook_secret", secret)
    monkeypatch.setattr(s, "auth_disabled", False)

    called = {"n": 0}

    async def _ok(**_kwargs):
        called["n"] += 1
        return {"ok": True, "status": "completed"}

    monkeypatch.setattr(
        "pilot_core.modules.post_call.service.post_call_service.process",
        _ok,
    )
    body = b'{"type":"post_call_transcription","data":{}}'
    ts = str(int(time.time()))
    digest = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    r = client.post(
        "/ops/webhooks/elevenlabs/post-call",
        content=body,
        headers={
            "content-type": "application/json",
            "elevenlabs-signature": f"t={ts},v0={digest}",
        },
    )
    assert r.status_code == 200
    assert called["n"] == 1
