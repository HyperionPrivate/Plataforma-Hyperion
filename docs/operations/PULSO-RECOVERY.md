---
documentType: runbook
status: draft
owner: pulso-operations
issue: HYP-PUL-001
reviewDue: 2026-10-31
---

# Backup y restore autónomos de PULSO

> **Procedimiento acreditado solo para PostgreSQL local.** El drill real descrito abajo valida la base lógica y sus
> guardas de aislamiento, no una recuperación productiva completa. El runbook seguirá en `draft` hasta ensayar
> WhatsApp real, transporte offsite, RPO/RTO, smoke, rollback por digest e imágenes desplegadas en el entorno
> objetivo.

PULSO tiene dos conjuntos recuperables distintos: PostgreSQL `hyperion_pulso` y el volumen de sesiones de WhatsApp.
Los wrappers los operan por separado para evitar que un drill de base toque credenciales de sesión. Un dump
PostgreSQL sin snapshot consistente de WhatsApp **no es un backup completo de PULSO**.

## Invariantes PostgreSQL

- La fuente debe llamarse `hyperion_pulso` o pertenecer al namespace de ensayo `hyperion_pulso_*`.
- El owner de toda base restaurada es `hyperion_pulso_migrator`.
- El catálogo efectivo contiene únicamente las migraciones provider-owned `001-pulso-autonomous-baseline.sql`,
  `002-pulso-runtime-roles.sql`, `003-sofia-readiness-marker.sql`,
  `004-access-channel-tenant-projection.sql`, `005-access-iris-tenant-projection.sql`,
  `006-access-sofia-tenant-projection.sql` y `007-access-integration-tenant-projection.sql`, con versión global
  terminal 7 y marker local SOFÍA versión 2 en
  `agent_runtime.schema_version`.
- Los cinco roles runtime son `hyperion_pulso`, `hyperion_sofia`, `hyperion_knowledge`, `hyperion_integration` y
  `hyperion_channel`; ninguno recibe DDL ni acceso al ledger.
- Los dumps viven en `backups/pulso/pulso-<UTC>.dump.gz` y el restore exige su SHA-256 exacto y confirmación
  destructiva literal.
- Los wrappers usan solo `infra/docker-compose.pulso-ops.yml` y `.env.pulso-ops`; rechazan overrides de routing
  Docker y no descubren recursos de otras celdas.

En producción, el checkout canónico es `/opt/hyperion-platform`. Scripts, descriptor, archivo `.env.pulso-ops`,
catálogo de imágenes y artefactos deben ser `root:root`, no ser enlaces ni hardlinks y no ser escribibles por
grupo u otros. El archivo de entorno y los dumps deben permanecer privados.

## Backup y restore PostgreSQL

Prepare `.env.pulso-ops` a partir de `infra/pulso-ops.env.example` y apunte al proyecto PULSO existente. Conserve
todos los campos `BACKUP_*` emitidos por el wrapper:

```bash
export PULSO_POSTGRES_DB=hyperion_pulso
pnpm db:pulso:backup
```

El primer restore de cada release debe usar una base de ensayo:

```bash
export PULSO_RESTORE_ARCHIVE=/opt/hyperion-platform/backups/pulso/pulso-<UTC>.dump.gz
export PULSO_RESTORE_DATABASE=hyperion_pulso_restore_drill
export PULSO_RESTORE_SHA256=<sha256-exacto>
export PULSO_RESTORE_CONFIRM="RESTORE PULSO hyperion_pulso_restore_drill SHA256 <sha256-exacto>"
pnpm db:pulso:restore
```

Después del restore, ejecute de nuevo migraciones y bootstrap de roles contra la base restaurada. Deben omitir
exactamente 001–004, conservar la versión global 4 y el marker SOFÍA local 1, y reproducir schema, ownership y ACL
antes del smoke funcional.

## Snapshot separado de sesiones WhatsApp

El snapshot opera exclusivamente el volumen Compose `hyperion-pulso_pulso_whatsapp_sessions`. Antes de exportar,
detenga `whatsapp-channel-service`; antes de restaurar, elimine además todo contenedor que todavía referencie el
volumen. El helper debe existir localmente y coincidir con el catálogo versionado
`infra/pulso-whatsapp-snapshot-images.v1.txt`:

```text
alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
```

El script usa `--pull=never`, red deshabilitada, filesystem de helper read-only, capabilities mínimas y un límite de
256 MiB. El export sella archive, inventario y bundle; conserve las tres salidas SHA-256:

```bash
export PULSO_WHATSAPP_SNAPSHOT_IMAGE=alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
pnpm whatsapp:pulso:snapshot
```

