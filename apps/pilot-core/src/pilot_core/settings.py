from __future__ import annotations

from functools import lru_cache

from platform_kit.settings import PlatformSettings


class Settings(PlatformSettings):
    service_name: str = "pilot-core"
    port: int = 8201
    auth_disabled: bool = True
    # Dialer HTTP (microservicio externo). Vacío = intentar ElevenLabs SIP directo.
    dialer_base_url: str = ""
    dialer_default_phone_number_id: str = "phnum_8201kxpqbx2tep8vs46t888y3gv8"
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
    # Shared secret for LIWA → PULSO webhooks / API externa (header X-LIWA-WEBHOOK-SECRET).
    liwa_webhook_secret: str = ""
    # Tenant ContextVar when LIWA webhook has no Ops JWT (Contabo single-tenant).
    liwa_webhook_tenant_id: str = "coopfuturo"
    # Alias used in some Contabo env files (Version / .env.contabo.example).
    liwa_webhook_default_tenant: str = ""

    def liwa_webhook_tenant(self) -> str:
        return (
            (self.liwa_webhook_tenant_id or "").strip()
            or (self.liwa_webhook_default_tenant or "").strip()
            or "coopfuturo"
        )

    # Documentos
    documents_storage_backend: str = "filesystem"  # mock | filesystem | minio
    documents_local_root: str = ""  # vacío = {PULSO_DATA_DIR|…}/documents
    minio_endpoint: str = ""
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = "coopfuturo-docs"
    # ElevenLabs post-call webhook (HMAC). Vacío = solo aceptar si AUTH_DISABLED en dev.
    elevenlabs_webhook_secret: str = ""
    # Poller de respaldo: al colgar consulta la conversación y dispara WA si el webhook falla.
    post_call_poller_enabled: bool = True
    post_call_poll_interval_sec: float = 5.0
    post_call_poll_max_wait_sec: int = 1200
    post_call_content_grace_sec: int = 45
    post_call_sweep_interval_sec: float = 20.0
    # WhatsApp post-llamada:
    #   False (por defecto) = modo revisión: marca al lead interesado y deja el WA
    #     PENDIENTE para envío manual controlado (no dispara el flujo a ciegas).
    #   True = automático: dispara el flujo LIWA al colgar (usar solo cuando el flujo
    #     tenga plantilla WhatsApp aprobada, para que Meta lo entregue de verdad).
    post_call_whatsapp_auto_send: bool = False
    # Core financiero Coopfuturo (opcional)
    core_base_url: str = ""
    core_api_token: str = ""
    core_associate_path: str = "/associates/{document_id}"
    cors_allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    # Allow orden-de-matrícula PDFs up to documents_service cap (+ multipart overhead).
    max_request_bytes: int = 11 * 1024 * 1024
    # AUD-010: mocks comerciales solo con opt-in explícito fuera de development/test.
    allow_mock_commercial: bool = False
    post_call_watch_concurrency: int = 32
    post_call_claim_lease_sec: int = 120

    def liwa_live_enabled(self) -> bool:
        return str(self.liwa_mode).lower() == "real" and bool(self.liwa_api_token.strip())

    def mocks_allowed(self) -> bool:
        if self.app_env in ("development", "test"):
            return True
        return bool(self.allow_mock_commercial)


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.require_secrets_or_fail()
    return s
