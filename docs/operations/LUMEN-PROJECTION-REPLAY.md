---
documentType: runbook
status: draft
owner: lumen-operations
issue: HYP-LUM-003
reviewDue: 2026-10-31
---

# Reconciliación y replay de proyecciones Access → LUMEN

> **Procedimiento preparado, no acreditado en producción.** Este runbook opera exclusivamente el outbox que Access
> posee para `tenant_snapshot` y `operator_grant`. La proyección `encounter_reference` pertenece a su productor
> PULSO y no se debe fabricar ni reparar desde este comando.

## Invariantes

- La mutación de Access, el evento de outbox y su watermark se confirman en una sola transacción.
- Cuando cambia el payload, el intento de entrega se inserta antes de avanzar el watermark. Un fallo posterior
  revierte ambos cambios y la mutación fuente.
- El replay exacto solo reutiliza la fila `published` que coincide con el watermark actual de su agregado. Conserva
  `event_id`, `aggregate_id`, payload, `event_version`, `source_version` y tenant; no crea un segundo hecho lógico.
  Una repetición sobre esa misma fila no cambia nada porque el primer replay ya la dejó fuera de `published`.
- El replay espera tres minutos desde `published_at`, más que la ventana de deduplicación configurada del stream. No
  es un comando masivo de reconstrucción ni acredita por sí solo la entrega o el cutover del transporte.
- El redrive exige el selector exacto `eventId × tenantId × projectionKind`, solo acepta `dead_letter`, reinicia
  intentos y deja la fila en `queued`. Una repetición o un selector divergente termina con error sin cambiar filas.
- El comando fija y comprueba la frontera completa del rol `hyperion_identity` antes de escribir. Una URL de
  migrador, administrador, otra base o una ACL ampliada falla cerrada.
- `DATABASE_URL` se entrega por entorno. Nunca se pasa en argumentos, se imprime o se conserva en evidencia.

## Preparación

Ejecute desde el checkout exacto del release que produjo el evento. Construya únicamente las dependencias de Access
necesarias para el comando:

```powershell
pnpm --filter @hyperion/access-migrations build
pnpm --filter @hyperion/database build
pnpm --filter @hyperion/identity-service build
$env:DATABASE_URL = "postgresql://hyperion_identity:<runtime-secret>@<access-host>:5432/hyperion_access"
```

Obtenga `event_id`, `tenant_id` y `projection_kind` de telemetría y confirme contra
`access_runtime.lumen_projection_outbox`. No copie un identificador de otro tenant. Registre por separado el error
terminal anterior, la versión fuente y el incidente autorizado; el comando no borra la evidencia externa.

## Reconciliar cambios fuente omitidos

La reconciliación compara tenants, operadores y grants vigentes con el watermark provider-owned. Es acotada,
serializada por transacción e idempotente. Ejecute lotes hasta que `hasMore` sea `false`:

```powershell
pnpm --filter @hyperion/identity-service lumen:projections -- reconcile --limit 100
```

`eventsEnqueued` puede ser cero cuando el payload efectivo no cambió. La reconciliación no reinicia automáticamente
eventos terminales: repetirlos sin decisión operativa anularía el límite de intentos.

## Reencolar un dead letter exacto

Use la confirmación literal y los tres valores comprobados. El ejemplo contiene marcadores, no valores válidos:

```powershell
pnpm --filter @hyperion/identity-service lumen:projections -- redrive `
  --event-id <uuid-evento> `
  --tenant-id <uuid-tenant> `
  --projection tenant_snapshot `
  --confirm "REDRIVE ACCESS LUMEN PROJECTION"
```

Para grants use `--projection operator_grant`. Un resultado válido contiene `status: "queued"`, el mismo
`eventId` y la misma `sourceVersion`. El dispatcher normal HTTP o JetStream reclamará la fila; no inicie un segundo
dispatcher ad hoc.

## Repetir el hecho actual exacto

Use esta operación después de restaurar la base LUMEN o cuando el consumidor perdió un hecho que Access ya marcó
como publicado. Seleccione exactamente el evento actual del agregado; para `operator_grant` hay un evento distinto
por operador y tenant. El ejemplo contiene marcadores:

```powershell
pnpm --filter @hyperion/identity-service lumen:projections -- replay `
  --event-id <uuid-evento-publicado-actual> `
  --tenant-id <uuid-tenant> `
  --projection operator_grant `
  --confirm "REPLAY ACCESS LUMEN PROJECTION"
```

La operación falla cerrada si el evento no está `published`, tiene menos de tres minutos, ya no coincide con el
watermark actual o el selector diverge. El resultado conserva `eventId`, `aggregateId`, `eventType`, `eventVersion`
y `sourceVersion`; la fila queda `retry_scheduled` con intentos reiniciados. Ejecutar de nuevo el mismo comando es
un no-op que la CLI reporta como error, no un segundo replay. LUMEN deduplica el mismo `event_id`; las pruebas
PostgreSQL del consumidor cubren tanto `tenant_snapshot` como `operator_grant`.

## Verificación y cierre

Espere a que la fila alcance `published` y confirme en LUMEN que el inbox/proyección conserva el mismo event id,
tenant y versión. `retry_scheduled` indica una nueva indisponibilidad; `dead_letter` indica que el nuevo presupuesto
de intentos se agotó y exige un incidente nuevo, no un bucle automático.

```powershell
Remove-Item Env:DATABASE_URL
```

No declare recuperada la proyección solo porque el comando devolvió `queued`. La evidencia mínima es: selector
autorizado, valores antes/después que acrediten identidad y payload intactos, salida saneada, estado final
`published`, resultado `duplicate` idempotente del consumidor y ausencia de conflicto de `source_version`.

## Gates focales

```powershell
pnpm --filter @hyperion/identity-service typecheck
pnpm --filter @hyperion/identity-service exec vitest run `
  src/lumen-projections.test.ts `
  src/lumen-projections.redrive.integration.test.ts `
  --no-file-parallelism
```

La integración PostgreSQL se habilita solo con `TEST_ACCESS_FIXTURE_DATABASE_URL` autenticada como
`hyperion_access_migrator`, `TEST_IDENTITY_DATABASE_URL` autenticada como `hyperion_identity` y
`TEST_ACCESS_DATABASE_DISPOSABLE=true`. Ambas URLs deben apuntar a la misma base lógica no llamada `postgres`. La
prueba usa fixtures UUID únicos y deja que se eliminen al destruir esa base: la migración Access 004 prohíbe el hard
delete del tenant y la prueba no lo elude ni amplía permisos. Sin esas variables queda omitida; las pruebas
sintéticas siguen verificando orden outbox→watermark, rollback, selector exacto, confirmación y frontera fail-closed.

La prueba PostgreSQL del consumidor LUMEN requiere por separado sus URLs `TEST_DATABASE_URL` y
`TEST_LUMEN_FIXTURE_DATABASE_URL`. Este runbook no afirma una aceptación end-to-end Access→LUMEN ni una ejecución
productiva mientras esas evidencias de entrega no existan.
