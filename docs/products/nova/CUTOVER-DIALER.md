# Cutover Dialer (NOVA)

Nota corta para activar voz real con Neutral Dialer v3 junto a Hyperion.

## Compose

Desplegar Hyperion y el overlay del dialer en el mismo stack de red:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dialer.yml --profile dialer up -d
```

Variables mínimas en voice-channel:

- `VOICE_MODE=dialer`
- `DIALER_BASE_URL` (p. ej. `http://neutral-dialer:8080`)
- `VOICE_TO_DIALER_TOKEN`
- `DIALER_WEBHOOK_HMAC_SECRET`

El dialer permanece fuera del monorepo (ADR-0004); el overlay solo cablea URL, secretos y red.

## Single-worker

El Neutral Dialer v3 opera hoy con **un solo worker** de pacing/ejecución. No escalar réplicas del dialer ni lanzar campañas masivas concurrentes hasta que ese límite se retire en el repo del dialer. Hyperion puede tener N réplicas de `voice-channel-service`; el cuello de botella de outbound es el dialer.

## Webhooks y dominio

Los callbacks HMAC del dialer llegan a Hyperion (`POST /v1/voice/webhooks/dialer`) vía api-gateway. Hace falta un **dominio público estable** (TLS) apuntando al gateway; no usar Cloudflare quick tunnel ni URLs efímeras en cutover real.

Orden sugerido: smoke mock → tenant de prueba con dialer → comparar pacing/stats → campañas productivas.