El comando siguiente documenta la interfaz prevista, pero este runbook `draft` **todavía no autoriza un restore
productivo**. El script valida primero una copia privada, conserva una versión anterior durante la promoción y
compara el inventario vivo después del restore:

```bash
export PULSO_WHATSAPP_SNAPSHOT_DIRECTORY=/opt/hyperion-platform/backups/pulso/whatsapp-sessions/pulso-whatsapp-sessions-<UTC>
export PULSO_WHATSAPP_ARCHIVE_SHA256=<sha256-archive>
export PULSO_WHATSAPP_BUNDLE_SHA256=<sha256-bundle>
export PULSO_WHATSAPP_RESTORE_CONFIRM="RESTORE PULSO WHATSAPP hyperion-pulso/hyperion-pulso_pulso_whatsapp_sessions BUNDLE SHA256 <sha256-bundle>"
pnpm whatsapp:pulso:restore
```

Estas guardas y el hook simulado están probados, pero **no se ejecutó todavía un export/restore contra sesiones
WhatsApp reales**. El drill PostgreSQL no monta ni elimina ese volumen.

### Drill Docker sintético y `restore-as` aislado

El wrapper conserva la identidad de origen (`project` y `volume`) dentro del bundle. Únicamente con
`PULSO_OPS_TEST_MODE=1` puede restaurar ese bundle en un segundo volumen mediante
`PULSO_WHATSAPP_RESTORE_TARGET_PROJECT` y `PULSO_WHATSAPP_RESTORE_TARGET_VOLUME`. Ambos destinos deben pertenecer
al namespace `hyperion-pulso-whatsapp-test-*`, tener las labels Compose exactas y ser distintos de la fuente.
Producción rechaza estas variables antes de invocar Docker; el restore productivo continúa limitado a
`hyperion-pulso/hyperion-pulso_pulso_whatsapp_sessions`.

La promoción conserva `.hyperion-restore-previous` hasta comparar el inventario vivo. Un lock transaccional
identificado registra las fases `extracting`, `archiving`, `promoting` y `prepared`; permite que el proceso host
distinga su propia transacción y arme el rollback antes de la primera mutación. Un fallo parcial de rollback deja
la copia restante y el lock para recuperación manual, sin volver a ejecutar una secuencia que podría borrar
archivos ya repuestos. Solo después de una igualdad exacta se elimina el estado anterior. El volumen debe ser
`local`, de scope `local` y sin opciones de driver; NFS, plugins y bind volumes quedan rechazados.

Estas medidas no constituyen todavía un fence de mantenimiento: Docker permite que otro contenedor monte el
volumen después del último `ps`, y el lock solo coordina instancias de este wrapper. Tampoco hay validación
semántica: el inventario prueba bytes de archivos, no directorios vacíos, modos, apertura Baileys, descifrado del
spool, coherencia con PostgreSQL ni smoke con el proveedor. Hasta disponer de un quiesce/fence del orquestador y
de esas comprobaciones, el restore productivo continúa **bloqueado y no autorizado**.

Existe un runner opt-in para probar este camino con Docker real sin leer sesiones existentes:

```bash
export HYPERION_RUN_REAL_PULSO_WHATSAPP_DRILL=1
export PULSO_WHATSAPP_SNAPSHOT_IMAGE=alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
pnpm ops:pulso:whatsapp:recovery:drill \
  --confirm "RUN ISOLATED PULSO WHATSAPP RECOVERY DRILL"
```

El runner no hace pull. Sella el endpoint Docker local, exige que la imagen ya exista, crea dos proyectos y
volúmenes aleatorios etiquetados, escribe únicamente un fixture con forma Baileys y una marca de spool no sensible,
exporta la fuente, la muta, ejecuta `restore-as` sobre el segundo volumen, compara inventarios y elimina solo los
recursos cuyo nombre y labels coinciden con la operación. También compara el censo Docker antes y
después en cuanto a contenedores, imágenes, redes y volúmenes visibles (IDs/nombres y referencias básicas); este
censo detecta altas o bajas de recursos, no cambios de configuración ni contenido dentro de recursos preexistentes.
Las pruebas incluidas en `pnpm backup:test` son mocks y unitarias: **no activan este runner**.

A fecha de esta revisión el drill Docker anterior no se ha ejecutado: el host local no tiene la imagen helper ni
el volumen PULSO standalone. Las pruebas extraen y ejecutan el cuerpo exacto del rollback por las cuatro fases sobre
un directorio privado, e inyectan fallos de `mv`, `rm` y `sync`; siguen sin probar esos fallos dentro del contenedor,
una caída real del daemon ni `SIGKILL`. Incluso cuando el drill pase, su evidencia declarará
`synthetic-whatsapp-volume-only`; no prueba credenciales WhatsApp reales, descifrado de spool con la clave desplegada,
coherencia con PostgreSQL, offsite, quiesce productivo, smoke del proveedor ni RPO/RTO.

