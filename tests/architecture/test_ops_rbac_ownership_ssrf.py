"""AUD-003 / AUD-004 / AUD-005 regressions for Ops RBAC, ownership and dialer SSRF."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from platform_kit.auth import jwks_cache
from platform_kit.errors import PlatformError
from pilot_core.modules.dialer_safety import assert_safe_dialer_url


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
    monkeypatch.setenv("LIWA_MODE", "mock")
    monkeypatch.setenv("PULSO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OIDC_ISSUER", "https://issuer.test")
    monkeypatch.setenv("OIDC_AUDIENCE", "coopfuturo")
    monkeypatch.setenv("OIDC_JWKS_STATIC_JSON", json.dumps(jwks))

    from pilot_core.settings import get_settings

    get_settings.cache_clear()
    import pilot_core.ops_store as ops_store

    ops_store._DB_PATH = None
    ops_store.init_db()

    settings = get_settings()
    jwks_cache.configure(settings)

    from pilot_core.main import app

    app.state.settings = settings
    return TestClient(app), private_pem


def test_analyst_cannot_mutate_settings_or_campaigns(jwt_client) -> None:
    client, pem = jwt_client
    token = _token(pem, roles=["analyst"], tenant="t-a")
    headers = {"Authorization": f"Bearer {token}"}

    r = client.put(
        "/ops/settings",
        headers=headers,
        json={"ui": {"pii_masking": False}},
    )
    assert r.status_code == 403

    r = client.post(
        "/ops/campaigns",
        headers=headers,
        json={"name": "Nope", "segment": "Renovacion"},
    )
    assert r.status_code == 403

    # Reads still allowed
    r = client.get("/ops/contacts", headers=headers)
    assert r.status_code == 200


def test_dialer_base_url_rejected_from_api(jwt_client) -> None:
    client, pem = jwt_client
    token = _token(pem, roles=["admin"], tenant="t-a")
    r = client.put(
        "/ops/settings",
        headers={"Authorization": f"Bearer {token}"},
        json={"dialer": {"base_url": "http://127.0.0.1:9", "default_phone_number_id": "ph1"}},
    )
    assert r.status_code == 403
    assert r.json().get("error_code") == "dialer_url_immutable"


def test_conversation_ownership_blocks_takeover(jwt_client) -> None:
    client, pem = jwt_client
    adv_a = _token(pem, roles=["advisor"], tenant="t-a", sub="advisor-a")
    adv_b = _token(pem, roles=["advisor"], tenant="t-a", sub="advisor-b")
    cid = "conv_own_1"

    r = client.post(
        "/ops/conversations/claim",
        headers={"Authorization": f"Bearer {adv_a}"},
        json={"conversation_id": cid, "advisor": "A"},
    )
    assert r.status_code == 200
    assert r.json().get("owner_subject") == "advisor-a"

    r = client.post(
        "/ops/conversations/claim",
        headers={"Authorization": f"Bearer {adv_b}"},
        json={"conversation_id": cid, "advisor": "B"},
    )
    assert r.status_code == 403

    r = client.post(
        "/ops/conversations/messages",
        headers={"Authorization": f"Bearer {adv_b}"},
        json={"conversation_id": cid, "text": "hola", "role": "advisor"},
    )
    assert r.status_code == 403

    r = client.post(
        "/ops/conversations/release",
        headers={"Authorization": f"Bearer {adv_b}"},
        json={"conversation_id": cid},
    )
    assert r.status_code == 403

    r = client.post(
        "/ops/conversations/release",
        headers={"Authorization": f"Bearer {adv_a}"},
        json={"conversation_id": cid},
    )
    assert r.status_code == 200
    assert r.json().get("released") is True


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8080",
        "http://localhost/internal",
        "http://169.254.169.254/latest",
        "http://10.0.0.5/x",
        "http://192.168.1.1/x",
        "ftp://example.com",
    ],
)
def test_assert_safe_dialer_url_blocks_private(url: str) -> None:
    with pytest.raises(PlatformError) as exc:
        assert_safe_dialer_url(url)
    assert exc.value.status_code == 400
