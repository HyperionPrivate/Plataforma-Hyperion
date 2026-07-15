# Security Policy — Coopfuturo / PULSO

## Reporting a vulnerability

Reporta vulnerabilidades de forma privada a los maintainers de `AdministracionHyperion`.  
No abras issues públicos con detalles explotables, secretos o PII.

Incluye:

- Descripción del impacto
- Pasos de reproducción
- Versión / commit afectado
- Si hay exposición de datos o credenciales

## Secrets

- Nunca commits de `.env`, tokens, API keys, JWKS privados o connection strings con password.
- Desarrollo usa secretos locales no versionados o Docker secrets.
- Staging/production: fail-fast si faltan secretos obligatorios.
- Credenciales expuestas históricamente (p.ej. tokens LIWA en documentos externos) se consideran **comprometidas**: deben rotarse fuera de este repositorio. No reutilizarlas aquí.

## AuthN / AuthZ

- Identity vía OIDC/JWT (issuer, audience, JWKS). No passwords caseras en producción.
- Autorización por rol y tenant.
- Solo `pilot-core` (módulo orchestration) habla con el Dialer externo.

## Data classification

| Clase | Ejemplos | Regla |
|---|---|---|
| Restricted PII | cédula, teléfono, nombre | cifrado/tokenización; auditoría de acceso |
| Confidential | transcripciones, documentos | acceso autorizado; no en eventos analytics |
| Internal | scores, funnel states | permitido en eventos internos tipados |
| Public | health | sin auth |

## Disclosure

Tras corrección, se documentará en `CHANGELOG.md` sin revelar detalles explotables.
