"""Product regressions for audit findings 1–6 (partial)."""

from __future__ import annotations

import hashlib
import hmac
import json
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
    # Estos tests validan el camino de envío/reintento de WhatsApp → auto-send ON.
    monkeypatch.setenv("POST_CALL_WHATSAPP_AUTO_SEND", "true")
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


def test_failed_liwa_claim_is_retryable_immediately(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    from pilot_core.modules.post_call.service import post_call_service
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    s = get_settings()
    monkeypatch.setattr(s, "liwa_mode", "real")
    monkeypatch.setattr(s, "liwa_api_token", "test-token")

    calls = {"n": 0}

    async def _fail_then_ok(**_kwargs: object) -> dict[str, object]:
        calls["n"] += 1
        if calls["n"] == 1:
            return {"ok": False, "error": "liwa_down"}
        return {"ok": True, "message": {"id": "m1"}}

    monkeypatch.setattr(
        "pilot_core.modules.liwa_whatsapp.liwa_whatsapp_service.send",
        _fail_then_ok,
    )

    first = asyncio.run(
        post_call_service.process(
            phone="+573001112233",
            intent="interesado",
            flow="A",
            conversation_id="conv_retry_1",
            source="test",
        )
    )
    assert first.get("status") == "failed"
    assert first.get("ok") is False

    second = asyncio.run(
        post_call_service.process(
            phone="+573001112233",
            intent="interesado",
            flow="A",
            conversation_id="conv_retry_1",
            source="test",
        )
    )
    assert second.get("status") == "completed"
    assert second.get("whatsapp_sent") is True
    assert calls["n"] == 2
    get_settings.cache_clear()


def test_exception_releases_claim_for_immediate_retry(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    from pilot_core.modules.post_call.service import post_call_service

    calls = {"n": 0}

    def _boom_then_ok(**_kwargs: object) -> dict[str, object]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("provider_crash")
        return {"ok": True, "message": {"id": "m2"}}

    monkeypatch.setattr(
        "pilot_core.modules.whatsapp_mock.whatsapp_mock_service.send_text",
        _boom_then_ok,
    )

    first = asyncio.run(
        post_call_service.process(
            phone="+573001112244",
            intent="interesado",
            flow="A",
            conversation_id="conv_exc_1",
            source="test",
        )
    )
    assert first.get("ok") is False
    assert first.get("status") == "failed"

    second = asyncio.run(
        post_call_service.process(
            phone="+573001112244",
            intent="interesado",
            flow="A",
            conversation_id="conv_exc_1",
            source="test",
        )
    )
    assert second.get("status") == "completed"
    assert calls["n"] == 2


def test_dedupe_before_unique_index_on_legacy_sqlite(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sqlite3

    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    db = tmp_path / "pulso_ops.sqlite3"
    conn = sqlite3.connect(str(db))
    conn.execute(
        """
        CREATE TABLE post_calls (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          phone TEXT,
          payload TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    # Legacy duplicates without unique index
    for i, status in enumerate(("processing", "completed", "failed")):
        conn.execute(
            "INSERT INTO post_calls(id, conversation_id, phone, payload) VALUES(?,?,?,?)",
            (
                f"pc_dup_{i}",
                "conv_dup",
                "+57300111",
                json.dumps({"id": f"pc_dup_{i}", "status": status, "conversation_id": "conv_dup"}),
            ),
        )
    conn.commit()
    conn.close()

    ops_store.init_db()  # must dedupe then create unique index without IntegrityError
    conn = sqlite3.connect(str(db))
    n = conn.execute("SELECT COUNT(*) FROM post_calls WHERE conversation_id='conv_dup'").fetchone()[
        0
    ]
    conn.close()
    assert n == 1


def test_crm_lead_not_duplicated_on_wa_retry(
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

    async def _fail_then_ok(**_kwargs: object) -> dict[str, object]:
        calls["n"] += 1
        if calls["n"] == 1:
            return {"ok": False, "error": "liwa_down"}
        return {"ok": True, "message": {"id": "m_ok"}}

    monkeypatch.setattr(
        "pilot_core.modules.liwa_whatsapp.liwa_whatsapp_service.send",
        _fail_then_ok,
    )

    first = asyncio.run(
        post_call_service.process(
            phone="+573001119900",
            intent="interesado",
            flow="A",
            conversation_id="conv_crm_once",
            source="test",
        )
    )
    assert first.get("status") == "failed"
    lead1 = (first.get("crm") or {}).get("id")
    assert lead1

    second = asyncio.run(
        post_call_service.process(
            phone="+573001119900",
            intent="interesado",
            flow="A",
            conversation_id="conv_crm_once",
            source="test",
        )
    )
    assert second.get("status") == "completed"
    assert (second.get("crm") or {}).get("id") == lead1
    assert (second.get("crm") or {}).get("resumed") is True
    get_settings.cache_clear()


def test_whatsapp_not_resent_after_partial_success(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    from pilot_core.modules.post_call.service import post_call_service

    sends = {"n": 0}

    def _send_ok(**_kwargs: object) -> dict[str, object]:
        sends["n"] += 1
        return {"ok": True, "message": {"id": f"m{sends['n']}"}}

    monkeypatch.setattr(
        "pilot_core.modules.whatsapp_mock.whatsapp_mock_service.send_text",
        _send_ok,
    )

    original_patch = post_call_service._patch_latest_dispatch_for_phone
    boomed = {"done": False}

    def _boom_patch(phone: str, post_call: dict) -> None:
        if not boomed["done"]:
            boomed["done"] = True
            raise RuntimeError("dispatch_crash_after_wa")
        return original_patch(phone, post_call)

    monkeypatch.setattr(post_call_service, "_patch_latest_dispatch_for_phone", _boom_patch)

    first = asyncio.run(
        post_call_service.process(
            phone="+573001119901",
            intent="interesado",
            flow="A",
            conversation_id="conv_wa_once",
            source="test",
        )
    )
    assert first.get("status") == "failed"
    assert first.get("whatsapp_sent") is True
    assert sends["n"] == 1

    second = asyncio.run(
        post_call_service.process(
            phone="+573001119901",
            intent="interesado",
            flow="A",
            conversation_id="conv_wa_once",
            source="test",
        )
    )
    assert second.get("status") == "completed"
    assert sends["n"] == 1
    assert (second.get("whatsapp") or {}).get("resumed") is True


def test_webhook_returns_502_on_retryable_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("ELEVENLABS_WEBHOOK_SECRET", "")
    get_settings.cache_clear()

    async def _fail(**_kwargs: object) -> dict[str, object]:
        return {
            "ok": False,
            "status": "failed",
            "retryable": True,
            "error": "whatsapp_send_failed",
        }

    monkeypatch.setattr(
        "pilot_core.modules.post_call.service.post_call_service.process",
        _fail,
    )
    r = client.post(
        "/ops/webhooks/elevenlabs/post-call",
        json={"type": "post_call_transcription", "data": {"conversation_id": "c1"}},
    )
    assert r.status_code == 502
    get_settings.cache_clear()
