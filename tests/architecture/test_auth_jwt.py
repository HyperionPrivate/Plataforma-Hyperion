from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from platform_kit.auth import decode_and_validate_jwt, jwks_cache
from platform_kit.errors import PlatformError
from platform_kit.settings import PlatformSettings


@pytest.fixture
def rsa_pair():
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


def test_invalid_jwt_raises_401(rsa_pair) -> None:
    _private, jwks = rsa_pair
    settings = PlatformSettings(
        oidc_issuer="https://issuer.test",
        oidc_audience="coopfuturo",
        oidc_jwks_static_json=json.dumps(jwks),
        auth_disabled=False,
        app_env="test",
    )
    jwks_cache.configure(settings)
    with pytest.raises(PlatformError) as exc:
        decode_and_validate_jwt("not-a-jwt", settings)
    assert exc.value.status_code == 401


def test_valid_jwt_decodes(rsa_pair) -> None:
    private_pem, jwks = rsa_pair
    settings = PlatformSettings(
        oidc_issuer="https://issuer.test",
        oidc_audience="coopfuturo",
        oidc_jwks_static_json=json.dumps(jwks),
        auth_disabled=False,
        app_env="test",
    )
    jwks_cache.configure(settings)
    now = datetime.now(UTC)
    token = jwt.encode(
        {
            "sub": "user-1",
            "iss": "https://issuer.test",
            "aud": "coopfuturo",
            "iat": now,
            "exp": now + timedelta(minutes=5),
            "tenant_id": "tenant-a",
            "roles": ["analyst"],
        },
        private_pem,
        algorithm="RS256",
        headers={"kid": "test-key"},
    )
    claims = decode_and_validate_jwt(token, settings)
    assert claims["sub"] == "user-1"
    assert claims["tenant_id"] == "tenant-a"
