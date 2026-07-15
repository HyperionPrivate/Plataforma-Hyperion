from __future__ import annotations

from functools import lru_cache

from platform_kit.settings import PlatformSettings


class Settings(PlatformSettings):
    service_name: str = "pilot-core"
    port: int = 8201
    auth_disabled: bool = True
    # Dialer HTTP (microservicio externo). Vacío = intentar ElevenLabs SIP directo.
    dialer_base_url: str = ""
    dialer_default_phone_number_id: str = "phnum_0201kwgmeny9ez1996k8rqgz2d5z"
    # ElevenLabs — outbound SIP trunk directo (PULSO).
    elevenlabs_api_key: str = ""
    # LIWA WhatsApp — real solo con token en env (nunca en git).
    liwa_mode: str = "mock"  # mock | real
    liwa_base_url: str = "https://chat.liwa.co/api"
    liwa_api_token: str = ""
    # Flujo LIWA con plantilla WA (outbound fuera de ventana 24h).
    # A = Renovaciones; B = Reactivaciones (vacío = usa el de A hasta provisionar plantilla propia).
    liwa_default_flow_id: str = "1782399915832"
    liwa_flow_id_b: str = ""
    liwa_handoff_tag: str = "RENOVACION_VIP"
    liwa_handoff_tag_b: str = "REACTIVACION_VIP"
    # Documentos
    documents_storage_backend: str = "filesystem"  # mock | filesystem | minio
    documents_local_root: str = ""  # vacío = {PULSO_DATA_DIR|…}/documents
    minio_endpoint: str = ""
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = "coopfuturo-docs"
    # ElevenLabs post-call webhook (HMAC). Vacío = solo aceptar si AUTH_DISABLED en dev.
    elevenlabs_webhook_secret: str = ""
    # Core financiero Coopfuturo (opcional)
    core_base_url: str = ""
    core_api_token: str = ""
    core_associate_path: str = "/associates/{document_id}"
    cors_allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    def liwa_live_enabled(self) -> bool:
        return str(self.liwa_mode).lower() == "real" and bool(self.liwa_api_token.strip())


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.require_secrets_or_fail()
    return s
