# ADR-008 — Autenticación service-to-service

## Estado

Accepted — 2026-07-15

## Contexto

Las unidades desplegables se invocan entre sí (HTTP síncrono) y consumen eventos (asíncrono). Las llamadas machine-to-machine no deben reutilizar tokens de usuario ni confiar en red plana.

**Alcance actual:** comunicación interna sin auth implementada; red Docker aislada en local.

## Decisión

1. **HTTP interno:** cada unidad presenta credencial de servicio (Bearer token de client credentials OIDC o JWT de servicio emitido por IdP interno).

2. **Principio de least privilege:** un servicio solo recibe scopes/roles para los endpoints que consume. Ejemplo: `whatsapp-adapter` no puede escribir en APIs de `handoff-liwa`.

3. **Eventos (Redis Streams):** autenticación a nivel Redis (ACL/password); autorización lógica en consumidor via schema y `tenant_id` en envelope.

4. **Dialer y LIWA:** tokens dedicados por integración; nunca compartidos entre unidades (ver [ADR-003](ADR-003-external-dialer.md), [ADR-009](ADR-009-secrets-strategy.md)).

5. Rotación de credenciales de servicio documentada en [runbooks/secret-rotation.md](../runbooks/secret-rotation.md).

6. mTLS entre unidades es opción futura para entornos regulados; no requisito del piloto local.

## Consecuencias

- Complejidad adicional en bootstrap local (tokens de dev en `.env.example` con placeholders).
- Auditable quién (qué servicio) invocó qué recurso.
- Fallos de auth entre servicios deben aparecer en observabilidad (ver [ADR-010](ADR-010-observability.md)).
