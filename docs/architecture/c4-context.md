# C4 — Nivel 1: Contexto del sistema

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Descripción

Coopfuturo PULSO es la plataforma de contactación inteligente para la cooperativa. Orquesta campañas multicanal (voz, WhatsApp, documentos) con compliance, CRM y handoff humano.

## Diagrama de contexto

```mermaid
C4Context
    title Diagrama de contexto — Coopfuturo PULSO

    Person(operador, "Operador / Admin", "Gestiona campañas y revisa resultados")
    Person(asesor, "Asesor LIWA", "Atiende handoffs humanos")
    Person(contacto, "Contacto / Cliente", "Recibe llamadas, WA y envía documentos")

    System(coopfuturo, "Coopfuturo PULSO", "Plataforma de contactación multicanal (fundación arquitectónica)")

    System_Ext(dialer, "Dialer externo", "Voz saliente, ASR, AMD — repo separado")
    System_Ext(liwa, "LIWA / WhatsApp Business", "Canal WhatsApp y handoff comercial")
    System_Ext(coreFin, "Core financiero Coopfuturo", "Verdad de outcome financiero")
    System_Ext(idp, "IdP OIDC", "Identidad federada (pendiente)")
    System_Ext(elevenlabs, "ElevenLabs", "TTS vía Dialer (externo)")

    Rel(operador, coopfuturo, "Administra", "HTTPS + JWT")
    Rel(asesor, liwa, "Atiende casos")
    Rel(contacto, dialer, "Recibe llamadas")
    Rel(contacto, liwa, "Mensajes WA")
    Rel(coopfuturo, dialer, "Orquesta llamadas", "HTTP")
    Rel(coopfuturo, liwa, "Mensajes / handoff", "HTTP (mock)")
    Rel(coopfuturo, coreFin, "Consulta outcomes", "HTTP (mock)")
    Rel(operador, idp, "Autentica")
    Rel(coopfuturo, idp, "Valida JWT")
    Rel(dialer, elevenlabs, "TTS")
```

## Actores

| Actor | Interacción |
|---|---|
| Operador / Admin | UI futura vía gateway; JWT OIDC |
| Contacto / Cliente | Voz (Dialer), WhatsApp (LIWA), documentos |
| Asesor LIWA | Sistema externo LIWA para handoff humano |

## Sistemas externos

| Sistema | Rol | Estado |
|---|---|---|
| Dialer | Telefonía técnica | Contrato OpenAPI TBD |
| LIWA / WABA | WhatsApp | Mock hasta rotación credencial |
| Core financiero | Outcome real | Mock |
| IdP OIDC | Auth | Pendiente configuración |

## Decisiones relacionadas

- [ADR-001](../adr/ADR-001-modular-architecture.md) — Arquitectura modular
- [ADR-003](../adr/ADR-003-external-dialer.md) — Dialer externo
- [ADR-007](../adr/ADR-007-oidc-jwt-auth.md) — OIDC/JWT

## Ownership

Owners de personas: placeholders TBD en [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).
