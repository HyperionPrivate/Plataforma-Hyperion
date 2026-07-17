# Voice E2E checklist (Neutral Dialer + ElevenLabs)

Código listo (adapter real + outcome poller). Las llamadas reales requieren **API key + agente Conversational AI + DDI** (Twilio/SIP importado en ElevenLabs).

**Ingesta de outcomes**

| Vía | Rol |
| --- | --- |
| Dialer outcome poller | **Primario** — pacing/estado de llamada vía Neutral Dialer |
| `POST /v1/voice/webhooks/elevenlabs` | **Respaldo tipify** — HMAC (`ELEVENLABS_WEBHOOK_SECRET`); emite `voice.call.completed` si hay `provider_conversation_id` matched |

## Fase A — Key + agentes (sin DDI → sin llamadas)

Bootstrap de agentes NOVA (idempotente):

```bash
node scripts/autonomy/elevenlabs-bootstrap-nova.mjs --write-env
```

Crea/actualiza:

| Agente (ElevenLabs)          | Rol               | Env                                     |
| ---------------------------- | ----------------- | --------------------------------------- |
| Valerie Coopfuturo - Flujo A | Renovación (CDAT) | `ELEVENLABS_AGENT_ID` / `DEMO_AGENT_ID` |
| Valerie Coopfuturo - Flujo B | Reactivación      | `ELEVENLABS_AGENT_ID_B`                 |

También añade voces ES compartidas a la librería (Fernanda / Veronica), ASR `scribe_realtime`, idioma `es`.

Vars dialer en `.env` local (gitignored):

```text
VOICE_MODE=dialer
DIALER_BASE_URL=http://neutral-dialer:8080
DIALER_ADMIN_USER=admin
DIALER_ADMIN_PASSWORD=...
DIALER_DEMO_API_KEY=...
DIALER_WEBHOOK_HMAC_SECRET=...
AUTH_JWT_SECRET=...
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_AGENT_ID_B=...
DEMO_DDI_PHONE_NUMBER_ID=     # vacío hasta importar Twilio/SIP
```

**Bloqueo DDI:** ElevenLabs no vende el número por API. Hay que importar un número Twilio (`sid`+`token`) o SIP trunk con `POST /v1/convai/phone-numbers`, asignarlo al agente (`PATCH …/phone-numbers/{id}` con `agent_id`), y rellenar `DEMO_DDI_PHONE_NUMBER_ID`.

### VoipCentral (Coopfuturo) — procedimiento

Credenciales locales (`.env`, nunca commit):

```text
SIP_TRUNK_ADDRESS=sip.voipcentral.net
SIP_TRUNK_USERNAME=...
SIP_TRUNK_PASSWORD=...
SIP_TRUNK_TRANSPORT=tcp
SIP_SMOKE_DDI_E164=+573110456598
SIP_DDI_E164_LIST=+573110456598,+573110456599,...  # 10 DDIs
```

1. Smoke con **un** DDI (`+573110456598`):

```bash
node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --write-env
```

Eso importa el SIP trunk en ElevenLabs, asigna el número a Flujo A (`ELEVENLABS_AGENT_ID`) y escribe `DEMO_DDI_PHONE_NUMBER_ID`.

2. Tras el primer éxito, lote de los 10:

```bash
node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --all --write-env
```

UI alternativa: Agents → Phone Numbers → Import from SIP trunk (mismo dominio/usuario/password).

No ejecutar `NOVA_SMOKE_REQUIRE_VOICE=1` hasta tener `DEMO_DDI_PHONE_NUMBER_ID` no vacío.

## Fase B — Llamadas (agente + DDI)

1. Importar DDI SIP (script arriba) o confirmar `DEMO_DDI_PHONE_NUMBER_ID` en `.env`.
2. Levantar stack:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dialer.yml --env-file .env up -d --build
```

3. Smoke (destino de prueba controlado; no campaña a los 10 DDI):

```bash
NOVA_SMOKE_TOKEN=... NOVA_SMOKE_TENANT_ID=... NOVA_SMOKE_REQUIRE_VOICE=1 \
  node scripts/autonomy/nova-smoke.e2e.mjs
```

## Aceptación (fase B)

- `POST …/voice/calls` con `contact_id` → `dispatched` + `dialer_call_ref`
- Poller emite `voice.call.completed` correlacionado
- nova-core tipifica lead + encola `whatsapp_reviews` si aplica
- Enrollment pasa `enrolled` → `attempted` → `reached`/`failed`
