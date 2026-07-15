# ADR-007 — Autenticación OIDC y JWT

## Estado

Accepted — 2026-07-15

## Contexto

Usuarios internos (operadores, administradores) y futuros clientes API necesitan identidad federada sin credenciales embebidas en el monorepo.

**Alcance actual:** sin IdP configurado; endpoints públicos de health únicamente. Auth productiva pendiente ([EXTERNAL_BLOCKERS.md](../EXTERNAL_BLOCKERS.md)).

## Decisión

1. **OIDC** como protocolo de identidad; tokens **JWT** (access token) validados en el edge (Traefik) y/o en cada unidad desplegable.

2. Validación JWT:
   - Issuer (`iss`) y audience (`aud`) configurables por entorno.
   - JWKS remoto con cache y rotación de claves.
   - Rechazo estricto de tokens expirados, firmados con algoritmo incorrecto o sin claims requeridos.

3. Claims mínimos esperados: `sub`, `iss`, `aud`, `exp`, `tenant_id` (multi-tenant futuro).

4. Rutas `/health`, `/ready` y webhooks firmados por proveedor externo quedan fuera de OIDC con controles alternativos (mTLS, HMAC, IP allowlist).

5. No almacenar refresh tokens en logs ni bases de datos sin cifrado.

## Consecuencias

- Dependencia de IdP externo; indisponibilidad JWKS debe tener fallback cacheado.
- Cada unidad debe compartir librería/middleware de validación JWT para consistencia.
- Configuración IdP es acción externa bloqueante para producción.
