"""Product regressions for audit findings 1–6 (partial)."""

from __future__ import annotations

import hashlib
import hmac
import time

import pytest
from fastapi.testclient import TestClient
from pilot_core.phone import normalize_phone


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("+573001234567", "+573001234567"),
        ("573001234567", "+573001234567"),
        ("+57 300 123 4567", "+573001234567"),
        ("3001234567", "+573001234567"),
        ("00573001234567", "+573001234567"),
        ("00 57 300 123 4567", "+573001234567"),
    ],
)
def test_normalize_phone(raw: str, expected: str) -> None:
    assert normalize_phone(raw) == expected


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("EVENT_WORKERS_ENABLED", "false")
    monkeypatch.setenv("LIWA_MODE", "mock")
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()

    from pilot_core.modules.compliance.service import compliance_service

    compliance_service.suppressed.clear()
    compliance_service._hydrated = False

    from pilot_core.main import app

    return TestClient(app)


def test_commit_imports_more_than_preview_limit(client: TestClient) -> None:
    rows = [
        {
            "phone": f"+57300{i:07d}",
            "first_name": f"C{i}",
            "segment": "Renovacion",
        }
        for i in range(250)
    ]
    preview = client.post("/ops/contacts/import", json={"rows": rows, "commit": False})
    assert preview.status_code == 200
    body = preview.json()
    assert body["valid"] == 250
    assert len(body["rows"]) == 200
    assert body.get("truncated") is True

    commit = client.post("/ops/contacts/import", json={"rows": rows, "commit": True})
    assert commit.status_code == 200
    assert commit.json()["committed"] == 250


def test_opt_out_matches_phone_variants(client: TestClient) -> None:
    r = client.post("/ops/compliance/opt-out", json={"phone": "+573001234567"})
    assert r.status_code == 200

    for variant in ("573001234567", "+57 3001234567", "3001234567", "00573001234567"):
        r = client.post(
            "/ops/calls/complete",
            json={"phone": variant, "first_name": "Ana", "intent": "interesado", "flow": "A"},
        )
        assert r.status_code == 200, variant
        body = r.json()
        assert body.get("whatsapp_sent") is False, variant
        assert body.get("whatsapp", {}).get("blocked") is True, variant


def test_handoff_respects_opt_out_before_liwa(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "liwa_mode", "real")
    monkeypatch.setattr(s, "liwa_api_token", "test-token")

    called = {"handoff": False}

    async def _fake_handoff(**_kwargs: object) -> dict[str, object]:
        called["handoff"] = True
        return {"ok": True, "contact_id": "c1"}

    monkeypatch.setattr(
        "pilot_core.modules.liwa_whatsapp.liwa_whatsapp_service.handoff_to_agency",
        _fake_handoff,
    )

    client.post("/ops/compliance/opt-out", json={"phone": "+573008887766"})
    r = client.post(
        "/ops/handoff",
        json={
            "name": "Ana OptOut",
            "segment": "Renovacion",
            "motivo": "test",
            "phone": "00573008887766",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("liwa", {}).get("blocked") is True
    assert called["handoff"] is False
    get_settings.cache_clear()


def test_e2e_skips_voice_when_voz_disabled(client: TestClient) -> None:
    client.put(
        "/ops/settings",
        json={"channels": {"voz_enabled": False, "whatsapp_enabled": True}},
    )
    r = client.post(
        "/ops/e2e/campaign",
        json={
            "phone": "+573009998877",
            "first_name": "Demo",
            "flow": "A",
            "skip_voice": True,
            "skip_whatsapp": False,
        },
    )
    assert r.status_code == 200
    assert r.json().get("ok") is True
    assert r.json()["steps"]["voice"].get("skipped") is True


def test_e2e_blocks_whatsapp_when_channel_disabled(client: TestClient) -> None:
    client.put(
        "/ops/settings",
        json={"channels": {"voz_enabled": True, "whatsapp_enabled": False}},
    )
    r = client.post(
        "/ops/e2e/campaign",
        json={
            "phone": "+573009998866",
            "first_name": "Demo",
            "flow": "A",
            "skip_voice": True,
            "skip_whatsapp": False,
        },
    )
    assert r.status_code == 403


def test_webhook_rejects_stale_signature(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = "test-webhook-secret"
    monkeypatch.setenv("ELEVENLABS_WEBHOOK_SECRET", secret)
    monkeypatch.setenv("AUTH_DISABLED", "false")
    from pilot_core.settings import get_settings

    get_settings.cache_clear()

    body = b'{"type":"post_call_transcription","data":{}}'
    stale_ts = str(int(time.time()) - 10_000)
    sig = hmac.new(secret.encode(), f"{stale_ts}.".encode() + body, hashlib.sha256).hexdigest()
    r = client.post(
        "/ops/webhooks/elevenlabs/post-call",
        content=body,
        headers={
            "content-type": "application/json",
            "elevenlabs-signature": f"t={stale_ts},v0={sig}",
        },
    )
    assert r.status_code == 401


def test_post_call_without_phone_does_not_steal_latest_dispatch(
    client: TestClient,
) -> None:
    import asyncio

    import pilot_core.ops_store as ops_store
    from pilot_core.modules.post_call.service import post_call_service

    ops_store.upsert_dispatch(
        {
            "id": "d_unrelated",
            "status": "sent",
            "flow": "A",
            "lead": {"phone": "+573001110000", "first_name": "Otro"},
            "conversation_id": "conv_other",
        }
    )
    result = asyncio.run(
        post_call_service.process(
            phone=None,
            intent="interesado",
            flow="A",
            source="test",
            raw_payload={"type": "post_call_transcription", "data": {}},
        )
    )
    assert not result.get("phone")
    assert result.get("whatsapp_sent") is False
    assert (result.get("whatsapp") or {}).get("error") == "phone_missing"
