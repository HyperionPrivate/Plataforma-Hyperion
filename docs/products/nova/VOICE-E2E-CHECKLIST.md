# Voice E2E checklist (Neutral Dialer + ElevenLabs)

Código listo (adapter real + outcome poller). Este checklist se ejecuta cuando haya **API key ElevenLabs válida**.

## 1. Stack

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dialer.yml --env-file .env up -d --build
```

Vars mínimas en `.env`:

```text
VOICE_MODE=dialer
DIALER_BASE_URL=http://neutral-dialer:8080
DIALER_ADMIN_USER=admin
DIALER_ADMIN_PASSWORD=...
DIALER_DEMO_API_KEY=...
DIALER_WEBHOOK_HMAC_SECRET=...
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
```

## 2. Smoke

```bash
NOVA_SMOKE_TOKEN=... NOVA_SMOKE_TENANT_ID=... NOVA_SMOKE_REQUIRE_VOICE=1 \
  node scripts/autonomy/nova-smoke.e2e.mjs
```

## 3. Aceptación

- `POST …/voice/calls` con `contact_id` → `dispatched` + `dialer_call_ref`
- Poller emite `voice.call.completed` correlacionado
- nova-core tipifica lead + encola `whatsapp_reviews` si aplica
- Enrollment pasa `enrolled` → `attempted` → `reached`/`failed`
