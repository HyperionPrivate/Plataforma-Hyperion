"""LIWA inbound webhook → Conversaciones / CSAT / opt-out."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pilot_core import ops_store
from pilot_core.main import app
from pilot_core.modules.liwa_inbound import normalize_liwa_webhook, process_liwa_inbound
from pilot_core.settings import get_settings
from platform_kit.correlation import tenant_id_ctx


@pytest.fixture(autouse=True)
def _tenant(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("LIWA_MODE", "mock")
    monkeypatch.setenv("LIWA_WEBHOOK_SECRET", "test-secret")
    monkeypatch.setenv("LIWA_WEBHOOK_TENANT_ID", "tenant-dev")
    get_settings.cache_clear()
    token = tenant_id_ctx.set("tenant-dev")
    ops_store.init_db()
    yield
    tenant_id_ctx.reset(token)
    get_settings.cache_clear()


def test_normalize_opt_out_from_text() -> None:
    n = normalize_liwa_webhook({"phone": "3001112233", "text": "STOP no me contacten"})
    assert n["event"] == "opt_out"


def test_normalize_plan_events_and_ciudad() -> None:
    n = normalize_liwa_webhook(
        {
            "event": "handoff_requested",
            "phone": "573001112233",
            "ciudad": "Barranquilla",
            "name": "Ana",
        }
    )
    assert n["event"] == "handoff"
    assert n["agency_tag"] == "AG_BARRANQUILLA"

    d = normalize_liwa_webhook({"event": "document_received", "phone": "573001112233"})
    assert d["event"] == "document"

    c = normalize_liwa_webhook({"event": "csat", "phone": "573001112233", "score": 4})
    assert c["event"] == "csat"
    assert c["csat"] == 4


@pytest.mark.asyncio
async def test_process_message_creates_thread() -> None:
    res = await process_liwa_inbound(
        {
            "event": "message",
            "phone": "+573001112233",
            "first_name": "Ana",
            "text": "Hola, sigo estudiando",
        }
    )
    assert res["ok"] is True
    threads = ops_store.list_conversation_threads()
    assert any("Ana" in str(t.get("name")) for t in threads)


def test_webhook_http_ok() -> None:
    client = TestClient(app)
    r = client.post(
        "/ops/webhooks/liwa",
        headers={"X-LIWA-WEBHOOK-SECRET": "test-secret"},
        json={
            "event": "message",
            "phone": "573009998877",
            "first_name": "Luis",
            "text": "Quiero renovar",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True


def test_webhook_rejects_bad_secret() -> None:
    client = TestClient(app)
    r = client.post(
        "/ops/webhooks/liwa",
        headers={"X-LIWA-WEBHOOK-SECRET": "wrong"},
        json={"phone": "573001112233", "text": "hola"},
    )
    assert r.status_code == 401


def test_laboratorio_simulate_document_moves_crm() -> None:
    client = TestClient(app)
    r = client.post(
        "/ops/laboratorio/liwa-event",
        json={
            "event": "document_received",
            "phone": "+573002555948",
            "name": "Prueba",
            "ciudad": "Barranquilla",
            "tenant_id": "tenant-dev",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    assert "crm_documento" in (body.get("actions") or [])
