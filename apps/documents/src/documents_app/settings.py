from __future__ import annotations

from functools import lru_cache

from platform_kit.settings import PlatformSettings


class Settings(PlatformSettings):
    service_name: str = "documents"
    port: int = 8203
    auth_disabled: bool = True


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.require_secrets_or_fail()
    return s
