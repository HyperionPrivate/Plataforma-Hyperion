from __future__ import annotations

from functools import lru_cache

from platform_kit.settings import PlatformSettings


class Settings(PlatformSettings):
    service_name: str = "pilot-core"
    port: int = 8201
    auth_disabled: bool = True
    # Dialer HTTP (microservicio externo o local). Vacío = dispatch mock.
    dialer_base_url: str = ""
    dialer_default_phone_number_id: str = ""
    cors_allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.require_secrets_or_fail()
    return s
