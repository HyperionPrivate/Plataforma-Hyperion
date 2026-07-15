# ADR-004 — Adaptadores de canal

## Estado

Aceptado — 2026-07-14

## Contexto

El piloto usa voz (Dialer/ElevenLabs) y WhatsApp. Mezclar ambos protocolos en orchestrator o CRM acopla canales al dominio.

## Decisión

- **Voz:** adaptador externo = Dialer (repo aparte), consumido solo por orchestrator.
- **WhatsApp:** microservicio `whatsapp` (este monorepo) normaliza mensajes a eventos (`wa.message.received`).
- CRM habla de `contact_id`, `funnel_state` y tipificaciones, no de payloads WA ni SIP.
- Nuevos canales (SMS, email) serían nuevos adaptadores, no ramas dentro de CRM.

## Auth en el edge

- Traefik / middleware de edge validará JWT en el futuro.
- `identity` es stub para emisión/introspección; **no** hay auth productiva en este scaffold.

## Consecuencias

- Simetría conceptual entre canales.
- Orchestrator orquesta “quiero contactar / continuar flujo”, no “enviar plantilla WA X”.
- Handoff futuro (LIWA) es otro adaptador (`handoff`), no lógica dentro de whatsapp.
