from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from platform_kit.auth import decode_and_validate_jwt, jwks_cache
from platform_kit.errors import PlatformError
from platform_kit.fastapi_app import _auth_readiness
from platform_kit.settings import PlatformSettings


def _rsa_jwks():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_numbers = key.public_key().public_numbers()

    def b64url_uint(val: int) -> str:
        length = (val.bit_length() + 7) // 8
        return jwt.utils.base64url_encode(val.to_bytes(length, "big")).decode("ascii")

    jwk = {
        "kty": "RSA",
        "kid": "test-key",
        "use": "sig",
        "alg": "RS256",
        "n": b64url_uint(public_numbers.n),
        "e": b64url_uint(public_numbers.e),
    }
    return private_pem, {"keys": [jwk]}


def test_production_requires_jwks() -> None:
    with pytest.raises(RuntimeError, match="OIDC_JWKS"):
        PlatformSettings(
            app_env="production",
            auth_disabled=False,
            oidc_issuer="https://issuer.test",
            oidc_audience="pulso",
            oidc_jwks_url="",
            oidc_jwks_static_json="",
            database_url="postgresql+asyncpg://app_pilot_core:secret@localhost:5432/db_pilot_core",
        ).require_secrets_or_fail()


def test_missing_jwks_returns_503_not_500() -> None:
    settings = PlatformSettings(
        app_env="test",
        auth_disabled=False,
        oidc_issuer="https://issuer.test",
        oidc_audience="pulso",
        oidc_jwks_url="",
        oidc_jwks_static_json="",
    )
    jwks_cache.configure(settings)
    assert jwks_cache.is_configured() is False
    # Minimal three-segment JWT so header parsing succeeds before JWKS lookup.
    header = jwt.utils.base64url_encode(b'{"alg":"RS256","typ":"JWT","kid":"x"}').decode("ascii")
    payload = jwt.utils.base64url_encode(b'{"sub":"u1"}').decode("ascii")
    token = f"{header}.{payload}.sig"
    with pytest.raises(PlatformError) as exc:
        decode_and_validate_jwt(token, settings)
    assert exc.value.status_code == 503
    assert "JWKS" in exc.value.message


@pytest.mark.asyncio
async def test_auth_readiness_fails_without_jwks() -> None:
    settings = PlatformSettings(
        app_env="production",
        auth_disabled=False,
        oidc_issuer="https://issuer.test",
        oidc_audience="pulso",
        oidc_jwks_url="",
        oidc_jwks_static_json="",
    )
    jwks_cache.configure(settings)
    result = await _auth_readiness(settings)
    assert result["ok"] is False
    assert result["jwks_configured"] is False


@pytest.mark.asyncio
async def test_auth_readiness_ok_with_static_jwks() -> None:
    _pem, jwks = _rsa_jwks()
    settings = PlatformSettings(
        app_env="production",
        auth_disabled=False,
        oidc_issuer="https://issuer.test",
        oidc_audience="pulso",
        oidc_jwks_static_json=json.dumps(jwks),
    )
    jwks_cache.configure(settings)
    result = await _auth_readiness(settings)
    assert result["ok"] is True


def test_unknown_kid_is_negatively_cached() -> None:
    private_pem, jwks = _rsa_jwks()
    settings = PlatformSettings(
        app_env="test",
        auth_disabled=False,
        oidc_issuer="https://issuer.test",
        oidc_audience="pulso",
        oidc_jwks_static_json=json.dumps(jwks),
    )
    jwks_cache.configure(settings)
    now = datetime.now(UTC)
    token = jwt.encode(
        {
            "sub": "u1",
            "iss": "https://issuer.test",
            "aud": "pulso",
            "iat": now,
            "exp": now + timedelta(minutes=5),
            "tenant_id": "t1",
        },
        private_pem,
        algorithm="RS256",
        headers={"kid": "missing-kid"},
    )
    with pytest.raises(PlatformError) as exc1:
        decode_and_validate_jwt(token, settings)
    assert exc1.value.status_code == 401
    assert "missing-kid" in jwks_cache._negative_kids
    with pytest.raises(PlatformError) as exc2:
        decode_and_validate_jwt(token, settings)
    assert exc2.value.status_code == 401
    assert "Unknown signing key" in exc2.value.message or "No matching JWK" in exc2.value.message
