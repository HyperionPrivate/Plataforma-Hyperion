"""AUD-006 — PII masking forced for non-admin; leaky routes masked."""

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


def _token(private_pem: bytes, *, roles: list[str], tenant: str, sub: str = "user-1") -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": sub,
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

    with ops_store.tenant_scope("t-a"):
        ops_store.set_setting("ui", {"pii_masking": False})
        ops_store.insert_dispatch(
            {
                "id": "d_pii_1",
                "mode": "elevenlabs_sip",
                "status": "queued",
                "lead": {"phone": "+573001112233", "first_name": "Ana"},
            }
        )
    compliance_service.window_start = dt_time(0, 0)
    compliance_service.window_end = dt_time(23, 59)

    settings = get_settings()
    jwks_cache.configure(settings)
    from pilot_core.main import app

    app.state.settings = settings
    return TestClient(app), private_pem


def test_analyst_always_masked_even_if_ui_disabled(jwt_client) -> None:
    client, pem = jwt_client
    token = _token(pem, roles=["analyst"], tenant="t-a")
    r = client.get("/ops/calls/dispatch", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    items = r.json().get("items") or []
    assert items
    phone = ((items[0].get("lead") or {}).get("phone")) or ""
    assert "******" in phone
    assert r.json().get("pii_masked") is True


def test_supervisor_cannot_disable_pii_masking(jwt_client) -> None:
    client, pem = jwt_client
    token = _token(pem, roles=["supervisor"], tenant="t-a")
    r = client.put(
        "/ops/settings",
        headers={"Authorization": f"Bearer {token}"},
        json={"ui": {"pii_masking": False}},
    )
    assert r.status_code == 403
