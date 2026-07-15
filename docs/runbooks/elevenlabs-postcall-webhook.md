# Webhook ElevenLabs → PULSO (post-call → WhatsApp)

## Flujo
1. Llamada termina (`end_call` o colgado).
2. **Camino A (webhook):** ElevenLabs envía `post_call_transcription` al webhook HTTPS.
3. **Camino B (poller de respaldo):** al hacer dispatch SIP, PULSO vigila la `conversation_id` cada ~5s; al ver `done` tipifica y envía WA aunque el webhook no llegue.
4. PULSO tipifica intención; si el lead pidió WA / está interesado → LIWA flow.
5. Idempotencia por `conversation_id`: webhook y poller no duplican el WA.

## Endpoint Contabo
`/pilot-core/ops/webhooks/elevenlabs/post-call`

Expuesto por túnel Cloudflare quick (`pulso-cf.service` en el host) porque ElevenLabs exige HTTPS y Traefik PULSO publica solo HTTP `:9088`.

## Config ElevenLabs
- Workspace webhook: **PULSO Contabo post-call v2** (HMAC)
- Agents settings: `post_call_webhook_id` apunta a ese webhook
- Eventos: `transcript` (sin audio)
- La URL del webhook **no se puede editar** vía API: si cambia el túnel, hay que **crear un webhook nuevo** y re-bindear `post_call_webhook_id`

## Túnel HTTPS
- Servicio host: `pulso-cf.service` (`cloudflared` → `http://127.0.0.1:9088`)
- Log: `/var/log/pulso-cf.log`

## Poller (respaldo)
- Env: `POST_CALL_POLLER_ENABLED=true` (default)
- Intervalo: `POST_CALL_POLL_INTERVAL_SEC=5`
- Sweep de dispatches SIP pendientes: cada `POST_CALL_SWEEP_INTERVAL_SEC=20`
- Source en `post_calls`: `elevenlabs_poller` vs `elevenlabs_webhook`

## Secretos
- Contabo: `ELEVENLABS_WEBHOOK_SECRET` en `/opt/pulso/.env.contabo`
- Local (gitignored): `.local-secrets-tmp/elevenlabs_webhook.env`

## Importante
Los quick tunnels de Cloudflare **cambian de URL al reiniciar**. Tras reiniciar `pulso-cf`:
1. Leer la nueva URL en `/var/log/pulso-cf.log`
2. Crear webhook nuevo en ElevenLabs con esa URL
3. Actualizar `post_call_webhook_id` en ConvAI settings
4. Poner el nuevo `webhook_secret` en `.env.contabo` y recrear `pilot-core`

Ideal: migrar a un **named tunnel** con dominio fijo.

## Verificación rápida
```bash
# Ping firmado (HMAC t=...,v0=...) → {"ok":true,"ignored":true,"type":"ping"}
# Sin firma válida → 401 webhook_signature
# Tras colgar: fila post_calls con whatsapp_sent=true (source webhook o poller)
```
