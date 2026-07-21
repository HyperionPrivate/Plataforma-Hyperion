---
documentType: runbook
status: not-current
owner: nova-voice
issue: HYP-NOVA-016
reviewDue: 2026-09-30
---

# Voice E2E checklist (Neutral Dialer + ElevenLabs)

> **No vigente para producción.** Solo puede reutilizarse como base de un nuevo ensayo con claves rotadas, webhook
> HTTPS y evidencia ligada al digest del release NOVA.

Código listo (adapter real + outcome poller). Las llamadas reales requieren **API key + agente Conversational AI + DDI** (Twilio/SIP importado en ElevenLabs).

**Ingesta de outcomes**

| Vía                                  | Rol                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Dialer outcome poller                | **Primario** — pacing/estado de llamada vía Neutral Dialer                                                                       |
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
DIALER_BASE_URL=https://dialer.example.internal
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
SIP_SMOKE_DDI_E164=<DDI_E164_CONTROLADO>
SIP_DDI_E164_LIST=<DDI_E164_1>,<DDI_E164_2>,...  # 10 DDIs
```

1. Smoke con **un** DDI controlado (`<DDI_E164_CONTROLADO>`):

```bash
node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --write-env
```

Eso importa el SIP trunk en ElevenLabs, asigna el número a Flujo A (`ELEVENLABS_AGENT_ID`) y escribe `DEMO_DDI_PHONE_NUMBER_ID`.

2. Tras el primer éxito, lote de los 10:

```bash
node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --all --write-env
```

UI alternativa: Agents → Phone Numbers → Import from SIP trunk (mismo dominio/usuario/password).

No ejecutar una prueba con destino real hasta tener `DEMO_DDI_PHONE_NUMBER_ID` no vacío y un número de destino
controlado con consentimiento explícito.

## Fase B — Llamadas (agente + DDI)

1. Importar DDI SIP (script arriba) o confirmar `DEMO_DDI_PHONE_NUMBER_ID` en `.env`.
2. Levantar stack:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.dialer.yml --env-file .env up -d --build
```

3. Smoke (destino de prueba controlado; no campaña a los 10 DDI):

```bash
NOVA_SMOKE_EMAIL=... NOVA_SMOKE_PASSWORD=... NOVA_SMOKE_TENANT_ID=... \
  node scripts/autonomy/nova-smoke.e2e.mjs
```

El smoke inicia sesión por `/v1/auth/login`, conserva sólo las cookies aisladas de NOVA y envía CSRF en mutaciones. No acepta el bearer compartido heredado. También exige `403` para un tenant sin grant y `404` para una ruta LUMEN.
Este smoke acredita autorización y encolado durable; por sí solo no acredita que el proveedor haya completado una
llamada. La evidencia de cutover debe añadir el `call_id`, referencia del proveedor, outcome terminal, correlación y
digest exacto del release, sin incluir PII ni secretos.

4. Genere previamente un UUID de correlación, inclúyalo en el recibo firmado de consentimiento y selle
   `attest-cutover --gate consented_test_call --subject <correlation-uuid>` con el mismo `--scope` de los otros
   cinco gates. La primera llamada autorizada de ese alcance consume esa correlación; después de su resultado
   terminal ejecute `verify-cutover --scope ... --public-key ...`. Un recibo sin llamada terminal real no abre el
   gate, y un resultado `failed` o `needs_reconciliation` tampoco lo satisface.

## Aceptación (fase B)

- `POST …/nova/contacts/:contactId/calls` → autorización Core y estado durable `queued`; Voice despacha sólo desde `voice.call.requested.v2` (mantiene consumo v1 durante N−1)
- Poller emite `voice.call.completed` correlacionado
- nova-core tipifica lead + encola `whatsapp_reviews` si aplica
- Enrollment pasa `enrolled` → `attempted` → `reached`/`failed`
