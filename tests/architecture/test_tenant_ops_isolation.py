"""AUD-002: ops_store must isolate functional state by tenant_id."""

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
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()

    from pilot_core.main import app

    app.state.settings = get_settings()
    return TestClient(app)


def test_cross_tenant_settings_and_contacts_isolated(client: TestClient) -> None:
    # Tenant A creates settings + contact
    r = client.put(
        "/ops/settings",
        headers={"X-Tenant-ID": "tenant-a"},
        json={"ui": {"pii_masking": False}, "channels": {"voz_enabled": True}},
    )
    assert r.status_code == 200

    r = client.post(
        "/ops/contacts/import",
        headers={"X-Tenant-ID": "tenant-a"},
        json={
            "commit": True,
            "rows": [
                {
                    "phone": "+573001111111",
                    "first_name": "Alice",
                    "segment": "Renovacion",
                    "email": "alice@example.com",
                    "saldo_total": "1000000",
                }
            ],
        },
    )
    assert r.status_code == 200
    assert r.json().get("committed") == 1

    r = client.post(
        "/ops/campaigns",
        headers={"X-Tenant-ID": "tenant-a"},
        json={"name": "Camp A", "segment": "Renovacion"},
    )
    assert r.status_code == 200
    camp_a = r.json()["id"]

    # Tenant B must not see A's data
    r = client.get("/ops/contacts", headers={"X-Tenant-ID": "tenant-b"})
    assert r.status_code == 200
    body = r.json()
    assert body.get("total") == 0
    assert body.get("items") == []

    r = client.get("/ops/campaigns", headers={"X-Tenant-ID": "tenant-b"})
    assert r.status_code == 200
    camps = r.json().get("campaigns") or r.json().get("items") or []
    # campaigns endpoint merges fixtures; ensure stored camp A id is absent
    ids = {c.get("id") for c in camps if isinstance(c, dict)}
    assert camp_a not in ids

    r = client.get("/ops/settings", headers={"X-Tenant-ID": "tenant-b"})
    assert r.status_code == 200
    ui = r.json().get("ui") or {}
    # B never wrote ui.pii_masking=false
    assert ui.get("pii_masking") is not False

    # Tenant A still sees its contact
    r = client.get("/ops/contacts", headers={"X-Tenant-ID": "tenant-a"})
    assert r.status_code == 200
    items = r.json().get("items") or []
    assert len(items) == 1
    assert items[0]["phone"] == "+573001111111"


def test_store_requires_tenant_context(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()
    with pytest.raises(RuntimeError, match="tenant_id"):
        ops_store.list_contacts()

    with ops_store.tenant_scope("t1"):
        ops_store.insert_contact(
            {
                "id": "ct_1",
                "phone": "+573002222222",
                "first_name": "Bob",
                "segment": "Renovacion",
            }
        )
        assert len(ops_store.list_contacts()) == 1

    with ops_store.tenant_scope("t2"):
        assert ops_store.list_contacts() == []
