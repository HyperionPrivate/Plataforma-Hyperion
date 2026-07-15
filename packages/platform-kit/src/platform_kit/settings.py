from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class PlatformSettings(BaseSettings):
    """Base settings for every deployable unit. Apps extend this class."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_name: str = "app"
    app_env: Literal["development", "test", "staging", "production"] = "development"
    port: int = 8200
    log_level: str = "INFO"
    log_json: bool = True

    database_url: SecretStr = Field(
        default=SecretStr("postgresql+asyncpg://app:CHANGE_ME@localhost:5432/db_app")
    )
    db_pool_size: int = 5
    db_pool_timeout_seconds: float = 5.0
    db_command_timeout_seconds: float = 30.0

    redis_url: SecretStr = Field(default=SecretStr("redis://localhost:6379/0"))
    redis_stream_key: str = "coopfuturo.events"
    redis_consumer_group: str = "default"
    redis_dlq_stream_key: str = "coopfuturo.events.dlq"
    redis_stream_maxlen: int = 0  # 0 = disabled (do not trim pending entries)
    redis_dlq_maxlen: int = 10_000
    redis_allow_maxlen_trim: bool = False  # must be explicit to enable primary MAXLEN
    redis_claim_min_idle_ms: int = 30_000
    event_max_retries: int = 3
    event_backoff_base_seconds: float = 0.5
    event_workers_enabled: bool = True
    worker_poll_seconds: float = 1.0
    worker_batch_size: int = 20

    # Auth — empty issuer disables JWT enforcement (development/test only)
    oidc_issuer: str = ""
    oidc_audience: str = ""
    oidc_jwks_url: str = ""
    oidc_jwks_static_json: str = ""  # for tests / offline JWKS
    # Comma-separated OAuth client_ids allowed for token_type=service
    service_allowed_clients: str = ""
    # Deprecated: shared-secret service auth removed; use service JWT + tenant_id claim.
    service_auth_shared_secret: SecretStr = Field(default=SecretStr(""))
    auth_disabled: bool = False  # forced false when app_env in staging/production

    cors_allowed_origins: str = ""
    max_request_bytes: int = 1_048_576
    rate_limit_per_minute: int = 120

    tenant_header: str = "X-Tenant-ID"
    correlation_header: str = "X-Correlation-ID"

    otel_exporter_otlp_endpoint: str = ""
    metrics_enabled: bool = True

    def require_secrets_or_fail(self) -> None:
        if self.app_env in ("staging", "production"):
            if self.auth_disabled:
                raise RuntimeError("auth_disabled is forbidden in staging/production")
            if not self.oidc_issuer or not self.oidc_audience:
                raise RuntimeError("OIDC_ISSUER and OIDC_AUDIENCE are required")
            db = self.database_url.get_secret_value()
            if "CHANGE_ME" in db or "coopfuturo_admin" in db:
                raise RuntimeError("DATABASE_URL must use least-privilege app role")


@lru_cache
def get_platform_settings() -> PlatformSettings:
    s = PlatformSettings()
    s.require_secrets_or_fail()
    return s
