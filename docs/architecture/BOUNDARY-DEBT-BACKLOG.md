# Backlog de retiro de deuda de fronteras (fase 7+)

Referencia: [ADR-0005](decisions/ADR-0005-boundary-debt-retirement.md).
NOVA y LUMEN son la plantilla: esquemas propios, sin FKs a `platform.tenants`, sin SQL cruzado.

## Cola ordenada (una pieza por PR)

### Cortes completados: Integration → PULSO/SOFÍA readiness

`integration-service` ya no lee `agenda_settings`, `availability_rules` ni `professionals`. Consume el contrato
`pulsoAgendaReadinessSchema` por el endpoint owner-owned de `pulso-iris-service`, con
`INTEGRATION_TO_PULSO_TOKEN`, timeout de 3 segundos y fallo cerrado `502`. Las tres entradas se retiraron del
baseline. El migrador autónomo de PULSO revoca y verifica esos grants en la base provider-owned; la pila global
congelada conserva los grants históricos únicamente hasta completar el cutover de workloads. La política y su gate
están en
[`pulso-integration-readiness-policy.v1.json`](pulso-integration-readiness-policy.v1.json).

Integration consume además la readiness owner-owned de SOFÍA. El proveedor informa `promptFlowReady` y conserva
compatibilidad N-1 con su señal `ready`; la readiness de dominio de Integration ya no consulta
`platform.agents`, `platform.prompt_flows` ni `platform.schema_migrations`. Agent y Prompt Flow validan ahora el
marker owner-owned `agent_runtime.schema_version`; los otros cuatro runtimes PULSO validan el marker global de
PULSO. El `SELECT` de SOFÍA sobre este último se retiene sólo para imágenes N−1 y permanece abierto en DEBT-027;
ningún runtime actual usa el ledger global como readiness. La API genérica de
compatibilidad todavía existe en `@hyperion/service-runtime` y DEBT-010 registra su retiro sin atribuírsela a
Audit. Las cuatro entradas directas se retiraron del baseline; DEBT-027 mantiene visible el retiro de grants de la
pila global y del marker global legado.

### Corte completado: PULSO → Audit

El historial de citas se obtiene mediante un endpoint interno de `audit-service` autenticado y acotado por
productor, tenant, tipo e identificador de entidad. `pulso-iris-service` valida el contrato de respuesta y falla
cerrado sin fallback SQL. La entrada `pulso-core->audit` y DEBT-017 se retiraron del baseline y del catálogo;
el migrador PULSO revoca el grant en su base autónoma y DEBT-027 conserva visible el cutover de la pila global.

### Corte completado: SOFÍA → Channel runtime

La recuperación de confirmaciones ya no consulta `channel_runtime.outbound_messages`. Si Agent cae después de
encolar y antes de completar el job, el replay reutiliza el `externalMessageId` y la misma idempotency key en las
APIs owner-owned de PULSO y Channel: puede reintentar el enqueue, pero converge en un único outbound lógico. La
entrada `sofia-automation->channel` y DEBT-011 se retiraron; el grant físico histórico permanece inventariado en
DEBT-027 sólo para la pila global congelada, porque la base autónoma ya lo revoca y verifica.

### Corte completado: SOFÍA → PULSO

`sofia-runtime` obtiene pacientes, conversaciones y mensajes por el contrato interno estricto de PULSO. La llamada
remota ocurre fuera de la transacción que reclama el job y el compare-and-set local conserva la exclusión entre
workers. No existe fallback SQL: las siete lecturas cruzadas y DEBT-013 se retiraron del baseline y del catálogo.

### Corte completado: Access → PULSO

La creación de tenants ya no ejecuta lógica PULSO. La migración append-only de Access elimina y verifica la ausencia
de `trg_initialize_agenda_settings`; PULSO inicializa su configuración lazy e idempotentemente dentro de su propio
servicio. El baseline autónomo no contiene el trigger y DEBT-028 quedó retirado.

### Corte completado: cadena provider-owned de PULSO

`@hyperion/pulso-migrations` crea la base lógica, ejecuta el ledger y la versión locales y aplica la matriz de roles
de PULSO sin credenciales ni migraciones de NOVA/LUMEN. La cadena global 001–046 queda congelada sólo como camino de
compatibilidad hasta terminar el cutover.

Esto no equivale a una frontera de datos limpia. El detector procesa cada base lógica como un estado efectivo
independiente y encuentra en `001-pulso-autonomous-baseline.sql` 46 grupos adicionales: 37 FKs hacia las tablas
locales `platform.tenants`/`platform.products`, seis lecturas PL/pgSQL entre owners y tres funciones
`SECURITY DEFINER` de compatibilidad N-1. No están en `temporaryExceptions`: DEBT-001–DEBT-005 cubren las aristas de
FK y DEBT-029–DEBT-031 registran los adaptadores efectivos con owner, issue y vencimiento 2026-10-31.

1. **FKs históricas a `platform.tenants`**
   - Sustituir las 37 FKs del baseline autónomo por identificadores/proyecciones locales mediante
     expand/migrate/contract; no reescribir migraciones aplicadas (checksums).
2. **Adaptadores N-1 dentro del baseline autónomo**
   - Retirar las seis lecturas cruzadas y tres funciones `SECURITY DEFINER` de DEBT-029–DEBT-031 al cerrar los
     escritores v1; las excepciones de la cadena global 038 vencen en la misma fecha, pero son registros distintos.
3. **Retiro de la pila global PULSO**
   - Mover los workloads restantes a la base provider-owned, observar telemetría y retirar grants, roles y el camino
     de migración global conservado por compatibilidad.
4. **Contract del marker SOFÍA**
   - Después de publicar una baseline N−1 por digest y completar el rehearsal current↔N−1, revocar a
     `hyperion_sofia` tanto `USAGE ON SCHEMA pulso_iris` como `SELECT ON pulso_iris.schema_version` mediante una
     migración append-only. Sólo entonces puede cerrarse esa porción de DEBT-027.

## Regla

Cada PR que elimine una violación elimina la entrada correspondiente de
`boundary-baseline.json` en el mismo cambio. `check-boundaries` debe quedar verde
y el conteo del baseline no puede subir.
