from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any

import jwt
from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

from platform_kit.correlation import tenant_id_ctx
from platform_kit.errors import PlatformError
from platform_kit.settings import PlatformSettings, get_platform_settings

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthContext:
    subject: str
    tenant_id: str
    roles: frozenset[str]
    token_type: str  # user | service
    scopes: frozenset[str]


class JWKSCache:
    def __init__(self) -> None:
        self._client: PyJWKClient | None = None
        self._static_keys: dict[str, Any] | None = None

    def configure(self, settings: PlatformSettings) -> None:
        if settings.oidc_jwks_static_json:
            self._static_keys = json.loads(settings.oidc_jwks_static_json)
            self._client = None
        elif settings.oidc_jwks_url:
            self._client = PyJWKClient(settings.oidc_jwks_url, cache_keys=True)
            self._static_keys = None

    def get_signing_key(self, token: str) -> Any:
        try:
            if self._static_keys is not None:
                header = jwt.get_unverified_header(token)
                kid = header.get("kid")
                for key in self._static_keys.get("keys", []):
                    if kid is None or key.get("kid") == kid:
                        return jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(key))
                raise PlatformError("invalid_token", "No matching JWK", status_code=401)
            if self._client is None:
                raise PlatformError("auth_misconfigured", "JWKS not configured", status_code=500)
            return self._client.get_signing_key_from_jwt(token).key
        except PlatformError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise PlatformError("invalid_token", "Invalid or expired JWT", status_code=401) from exc


jwks_cache = JWKSCache()


def decode_and_validate_jwt(token: str, settings: PlatformSettings) -> dict[str, Any]:
    if not settings.oidc_issuer or not settings.oidc_audience:
        raise PlatformError("auth_misconfigured", "OIDC not configured", status_code=500)
    key = jwks_cache.get_signing_key(token)
    try:
        return jwt.decode(
            token,
            key=key,
            algorithms=["RS256"],
            audience=settings.oidc_audience,
            issuer=settings.oidc_issuer,
            options={"require": ["exp", "iat", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise PlatformError("invalid_token", "Invalid or expired JWT", status_code=401) from exc


def _roles_from_claims(claims: dict[str, Any]) -> frozenset[str]:
    raw = claims.get("roles") or claims.get("realm_access", {}).get("roles") or []
    if isinstance(raw, str):
        return frozenset(raw.split())
    return frozenset(str(r) for r in raw)


def _scopes_from_claims(claims: dict[str, Any]) -> frozenset[str]:
    raw = claims.get("scope") or claims.get("scopes") or []
    if isinstance(raw, str):
        return frozenset(s for s in raw.split() if s)
    return frozenset(str(s) for s in raw)


def _tenant_from_claims(claims: dict[str, Any]) -> str:
    tenant = claims.get("tenant_id")
    if tenant:
        return str(tenant)
    raise PlatformError(
        "missing_tenant",
        "tenant_id claim is required; header override is not allowed",
        status_code=401,
    )


def _token_type_from_claims(claims: dict[str, Any], roles: frozenset[str]) -> str:
    explicit = str(claims.get("token_type") or claims.get("typ") or "").lower()
    if explicit in ("service", "user"):
        return explicit
    if "service" in roles or claims.get("client_id"):
        return "service"
    return "user"


async def require_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> AuthContext:
    settings = getattr(request.app.state, "settings", None) or get_platform_settings()

    if settings.auth_disabled and settings.app_env in ("development", "test"):
        tenant = request.headers.get(settings.tenant_header, "tenant-dev")
        tenant_id_ctx.set(tenant)
        return AuthContext(
            subject="dev",
            tenant_id=tenant,
            roles=frozenset({"admin", "supervisor", "advisor", "analyst", "service"}),
            token_type="user",
            scopes=frozenset({"*"}),
        )

    if credentials is None or credentials.scheme.lower() != "bearer":
        raise PlatformError("unauthorized", "Bearer token required", status_code=401)

    claims = decode_and_validate_jwt(credentials.credentials, settings)
    tenant = _tenant_from_claims(claims)
    header_tenant = request.headers.get(settings.tenant_header)
    if header_tenant and header_tenant != tenant:
        raise PlatformError(
            "tenant_mismatch", "Tenant header does not match token", status_code=403
        )

    roles = _roles_from_claims(claims)
    token_type = _token_type_from_claims(claims, roles)
    scopes = _scopes_from_claims(claims)

    # Service tokens must carry explicit service role or token_type=service
    if token_type == "service" and "service" not in roles and "admin" not in roles:
        roles = frozenset(set(roles) | {"service"})

    tenant_id_ctx.set(tenant)
    return AuthContext(
        subject=str(claims["sub"]),
        tenant_id=tenant,
        roles=roles,
        token_type=token_type,
        scopes=scopes,
    )


def require_roles(*needed: str):
    async def _dep(ctx: AuthContext = Depends(require_auth)) -> AuthContext:
        if "admin" in ctx.roles:
            return ctx
        if not set(needed) & set(ctx.roles):
            raise PlatformError("forbidden", "Insufficient role", status_code=403)
        return ctx

    return _dep


def require_scopes(*needed: str):
    async def _dep(ctx: AuthContext = Depends(require_auth)) -> AuthContext:
        if "*" in ctx.scopes or "admin" in ctx.roles:
            return ctx
        if not set(needed) & set(ctx.scopes):
            raise PlatformError("forbidden", "Insufficient scope", status_code=403)
        return ctx

    return _dep


def verify_webhook_timestamp(ts_header: str | None, *, max_skew_seconds: int = 300) -> None:
    if not ts_header:
        raise PlatformError("webhook_replay", "Missing timestamp", status_code=401)
    try:
        ts = int(ts_header)
    except ValueError as exc:
        raise PlatformError("webhook_replay", "Invalid timestamp", status_code=401) from exc
    if abs(int(time.time()) - ts) > max_skew_seconds:
        raise PlatformError("webhook_replay", "Timestamp outside allowed skew", status_code=401)


def verify_webhook_hmac(
    *,
    body: bytes,
    signature_header: str | None,
    secret: str,
    timestamp_header: str | None = None,
    max_skew_seconds: int = 300,
) -> None:
    """HMAC-SHA256 over `{timestamp}.{body}` when timestamp is present, else over body."""
    if timestamp_header is not None:
        verify_webhook_timestamp(timestamp_header, max_skew_seconds=max_skew_seconds)
    if not secret:
        raise PlatformError(
            "webhook_misconfigured", "Webhook secret not configured", status_code=500
        )
    if not signature_header:
        raise PlatformError("webhook_signature", "Missing signature", status_code=401)
    provided = signature_header.removeprefix("sha256=").strip()
    payload = f"{timestamp_header}.".encode() + body if timestamp_header is not None else body
    expected = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided, expected):
        raise PlatformError("webhook_signature", "Invalid signature", status_code=401)
