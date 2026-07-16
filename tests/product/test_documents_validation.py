"""AUD-024/027 — upload size streaming + content magic for validated status."""

from __future__ import annotations

from datetime import time as dt_time

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("AUTH_DISABLED", "true")
    monkeypatch.setenv("EVENT_WORKERS_ENABLED", "false")
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


def test_spoofed_pdf_extension_is_rejected(client: TestClient) -> None:
    r = client.post(
        "/ops/documents/upload",
        files={"file": ("fake.pdf", b"not-a-pdf", "application/pdf")},
        data={"kind": "orden_matricula"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is False
    assert body.get("status") == "rejected"
    assert "content_type_mismatch" in (body.get("errors") or [])


def test_real_pdf_magic_is_validated(client: TestClient) -> None:
    r = client.post(
        "/ops/documents/upload",
        files={"file": ("ok.pdf", b"%PDF-1.4\n%", "application/pdf")},
        data={"kind": "orden_matricula"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert body.get("status") == "validated"


def test_metadata_only_is_received_not_validated(client: TestClient) -> None:
    from pilot_core.modules.documents_service import documents_service
    import pilot_core.ops_store as ops_store

    with ops_store.tenant_scope("tenant-dev"):
        doc = documents_service.register(
            filename="meta.pdf",
            content_type="application/pdf",
            size_bytes=12,
            kind="orden_matricula",
            content=None,
        )
    assert doc.get("status") == "received"
    assert doc.get("ok") is True
