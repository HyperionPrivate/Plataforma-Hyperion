---
documentType: runbook
status: draft
owner: lumen-operations
issue: HYP-LUM-002
reviewDue: 2026-10-31
---

# Backup y restore PostgreSQL autónomos de LUMEN

> **Procedimiento preparado, no acreditado en producción.** Los wrappers y sus pruebas fail-closed están activos.
> El runbook solo pasará a `active` después de ejecutar el drill contra una copia aprobada del entorno objetivo,
> conservar su evidencia y validar transporte offsite, RPO/RTO, rollback y alta disponibilidad.

Este procedimiento cubre exclusivamente la base lógica `hyperion_lumen`. LUMEN no persiste el audio temporal en
PostgreSQL: la frontera `tmpfs` se destruye y no forma parte del backup. El uso clínico real continúa prohibido por
[ADR-0002](../architecture/decisions/ADR-0002-lumen-audio-retention.md).

## Invariantes

- La fuente debe llamarse `hyperion_lumen` o pertenecer al namespace de ensayo `hyperion_lumen_*`.
- El owner de toda base restaurada es `hyperion_lumen_migrator`; el único rol runtime es `hyperion_lumen`.
- Los dumps viven en `backups/lumen/lumen-<UTC>.dump.gz` y requieren SHA-256 exacto para restaurarse.
- Los wrappers usan únicamente `infra/docker-compose.lumen-ops.yml` y `.env.lumen-ops`; el descriptor es una vista
  `exec` del PostgreSQL LUMEN existente y no contiene servicios ni secretos NOVA/PULSO/plataforma.
- `PUBLIC` no conserva `CONNECT`, `CREATE` ni `TEMPORARY`. El runtime recibe solo `CONNECT` sobre la base y `USAGE`
  sobre el esquema; no recibe `CREATE` de base/esquema ni acceso al ledger.
- El restore debe conservar exactamente el ledger provider-owned 001–002, versión 40, migración terminal
  `002-lumen-runtime-role.sql`, owner del esquema/objetos y ausencia de esquemas de otras celdas.

En producción, el checkout canónico es `/opt/hyperion-platform`. Scripts, descriptor, archivo `.env.lumen-ops` y
artefactos deben ser `root:root`, no ser enlaces ni hardlinks y no ser escribibles por grupo/otros; el archivo de
entorno y los dumps deben permanecer privados.

## Backup

Prepare `.env.lumen-ops` con la configuración necesaria para localizar el proyecto Compose LUMEN existente. El
wrapper sanea el entorno del proceso antes de delegar al motor compartido y exige una base explícita:

```bash
export LUMEN_POSTGRES_DB=hyperion_lumen
pnpm db:lumen:backup
```

Conserve `BACKUP_FILE`, `BACKUP_DATABASE`, `BACKUP_CATALOG_ENTRIES` y `BACKUP_SHA256` como recibo. Un backup no es
recuperable hasta copiar el artefacto y su digest a un destino offsite aprobado y comprobar retención/lectura.

## Restore controlado

El primer restore de cada release debe usar una base de ensayo, nunca la fuente:

```bash
export LUMEN_RESTORE_ARCHIVE=/opt/hyperion-platform/backups/lumen/lumen-<UTC>.dump.gz
export LUMEN_RESTORE_DATABASE=hyperion_lumen_restore_drill
export LUMEN_RESTORE_SHA256=<sha256-exacto>
export LUMEN_RESTORE_CONFIRM="RESTORE LUMEN hyperion_lumen_restore_drill SHA256 <sha256-exacto>"
pnpm db:lumen:restore
```

El motor termina sesiones de la base destino explícita, la recrea con owner migrador, restaura sin owners del
archivo y reaplica la frontera de base: revoca `PUBLIC`, conserva autoridad del migrador y concede al runtime solo
`CONNECT`. Un restore correcto todavía requiere ejecutar el smoke funcional antes de promover tráfico.

## Drill PostgreSQL aislado

El comando opt-in genera un proyecto Compose nuevo, rechaza cualquier recurso preexistente bajo ese nombre,
construye exclusivamente el migrador LUMEN, crea un marker, ejecuta los wrappers reales y verifica:

- ledger exacto `001-lumen-autonomous-baseline.sql` y `002-lumen-runtime-role.sql` con checksums;
- versión `40 / 002-lumen-runtime-role.sql`;
- igualdad de esquema y marker entre fuente y destino;
- owner de base, esquema, relaciones y funciones `hyperion_lumen_migrator`;
- revocación de `CONNECT/CREATE/TEMPORARY` a `PUBLIC`;
- `CONNECT` real del rol `hyperion_lumen`, lectura de versión, escritura clínica permitida y DDL denegado;
- ausencia de esquemas NOVA/PULSO/plataforma y limpieza exacta del proyecto efímero.

```bash
pnpm ops:lumen:postgres:recovery:drill \
  --confirm "RUN ISOLATED LUMEN POSTGRES RECOVERY DRILL"
```

La salida JSON declara `scope: postgres-only`. Guárdela como artefacto firmado del entorno; el comando local no
acredita por sí solo RPO/RTO productivos, offsite, observabilidad, failover ni rollback de imágenes.

## Rollback de release por digest

Antes de cambiar tráfico, descargue los bundles `published` destino y current. El inventario observado v2 separa
los tres runtimes que se revierten de `lumen-migrations`, que permanece current y cubre database/migration/role
bootstrap. Cada entrada conserva `repositorio@sha256:<digest>`; un tag no sirve como identidad:

```bash
pnpm ops:lumen:rollback:verify -- \
  --rollback-bundle /ruta/release-n-1/ \
  --current-bundle /ruta/release-n/ \
  --observed-images /ruta/observed-images.json \
  --confirm "ROLLBACK LUMEN RUNTIMES <n-1> MANIFEST SHA256 <sha-n-1> KEEP CONTROL PLANE <n> MANIFEST SHA256 <sha-n>"
```

La política histórica v1 se normaliza por `kind`: tres OCI son rollbackables y `lumen-migrations` es forward-only.
El verificador valida `SHA256SUMS`, attestation, provenance y readbacks de ambos bundles, y compara los bytes 001–002
únicamente contra la política current. Rechaza componentes hermanos, inventarios incompletos y digests divergentes.
Sólo emite evidencia `LUMEN_ROLLBACK_*`: no consulta registries, no despliega y no ejecuta el rollback.

## Gates no destructivos

```bash
pnpm ops:lumen:postgres:recovery:test
pnpm ops:lumen:rollback:test
```

Este gate no inicia Docker. Usa un ejecutable simulado para comprobar namespace, perfil, saneamiento de secretos,
SHA-256, confirmación exacta, owner, descriptor ops y SQL de revocación; las pruebas Node validan de forma estática
el contrato de evidencia del drill. El workflow LUMEN lo ejecuta junto a la integración de base lógica.

## Pendientes para activar el runbook

1. Ejecutar y conservar un drill PostgreSQL real en el entorno objetivo.
2. Añadir transporte offsite real, retención, cifrado, alertas y restore desde esa copia.
3. Medir y aprobar RPO/RTO, smoke funcional y rollback por digest de todos los componentes LUMEN.
4. Diseñar HA, observabilidad, rotación de secretos y respuesta a incidentes.
