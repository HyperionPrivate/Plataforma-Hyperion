# Método de construcción: vertical slice (cosa por cosa)

Este documento formaliza el método de trabajo para NOVA y para cualquier contexto nuevo en Hyperion.
Nada se construye en horizontal. Cada capacidad es un **vertical slice** completo y desplegable que
**empieza por especificar cómo funciona (su contrato)**.

## Plantilla de un vertical slice

1. **Decidir**: ADR corto si toca frontera, seguridad, datos o deploy.
2. **Especificar**: contrato primero (evento Zod o endpoint HTTP), modelo de datos (tabla + owner),
   reglas de dominio. Registrar en `data-ownership.json` y catálogo de eventos.
3. **Migrar**: esquema del contexto (expand), forward-only.
4. **Implementar**: módulo interno con interfaz pública; sin tocar datos de otro owner; efectos
   asíncronos vía outbox en la misma transacción.
5. **Integrar**: inbox/outbox idempotente; síncrono solo con credencial por vínculo (`*_TO_*_TOKEN`).
6. **Probar**: unit, contrato, frontera (`check-boundaries` verde), integración outbox→transporte→inbox
   si aplica.
7. **Observar y proteger**: readiness real, correlation, PII/`data_classification`, mock etiquetado
   si falta credencial.
8. **Entregar**: PR pequeño por slice, CI verde, ownership/baseline/pruebas de límites en el mismo
   cambio. UI con estados obligatorios + `design/QA.md` si aplica.

## Definition of Done por pieza

- [ ] Contrato Zod publicado y versionado en `packages/contracts`
- [ ] Esquema/migración propia del contexto
- [ ] Outbox/inbox idempotente si tiene efectos asíncronos
- [ ] Auth por vínculo (`*_TO_*_TOKEN` + `x-hyperion-caller`)
- [ ] `check-boundaries` verde
- [ ] `data-ownership.json` actualizado
- [ ] Tests unit + frontera + contrato (+ integración si hay evento)
- [ ] `/ready` real (schema_version + dependencias)
- [ ] Observabilidad sin PII
- [ ] Mocks etiquetados (`*_MODE=mock`)
- [ ] UI con estados + QA si aplica
- [ ] PR pequeño con CI verde

## Orden: walking skeleton primero

Cada servicio arranca con:

1. Health/ready
2. Rol PostgreSQL + esquema vacío + `schema_version`
3. Registro en gateway, compose, `data-ownership.json`, CI y `serviceCatalog`
4. Luego capacidades una a una, desplegables de punta a punta

## Gates de CI

- `pnpm check` / `architecture:check`
- `check-boundaries.mjs`
- Identidades Compose (`check-compose-identities.mjs`)
- Secretos sin placeholders en staging/prod
- Autonomy e2e cuando el slice toca eventos durables
