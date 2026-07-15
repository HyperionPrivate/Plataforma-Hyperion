# Contracts changelog

## v1 — 2026-07-14

- Envelope obligatorio: `event_id`, `event_type`, `occurred_at`, `producer`, `correlation_id`, `payload`.
- Eventos iniciales:
  - `contact.imported`
  - `call.requested`
  - `call.completed`
  - `wa.message.received`
  - `lead.qualified`
  - `optout.requested`
- Identificadores canónicos en payloads: `contact_id`, `segment`, `funnel_state`, `dialer_call_id`.

Cambios incompatibles requieren `events/v2/` y entrada aquí.
