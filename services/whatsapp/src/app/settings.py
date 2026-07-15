from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_name: str = "whatsapp"
    app_env: str = "development"
    host: str = "0.0.0.0"
    port: int = 8104
    database_url: str = "postgresql://coopfuturo:coopfuturo_dev@postgres:5432/db_whatsapp"
    redis_url: str = "redis://redis:6379/0"


@lru_cache
def get_settings() -> Settings:
    return Settings()
