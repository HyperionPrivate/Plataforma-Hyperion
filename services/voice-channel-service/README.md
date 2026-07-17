# voice-channel-service

Adaptador de voz de Hyperion para el producto NOVA. Este servicio es el **único cliente autorizado**
del Neutral Dialer v3 dentro de Hyperion (ver [ADR-0004](../../docs/architecture/decisions/ADR-0004-neutral-dialer-external-voice.md)).

## Responsabilidades

- Traducir eventos internos (`voice.call.requested` → `voice.call.dispatched` → `voice.call.completed`).
- Gestionar campañas y llamadas contra el dialer externo cuando `VOICE_MODE=dialer`.
- Recibir webhooks HMAC del dialer (`X-Dialer-Signature`) y de ElevenLabs.
- Exponer reconciliación (`needs_reconciliation`) hacia el dashboard de NOVA.

## Dialer externo

El **Neutral Dialer v3** vive **fuera del monorepo** (Python/FastAPI, despliegue Compose separado).
Hyperion no reimplementa pacing, AMD, rotación DDI ni reconciliación: delega en el dialer vía HTTP.

Variables relevantes:

| Variable                     | Uso                                              |
| ---------------------------- | ------------------------------------------------ |
| `VOICE_MODE`                 | `mock` (default) o `dialer`                      |
| `DIALER_BASE_URL`            | Base URL del dialer (SSRF guard: solo este host) |
| `VOICE_TO_DIALER_TOKEN`      | Bearer JWT hacia el dialer                       |
| `DIALER_WEBHOOK_HMAC_SECRET` | Validación de webhooks entrantes                 |

En `mock`, las llamadas se completan localmente y se publican eventos hacia `nova-core-service`.

## Contratos internos

- Entrada desde NOVA: `POST /v1/voice/internal/events` (`NOVA_TO_VOICE_TOKEN`).
- Salida hacia NOVA: outbox HTTP → `POST /internal/events` (`VOICE_TO_NOVA_TOKEN`).
