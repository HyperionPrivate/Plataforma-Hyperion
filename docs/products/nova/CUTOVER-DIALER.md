---
documentType: runbook
status: not-current
owner: nova-voice
issue: HYP-NOVA-013
reviewDue: 2026-09-30
---

# Cutover Dialer (NOVA)

> **No vigente para producción.** Debe revalidarse con la imagen externa exacta del Neutral Dialer, webhook HTTPS,
> rotación de credenciales y smoke del manifiesto NOVA fijado por digest.

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

Los callbacks HMAC del dialer llegan al ingress provider-owned de NOVA en
`POST /v1/voice/webhooks/dialer`, servido por `nova-bff`. Hace falta un **dominio público estable** con TLS
apuntando al puerto loopback del BFF mediante reverse proxy; nunca exponer HTTP directo. El proxy preserva el
cuerpo exacto y `X-Dialer-Signature`, y Voice valida el HMAC sobre esos mismos bytes. No usar Cloudflare quick
tunnel ni URLs efímeras en cutover real.

Orden sugerido: smoke mock → tenant de prueba con dialer → comparar pacing/stats → campañas productivas.