El cleanup normal y de excepciones valida nombres, labels, driver y censo de recursos. El runner difiere `SIGINT` y
`SIGTERM` a checkpoints, limita la duración de los comandos y ejecuta el mismo cleanup idempotente en el camino
normal y en `finally`. `SIGKILL` no es interceptable y todavía puede dejar recursos **sintéticos** etiquetados para
limpieza manual; nunca debe registrarse `cleanupVerified: true` en ese caso. Este riesgo es otro motivo para no
autorizar el drill ni el restore como operación desatendida.

## Drill PostgreSQL aislado y evidencia 2026-07-18

El comando opt-in crea un proyecto Compose aleatorio, construye solo el migrador PULSO, inserta un marker, ejecuta
los wrappers productivos y restaura en `hyperion_pulso_restore_drill`:

```bash
pnpm ops:pulso:postgres:recovery:drill \
  --confirm "RUN ISOLATED PULSO POSTGRES RECOVERY DRILL"
```

El rerun final terminó correctamente con esta evidencia reproducible:

- operación UTC: `20260718T104147Z`;
- proyecto: `hyperion-pulso-recovery-acceptance-20260718t104147z-a2fcaec0`;
- endpoint Docker sellado: `2e1a13b5c38007e19366225454c425eb89626875521ad4eddc04f1b533aa4908`;
- backup: `e6838022deb43a2d446ae224c733b2dbe9005b166a7c07c7c794885c146ef4c1`;
- schema: `d64f188f4147ba7d9c2f37266bad7e194373c9731e9a1efb6174048b9cef2cce`;
- ledger: `326059ecb817de1d06740c02144e3a3a8a92fa33d62fc5505105266df053e31f`;
- ACL y estados runtime: `aa04afa9c13ed5a78a583b38a40334e07b28e32e6408c8250d3bff3b383f3e7f`;
- marker: `d9861eb1c5cb00bfa611f663271ff7e5df1fe700a9c1c684fc56a2f16d22be2f`.

Este resultado es evidencia **histórica** de la clausura anterior y no acredita todavía la migración 003 ni el
marker SOFÍA local. Declaró `scope: postgres-only`, migraciones 001–002/version 2, cinco roles runtime, bootstrap de cinco
roles, base fuente eliminada antes de validar el restore, privilegios públicos revocados,
`whatsappSessionsIncluded: false` y `cleanupVerified: true`. El inventario Docker preexistente quedó idéntico:
17 contenedores antes y 17 después, por ID e imagen.

### Evidencia histórica v3 — operación UTC 2026-07-19

El drill v3 se repitió desde el worktree federado y su recibo completo se conserva como antecedente histórico en
[`pulso-postgres-recovery-20260719.json`](../evidence/pulso-postgres-recovery-20260719.json). La operación
`20260719T043724Z` validó:

- migraciones 001–003, versión global 3 y marker SOFÍA local 1;
- restore cuyo owner es `hyperion_pulso_migrator` y posterior rerun skip-only de las tres migraciones;
- cinco roles runtime, ACL exactas y privilegios de base para `PUBLIC` revocados;
- hashes separados de backup, esquema, ledger, ACL y markers;
- eliminación de la base fuente antes de validar el restore y cleanup exacto del proyecto, imágenes, red y volumen.

Los cinco contenedores preexistentes conservaron sus IDs tras el cleanup. El recibo identifica expresamente un
worktree no comprometido: el SHA de Git por sí solo no reproduce sus bytes. El alcance sigue siendo sólo
PostgreSQL; no acredita sesiones WhatsApp, restore offsite, cutover productivo ni una imagen N−1 publicada por
digest. Este recibo ya no representa la clausura current: fue reemplazado por la evidencia v4 siguiente.

La trazabilidad incluye un primer intento que **falló de forma segura**: una sonda de privilegio forbidden hacía un
lookup por nombre que no era visible para el runtime restaurado. El proceso limpió únicamente su proyecto y también
preservó 17/17 recursos preexistentes. La sonda se corrigió para resolver por OID mediante `pg_catalog`; el gate no
destructivo terminó 14/14 y el rerun final anterior pasó. Ese fallo no se cuenta como evidencia de restore exitoso.

### Evidencia current v4 — operación UTC 2026-07-19

