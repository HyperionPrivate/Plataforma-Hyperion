# Corte real NOVA (fase 6)

Activación de integraciones reales detrás de flags, con smoke de paridad contra mock.

## Flags

| Variable                     | Default                | Real                                        |
| ---------------------------- | ---------------------- | ------------------------------------------- |
| `VOICE_MODE`                 | `mock`                 | `dialer` (o `elevenlabs_sip` solo demo)     |
| `LIWA_MODE`                  | `mock`                 | `live`                                      |
| `DIALER_BASE_URL`            | vacío                  | URL HTTPS del Neutral Dialer v3             |
| `VOICE_TO_DIALER_TOKEN`      | placeholder            | JWT del dialer                              |
| `DIALER_WEBHOOK_HMAC_SECRET` | placeholder            | HMAC compartido                             |
| `LIWA_BASE_URL`              | `https://chat.liwa.co` | mismo                                       |
| `LIWA_WEBHOOK_SECRET`        | placeholder            | rotado (credencial comprometida del piloto) |

## Bloqueadores externos

1. **Rotar credencial LIWA** antes de `LIWA_MODE=live`.
2. Dominio público estable para webhooks (sin Cloudflare quick tunnel).
3. Stack Compose del dialer desplegado junto a Hyperion (`infra/docker-compose.dialer.yml` overlay).
4. Configurar en LIWA los nodos de webhook hacia `https://<dominio>/v1/liwa/webhooks`.

## Migración Contabo → Hyperion

1. Desplegar Compose Hyperion + dialer.
2. Bootstrap tenant Coopfuturo (`POST .../nova/bootstrap`).
3. Importar contactos (CSV E.164) vía Ops UI.
4. Smoke E2E: llamada mock → post-call → WhatsApp flow mock → doc → handoff → CRM.
5. Activar dialer real en un tenant de prueba; comparar pacing/stats.
6. Activar LIWA live tras rotar secreto.
7. Retirar scripts `.sh` ad-hoc y secretos temporales del piloto.

## Smoke CI

Script: `scripts/autonomy/nova-smoke.e2e.mjs` (mock por defecto).
Flujo: import → eligibility → campaign start → voice.call.* → wa.send.* → document → handoff claim.
