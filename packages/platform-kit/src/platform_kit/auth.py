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
    client_id: str | None = None


class JWKSCache:
    """Signing-key lookup with fail-closed misconfig and short negative kid cache."""

    _NEGATIVE_KID_TTL_SECONDS = 60.0

    def __init__(self) -> None:
        self._client: PyJWKClient | None = None
        self._static_keys: dict[str, Any] | None = None
        self._negative_kids: dict[str, float] = {}

    def configure(self, settings: PlatformSettings) -> None:
        self._negative_kids.clear()
        if settings.oidc_jwks_static_json:
            self._static_keys = json.loads(settings.oidc_jwks_static_json)
            self._client = None
        elif settings.oidc_jwks_url:
            self._client = PyJWKClient(settings.oidc_jwks_url, cache_keys=True)
            self._static_keys = None
        else:
            self._client = None
            self._static_keys = None

    def is_configured(self) -> bool:
        return self._static_keys is not None or self._client is not None

    def get_signing_key(self, token: str) -> Any:
        try:
            header = jwt.get_unverified_header(token)
        except Exception as exc:  # noqa: BLE001
            raise PlatformError("invalid_token", "Invalid or expired JWT", status_code=401) from exc
        kid = header.get("kid")
        if isinstance(kid, str) and kid:
            until = self._negative_kids.get(kid)
            if until is not None:
                if time.monotonic() < until:
                    raise PlatformError("invalid_token", "Unknown signing key", status_code=401)
                del self._negative_kids[kid]

        try:
            if self._static_keys is not None:
                for key in self._static_keys.get("keys", []):
                    if kid is None or key.get("kid") == kid:
                        return jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(key))
                if isinstance(kid, str) and kid:
                    self._negative_kids[kid] = time.monotonic() + self._NEGATIVE_KID_TTL_SECONDS
                raise PlatformError("invalid_token", "No matching JWK", status_code=401)
            if self._client is None:
                raise PlatformError("auth_misconfigured", "JWKS not configured", status_code=503)
            return self._client.get_signing_key_from_jwt(token).key
        except PlatformError:
            raise
        except Exception as exc:  # noqa: BLE001
            if isinstance(kid, str) and kid:
                self._negative_kids[kid] = time.monotonic() + self._NEGATIVE_KID_TTL_SECONDS
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
    """Service status only from explicit claim or issuer-granted role — never from client_id alone."""
    explicit = str(claims.get("token_type") or "").lower()
    if explicit in ("service", "user"):
        return explicit
    # JWT "typ" header/claim is often "JWT" — ignore unless exactly service/user
    typ = str(claims.get("typ") or "").lower()
    if typ in ("service", "user"):
        return typ
    if "service" in roles:
        return "service"
    return "user"


def _allowed_service_clients(settings: PlatformSettings) -> frozenset[str]:
    return frozenset(c.strip() for c in settings.service_allowed_clients.split(",") if c.strip())


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
    client_id = str(claims["client_id"]) if claims.get("client_id") else None

    # User tokens must not keep an effective "service" role (would bypass allowlist/scopes).
    if token_type != "service" and "service" in roles:
        roles = frozenset(r for r in roles if r != "service")

    if token_type == "service":
        if "service" not in roles and "admin" not in roles:
            raise PlatformError(
                "forbidden",
                "service tokens require an issuer-granted service (or admin) role",
                status_code=403,
            )
        allowed = _allowed_service_clients(settings)
        if not allowed:
            raise PlatformError(
                "auth_misconfigured",
                "SERVICE_ALLOWED_CLIENTS must be configured for service tokens",
                status_code=500,
            )
        if not client_id or client_id not in allowed:
            raise PlatformError(
                "forbidden",
                "client_id is not in the service allowlist",
                status_code=403,
            )
        if not scopes:
            raise PlatformError(
                "forbidden",
                "service tokens require explicit scopes",
                status_code=403,
            )

    tenant_id_ctx.set(tenant)
    return AuthContext(
        subject=str(claims["sub"]),
        tenant_id=tenant,
        roles=roles,
        token_type=token_type,
        scopes=scopes,
        client_id=client_id,
    )


def require_roles(*needed: str):
    async def _dep(ctx: AuthContext = Depends(require_auth)) -> AuthContext:
        if "admin" in ctx.roles:
            return ctx
        if "service" in needed and ctx.token_type != "service":
            raise PlatformError(
                "forbidden",
                "service endpoints require a service token (token_type=service)",
                status_code=403,
            )
        if not set(needed) & set(ctx.roles):
            raise PlatformError("forbidden", "Insufficient role", status_code=403)
        return ctx

    return _dep


def require_roles_and_scopes(*needed_roles: str, scopes: tuple[str, ...] = ()):
    """Compose role + scope checks for technical/service routes."""

    async def _dep(ctx: AuthContext = Depends(require_roles(*needed_roles))) -> AuthContext:
        if not scopes:
            return ctx
        if "*" in ctx.scopes or "admin" in ctx.roles:
            return ctx
        if not set(scopes) & set(ctx.scopes):
            raise PlatformError("forbidden", "Insufficient scope", status_code=403)
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
