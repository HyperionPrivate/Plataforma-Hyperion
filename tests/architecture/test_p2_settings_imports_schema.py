"""AUD-028/030/031 — settings schema, atomic imports, schema version."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from datetime import time as dt_time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from platform_kit.auth import jwks_cache


def _rsa():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    pub = key.public_key().public_numbers()

    def b64url_uint(val: int) -> str:
        length = (val.bit_length() + 7) // 8
        return jwt.utils.base64url_encode(val.to_bytes(length, "big")).decode("ascii")

    jwk = {
        "kty": "RSA",
        "kid": "k1",
        "use": "sig",
        "alg": "RS256",
        "n": b64url_uint(pub.n),
        "e": b64url_uint(pub.e),
    }
    return private_pem, {"keys": [jwk]}


def _token(private_pem: bytes, *, roles: list[str], tenant: str = "t-a") -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": "user-1",
            "iss": "https://issuer.test",
            "aud": "coopfuturo",
            "iat": now,
            "exp": now + timedelta(minutes=5),
            "tenant_id": tenant,
            "roles": roles,
        },
        private_pem,
        algorithm="RS256",
        headers={"kid": "k1"},
    )


@pytest.fixture()
def jwt_client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    private_pem, jwks = _rsa()
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("AUTH_DISABLED", "false")
    monkeypatch.setenv("EVENT_WORKERS_ENABLED", "false")
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OIDC_ISSUER", "https://issuer.test")
    monkeypatch.setenv("OIDC_AUDIENCE", "coopfuturo")
    monkeypatch.setenv("OIDC_JWKS_STATIC_JSON", json.dumps(jwks))
    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()
    from pilot_core.modules.compliance.service import compliance_service

    compliance_service.window_start = dt_time(0, 0)
    compliance_service.window_end = dt_time(23, 59)
    settings = get_settings()
    jwks_cache.configure(settings)
    from pilot_core.main import app

    app.state.settings = settings
    return TestClient(app), private_pem


def test_supervisor_cannot_disable_contact_window(jwt_client) -> None:
    client, pem = jwt_client
    token = _token(pem, roles=["supervisor"])
    r = client.put(
        "/ops/settings",
        headers={"Authorization": f"Bearer {token}"},
        json={"channels": {"ventana_8_20": False}},
    )
    assert r.status_code == 403


def test_unknown_channel_keys_rejected(jwt_client) -> None:
    client, pem = jwt_client
    token = _token(pem, roles=["admin"])
    r = client.put(
        "/ops/settings",
        headers={"Authorization": f"Bearer {token}"},
        json={"channels": {"evil_flag": True}},
    )
    assert r.status_code == 422


def test_campaign_without_total_is_draft(jwt_client) -> None:
    client, pem = jwt_client
    token = _token(pem, roles=["supervisor"])
    r = client.post(
        "/ops/campaigns",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": "Sin roster", "segment": "Renovacion", "total": 0},
    )
    assert r.status_code == 200
    assert r.json().get("status") == "draft"


def test_schema_version_set(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    with ops_store.tenant_scope("t"):
        ops_store.init_db()
        assert ops_store.schema_version() == ops_store.SCHEMA_VERSION
