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

- `DIALER_BASE_URL` (HTTPS obligatorio en staging/producción)
- `DIALER_ADMIN_USER`
- `DIALER_ADMIN_PASSWORD`
- `DIALER_DEMO_API_KEY`
- `DIALER_WEBHOOK_HMAC_SECRET`
- `ELEVENLABS_WEBHOOK_SECRET`
- `NOVA_TO_VOICE_TOKEN` / `VOICE_TO_NOVA_TOKEN` distintos
- `NOVA_OPERATOR_ASSERTION_KEY`

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

Antes de habilitar el tenant también se deben aplicar `054-nova-voice-orchestration-policy.sql` y
`055-nova-voice-policy-approval-and-exclusions.sql`, sellar la política vigente, cargar un snapshot completo y no
vencido del registro de exclusión y ejecutar `governance:voice -- verify-cutover`. El runtime falla cerrado si
falta cualquiera de esos controles. Verifique además que no existe ninguna mutación pública `POST /voice/calls` o
`POST /voice/campaigns`.
El único ingreso de despacho vigente es el evento firmado `voice.call.requested.v2` emitido por NOVA Core. Voice
mantiene el consumidor `voice.call.requested` v1 durante la ventana N−1; no existe una ruta pública equivalente.
