from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import APIRouter, Depends
from fastapi.testclient import TestClient
from platform_kit.auth import AuthContext, jwks_cache, require_auth, require_roles
from platform_kit.fastapi_app import create_app
from platform_kit.settings import PlatformSettings


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


def _token(private_pem: bytes, *, roles: list[str], tenant: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": "u1",
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


@pytest.fixture
def auth_client():
    private_pem, jwks = _rsa()
    settings = PlatformSettings(
        service_name="test-app",
        app_env="test",
        auth_disabled=False,
        oidc_issuer="https://issuer.test",
        oidc_audience="coopfuturo",
        oidc_jwks_static_json=json.dumps(jwks),
        database_url="sqlite+aiosqlite:///:memory:",
        redis_url="redis://localhost:6379/0",
    )
    jwks_cache.configure(settings)
    router = APIRouter()

    @router.get("/secure")
    async def secure(ctx: AuthContext = Depends(require_auth)) -> dict:
        return {"tenant": ctx.tenant_id, "roles": sorted(ctx.roles)}

    @router.get("/admin")
    async def admin(ctx: AuthContext = Depends(require_roles("admin"))) -> dict:
        return {"ok": True}

    app = create_app(
        settings=settings,
        version="0",
        title="test",
        engine_provider=lambda: None,
        routers=[router],
    )
    return TestClient(app), private_pem


def test_missing_bearer_401(auth_client) -> None:
    client, _ = auth_client
    assert client.get("/secure").status_code == 401


def test_analyst_forbidden_on_admin(auth_client) -> None:
    client, private_pem = auth_client
    token = _token(private_pem, roles=["analyst"], tenant="t1")
    r = client.get("/admin", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_tenant_mismatch_403(auth_client) -> None:
    client, private_pem = auth_client
    token = _token(private_pem, roles=["admin"], tenant="t1")
    r = client.get(
        "/secure",
        headers={"Authorization": f"Bearer {token}", "X-Tenant-ID": "t2"},
    )
    assert r.status_code == 403
