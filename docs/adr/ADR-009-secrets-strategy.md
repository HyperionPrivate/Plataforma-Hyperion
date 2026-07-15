# ADR-009 — Estrategia de secretos

## Estado

Accepted — 2026-07-15

## Contexto

Integraciones con Dialer, LIWA, Core financiero e IdP requieren credenciales. Secretos en repositorio o logs representan riesgo crítico de seguridad.

**Alcance actual:** variables de entorno con placeholders; modo mock para LIWA. **Nunca almacenar secretos reales en el repo.**

## Decisión

1. **Prohibido** commitear secretos reales: tokens, passwords, claves privadas, `.env` con valores productivos.

2. **Fuente de verdad en runtime:** secret manager del entorno (Azure Key Vault, AWS Secrets Manager, HashiCorp Vault, etc.) — elección TBD por `@TBD-platform`.

3. **Desarrollo local:** `.env` gitignored; `.env.example` solo con placeholders y `CHANGE_ME`. Documentación y scripts usan valores ficticios.

4. **Credencial LIWA histórica:**
   - Cualquier token LIWA que haya aparecido en documentación externa se considera **comprometido**.
   - **DEBE rotarse externamente** (fuera de este repositorio) antes de habilitar integración real.
   - Hasta rotación: `LIWA_MODE=mock` obligatorio.
   - Ver [EXTERNAL_BLOCKERS.md](../EXTERNAL_BLOCKERS.md) y [runbooks/secret-rotation.md](../runbooks/secret-rotation.md).

5. Inyección de secretos en CI/CD via OIDC/workload identity; no variables persistidas en logs de pipeline.

6. Escaneo de secretos en pre-commit/CI (gitleaks o equivalente) — fase posterior.

## Consecuencias

- Integraciones reales bloqueadas hasta provisionamiento externo de secretos.
- Rotación periódica es responsabilidad operativa documentada.
- Desarrolladores deben usar mocks/stubs sin credenciales reales.
