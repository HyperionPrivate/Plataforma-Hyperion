"""SSRF guards for dialer HTTP fallback (AUD-005)."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

from platform_kit.errors import PlatformError

_BLOCKED_HOSTS = frozenset(
    {
        "localhost",
        "localhost.localdomain",
        "metadata.google.internal",
        "metadata",
    }
)


def assert_safe_dialer_url(url: str) -> str:
    """Reject non-http(s), credentials-in-URL, and private/link-local targets."""
    raw = (url or "").strip()
    if not raw:
        raise PlatformError("dialer_url_invalid", "Empty dialer URL", status_code=400)
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"}:
        raise PlatformError(
            "dialer_url_invalid", "Dialer URL must be http or https", status_code=400
        )
    if parsed.username or parsed.password:
        raise PlatformError(
            "dialer_url_invalid", "Dialer URL must not include credentials", status_code=400
        )
    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise PlatformError("dialer_url_invalid", "Dialer URL host required", status_code=400)
    if host in _BLOCKED_HOSTS or host.endswith(".localhost") or host.endswith(".local"):
        raise PlatformError("dialer_url_forbidden", "Dialer host is not allowed", status_code=400)
    # Literal IP
    try:
        ip = ipaddress.ip_address(host)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise PlatformError(
                "dialer_url_forbidden", "Dialer IP range is not allowed", status_code=400
            )
        return raw.rstrip("/")
    except ValueError:
        pass

    # DNS resolution — block if any answer is private/special.
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise PlatformError(
            "dialer_url_invalid", "Dialer host could not be resolved", status_code=400
        ) from exc
    for info in infos:
        sockaddr = info[4]
        addr = sockaddr[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise PlatformError(
                "dialer_url_forbidden",
                "Dialer host resolves to a blocked address",
                status_code=400,
            )
    return raw.rstrip("/")
