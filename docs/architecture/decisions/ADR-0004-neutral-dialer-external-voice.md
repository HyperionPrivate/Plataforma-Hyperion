# ADR-0004: Neutral Dialer v3 como microservicio externo de voz

- Estado: Aceptada
- Fecha: 2026-07-16

## Contexto

Hyperion no tenía capacidad de voz outbound. El piloto Coopfuturo bypassó el Neutral Dialer v3
llamando ElevenLabs SIP directo, perdiendo pacing, reintentos, rotación DDI, AMD y reconciliación.
El dialer (repo propio, Python/FastAPI hexagonal, PostgreSQL durable) ya cumple autonomía: DB propia,
contratos HTTP + webhooks HMAC, JWT, migraciones, anti-SSRF, health/readiness.

## Decisión

1. El **Neutral Dialer v3 permanece fuera del monorepo Hyperion** (despliegue Compose separado u
   overlay). No se reescribe a TypeScript.
2. **`voice-channel-service` es el único cliente autorizado** del dialer dentro de Hyperion.
   Traduce eventos de NOVA a la API del dialer (campañas, contactos, start/pause/cancel, llamada
   individual) y recibe webhooks HMAC. Custodia el JWT del dialer (`VOICE_TO_DIALER_TOKEN` /
   credencial del dialer).
3. El dominio NOVA nunca conoce el transporte: el mismo contrato interno
   (`voice.call.requested` → `voice.call.dispatched` → `voice.call.completed`) cubre:
   - camino principal: dialer → ElevenLabs;
   - modo demo/bajo volumen: ElevenLabs SIP directo detrás del mismo contrato.
4. Companions opcionales (ASR-Api, AMD) se despliegan con el stack del dialer, no dentro de Hyperion.
5. La superficie `needs_reconciliation` del dialer se proyecta al dashboard vía voice-channel.

## Consecuencias

- Hyperion gana voz sin absorber deuda de un stack Python.
- NOVA orquesta por eventos; voice-channel adapta.
- Hay que vigilar el límite single-worker del dialer antes de campañas masivas.
- Webhooks requieren dominio público estable (sin Cloudflare quick tunnel).

## Alternativas descartadas

- Bypass ElevenLabs directo como camino principal (pierde pacing/AMD/reconciliación).
- Ingestar el dialer al monorepo (mezcla runtimes y ownerships sin beneficio).
