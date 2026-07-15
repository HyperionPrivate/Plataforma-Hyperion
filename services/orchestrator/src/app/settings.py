from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    service_name: str = "orchestrator"
    app_env: str = "development"
    host: str = "0.0.0.0"
    port: int = 8101
    database_url: str = "postgresql://coopfuturo:coopfuturo_dev@postgres:5432/db_orchestrator"
    redis_url: str = "redis://redis:6379/0"
    dialer_base_url: str = "http://host.docker.internal:8080"
    dialer_api_token: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