El recibo current completo está en
[`pulso-postgres-recovery-20260719-v4.json`](../evidence/pulso-postgres-recovery-20260719-v4.json). La operación
`20260719T055031Z` ejecutó backup y restore PostgreSQL aislados desde el worktree federado y acreditó:

- las migraciones provider-owned 001–004 y el rerun skip-only exacto de las cuatro;
- el marker global `7/007-access-integration-tenant-projection.sql` y el marker local SOFÍA
  `2/006-access-sofia-tenant-projection.sql`;
- restore con owner `hyperion_pulso_migrator`, cinco roles runtime, bootstrap de cinco roles, ACL exactas y
  privilegios públicos de base revocados;
- un canario de recuperación preservado byte a byte: fuente y restore comparten SHA-256
  `e37682d6ff740a3caec854d70ce5486a6a02f5a4dffcbc6ba43f817a36337302`;
- inventario Docker de 18 recursos tanto antes como después del drill, con SHA-256 idéntico
  `d488277c44f01783f02955c822bb39f3922f4e02cd935c71fc550d37c2ddc9f9` y
  `preexistingResourcesPreserved: true`;
- eliminación de la base fuente antes de validar el restore y `cleanupVerified: true` para los recursos aislados
  creados por la operación.

El recibo sella además la clausura de 287 archivos, los cuatro SQL y las fuentes de los comandos; declara
`workingTreeIncluded: true`, por lo que el commit por sí solo no reproduce esos bytes. Su alcance continúa siendo
`postgres-only` y `whatsappSessionsIncluded: false`: no acredita sesiones WhatsApp, offsite, RPO/RTO, cutover,
smoke productivo, rollback desplegado, publicación OCI ni una imagen N−1 publicada por digest.

## Rollback de release por digest

Descargue del GitHub Release el bundle PULSO destino y el bundle current. Genere un inventario v2 con ocho
`rollbackImages` de runtime y un `forwardOnlyImages.pulso-migrations` tomado del bundle current; las tres entradas
Compose database-bootstrap/migrations/role-bootstrap usan esa misma imagen y nunca se revierten. Use sólo digests:

```bash
pnpm ops:pulso:rollback:verify -- \
  --rollback-bundle /ruta/release-n-1/ \
  --current-bundle /ruta/release-n/ \
  --observed-images /ruta/observed-images.json \
  --confirm "ROLLBACK PULSO RUNTIMES <n-1> MANIFEST SHA256 <sha-n-1> KEEP CONTROL PLANE <n> MANIFEST SHA256 <sha-n>"
```

La política v2 fija explícitamente los runtimes rollbackables, `pulso-migrations` forward-only y los SHA-256 de las
migraciones current. Los borradores con `imagesVerified: false` no sustituyen bundles publicados. Cada bundle debe
incluir manifiesto, inventarios, readbacks OCI/npm, attestation y `SHA256SUMS`; cambiar sólo el manifiesto y reescribir
el checksum local falla contra la attestation. Un tag, componente ajeno, inventario parcial, digest divergente o SQL
extra/modificado falla antes de emitir evidencia. El verificador no accede al registry ni cambia despliegues/tráfico.

El verificador compara el directorio SQL sólo con la política del bundle current. La política histórica `1.1.0`
permanece inmutable y se normaliza por `kind`, por lo que su `pulso-migrations` nunca se convierte en target N−1.
El rollback histórico exige ambos bundles publicados y el recibo de descarga/readback del release; no existe aún
evidencia de publicación ni rehearsal real de imágenes PULSO 1.1 en este repositorio.

## Gates y límites de aceptación

```bash
pnpm ops:pulso:postgres:recovery:test
pnpm ops:pulso:rollback:test
pnpm backup:test
```

Los gates validan wrappers, aislamiento, checksums, confirmaciones, namespace, catálogo PostgreSQL y snapshot
WhatsApp simulado. No miden recuperación desde offsite ni RPO/RTO, no ejecutan un rollback de release, no verifican
imágenes publicadas y no sustituyen un smoke de la celda completa restaurada.

## Pendientes para activar el runbook

1. Implementar un fence del orquestador que impida nuevos mounts y ejecutar el backup coordinado de PostgreSQL y
   sesiones WhatsApp reales con una ventana de quiesce aprobada.
2. Copiar ambos artefactos a almacenamiento offsite cifrado y restaurarlos desde esa copia.
3. Validar apertura Baileys, descifrado del spool y coherencia PostgreSQL; inyectar caída del daemon, señales y fallos
   parciales de filesystem sin perder la copia anterior.
4. Medir y aprobar RPO/RTO, retención, alertas, smoke y rollback por digest de todas las imágenes PULSO.
5. Repetir el drill contra una copia del entorno objetivo y conservar evidencia firmada fuera del checkout.
