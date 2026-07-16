import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_contabo_overlay_is_loopback_only_and_fail_closed() -> None:
    overlay = (ROOT / "docker-compose.contabo.yml").read_text(encoding="utf-8")

    assert '"127.0.0.1:${TRAEFIK_HTTP_PORT:-9088}:80"' in overlay
    assert '"0.0.0.0:${TRAEFIK_HTTP_PORT:-9088}:80"' not in overlay
    assert "AUTH_DISABLED: ${AUTH_DISABLED:-false}" in overlay
    assert "APP_ENV: ${APP_ENV:-production}" in overlay
    assert "OIDC_ISSUER: ${OIDC_ISSUER:?OIDC_ISSUER is required for Contabo}" in overlay
    assert "OIDC_AUDIENCE: ${OIDC_AUDIENCE:?OIDC_AUDIENCE is required for Contabo}" in overlay
    assert "OIDC_JWKS_URL: ${OIDC_JWKS_URL:?OIDC_JWKS_URL is required for Contabo}" in overlay
    assert "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" in overlay
    assert "REDIS_PASSWORD:?REDIS_PASSWORD is required" in overlay
    assert "--requirepass" in overlay
    assert (
        "REDIS_URL: redis://:${REDIS_PASSWORD:?REDIS_PASSWORD is required}@redis:6379/0" in overlay
    )
    for service in ("pilot-core", "whatsapp-adapter", "documents", "handoff-liwa"):
        match = re.search(
            rf"^  {re.escape(service)}:\n(?P<body>.*?)(?=^  [a-zA-Z0-9_-]+:|\Z)",
            overlay,
            flags=re.MULTILINE | re.DOTALL,
        )
        assert match is not None, service
        body = match.group("body")
        assert "<<: *oidc_env" in body or "OIDC_ISSUER" in body
    assert "LIWA_MODE: ${LIWA_MODE:-mock}" in overlay
    assert ("POST_CALL_WHATSAPP_AUTO_SEND: ${POST_CALL_WHATSAPP_AUTO_SEND:-false}") in overlay
    assert "NEXT_PUBLIC_PILOT_CORE_URL: ${PUBLIC_PILOT_CORE_URL:-/pilot-core}" in overlay
    assert "127.0.0.1:9088/pilot-core" not in overlay
    assert 'NEXT_PUBLIC_REQUIRE_AUTH: "true"' in overlay
    # AUD-032: mock satellites must not be published on Traefik.
    assert overlay.count("traefik.enable=false") >= 3
    assert "PathPrefix(`/whatsapp`)" not in overlay
    assert "PathPrefix(`/documents`)" not in overlay
    assert "PathPrefix(`/handoff-liwa`)" not in overlay


def test_contabo_example_keeps_real_providers_disabled() -> None:
    env_example = (ROOT / ".env.contabo.example").read_text(encoding="utf-8")

    assert "AUTH_DISABLED=false" in env_example
    assert "APP_ENV=production" in env_example
    assert "REDIS_PASSWORD=" in env_example
    assert "OIDC_ISSUER=" in env_example
    assert "OIDC_AUDIENCE=" in env_example
    assert "OIDC_JWKS_URL=" in env_example
    assert "PUBLIC_PILOT_CORE_URL=/pilot-core" in env_example
    assert "DIALER_BASE_URL=\n" in env_example
    assert "LIWA_MODE=mock" in env_example
    assert "LIWA_API_TOKEN=\n" in env_example
    assert "ELEVENLABS_API_KEY=\n" in env_example
    assert "POST_CALL_WHATSAPP_AUTO_SEND=false" in env_example
