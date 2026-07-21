---
documentType: runbook
status: draft
owner: nova-operations
issue: HYP-NOVA-012
reviewDue: 2026-10-17
---

# Backup, restore y rollback autónomos de NOVA

> **Procedimiento preparado, pendiente de acreditación productiva.** Los gates y simulaciones están activos, pero el
> runbook pasará a `active` únicamente después de un drill real contra el transporte MinIO/S3 aprobado y un manifiesto
> NOVA publicado. Hasta entonces los objetivos RPO/RTO de abajo no están acreditados.

Este runbook cubre el conjunto recuperable de NOVA: su base lógica PostgreSQL y los objetos de
`documents-service`. Un dump PostgreSQL sin snapshot e inventario de `DOCUMENTS_S3_BUCKET` **no es un backup
válido de NOVA**. Voice, LIWA y Neutral Dialer no almacenan aquí datos recuperables propios; sus credenciales y
configuración se restauran desde el secret store del entorno.

## Invariantes

- Base fuente explícita `hyperion_nova` (o un nombre de ensayo bajo `hyperion_nova_*`).
- Owner de restore fijo: `hyperion_nova_migrator`.
- Dump exclusivo en `backups/nova/nova-<UTC>.dump.gz`; los objetos viven en
  `backups/nova/documents/nova-documents-<mismo UTC>/`.
- Compose exclusivo `infra/docker-compose.nova-ops.yml` y archivo local `.env.nova-ops` con modo `0600`.
- Los wrappers limpian el entorno: el proceso PostgreSQL no recibe secretos LUMEN/PULSO y el transporte de
  objetos solo recibe `DOCUMENTS_S3_*`.
- Todo restore exige SHA-256 esperados y una confirmación destructiva exacta.
- Los writes de Documents permanecen congelados durante cada ventana consistente. Si no existe un mecanismo
  aprobado para congelar/descongelar, no se inicia el procedimiento.

En producción el checkout canónico es `/opt/hyperion-platform`; repositorio, scripts, Compose, transporte y
artefactos deben pertenecer a `root:root`, no ser enlaces y no ser escribibles por grupo/otros. Ejecute los comandos
como root desde ese directorio.

## Adaptador obligatorio para MinIO/S3

`scripts/ops/nova-documents-snapshot.sh` falla cerrado si no recibe un ejecutable absoluto en
`NOVA_DOCUMENTS_TRANSPORT_COMMAND` o si falta `DOCUMENTS_S3_BUCKET`. El ejecutable es infraestructura del entorno,
no un mock versionado. Debe implementar:

```text
<transport> export    <bucket> <snapshot-ref-output> <inventory-output>
<transport> restore   <bucket> <snapshot-ref-input>  <inventory-input>
<transport> inventory <bucket> <inventory-output>
```

`export` puede crear un snapshot inmutable del proveedor o copiar el bucket completo a almacenamiento offsite. El
primer archivo contiene una única referencia opaca. El inventario es TSV, ordenado y sin duplicados:

```text
<sha256-del-objeto>\t<bytes>\t<key-UTF-8-percent-encoded>
```

El adaptador debe esperar la consistencia del proveedor antes de retornar. Tras `restore`, el wrapper vuelve a pedir
el inventario al bucket restaurado y exige igualdad byte a byte. El snapshot, inventario, bucket, conteo y bytes se
sellan juntos mediante `DOCUMENTS_BUNDLE_SHA256`.

## Backup consistente

1. Genere un `operationId` UTC (`YYYYMMDDTHHMMSSZ`) y cree
   `backups/nova/drills/<operationId>/` con modo `0700`.
2. Congele writes de Documents mediante el control plane aprobado. Guarde su recibo no secreto como
   `backup-01-documents-writes-frozen.receipt`.
3. Exporte PostgreSQL y guarde stdout como recibo:

   ```bash
   export NOVA_POSTGRES_DB=hyperion_nova
   scripts/ops/nova-postgres-backup.sh | tee "backups/nova/drills/<operationId>/backup-02-postgres-exported.receipt"
   ```

   El timestamp de `BACKUP_FILE` es el `operationId` normativo. Si difiere del valor preparado, use el valor real y
   renombre únicamente el directorio de evidencias todavía vacío; nunca renombre el dump.

4. Con el mismo timestamp, exporte el bucket y guarde stdout:

   ```bash
   export NOVA_DOCUMENTS_SNAPSHOT_TIMESTAMP=<operationId>
   scripts/ops/nova-documents-snapshot.sh export | tee "backups/nova/drills/<operationId>/backup-03-documents-exported.receipt"
   ```

5. Descongele writes y guarde el recibo como `backup-04-documents-writes-unfrozen.receipt`. Un fallo previo también
   obliga a ejecutar y registrar este paso; no se acepta un snapshot parcial.
6. Calcule SHA-256 de cada recibo y de ambos artefactos. Registre tiempos UTC estrictamente crecientes en
   `evidence.json` según el contrato validado por `scripts/ops/verify-nova-recovery-evidence.mjs`.

## Restore drill

Restaure en una base `hyperion_nova_restore_drill`; nunca use producción como primer ensayo.

1. Congele writes y registre `restore-01-documents-writes-frozen.receipt`.
2. Restaure objetos **antes** de publicar metadatos PostgreSQL. Use los tres hashes reportados por el export y la
   confirmación exacta mostrada aquí:

   ```bash
   export NOVA_DOCUMENTS_SNAPSHOT_DIRECTORY=/opt/hyperion-platform/backups/nova/documents/nova-documents-<operationId>
   export NOVA_DOCUMENTS_SNAPSHOT_SHA256=<sha256-snapshot-ref>
   export NOVA_DOCUMENTS_INVENTORY_SHA256=<sha256-inventory>
   export NOVA_DOCUMENTS_BUNDLE_SHA256=<sha256-bundle>
   export NOVA_DOCUMENTS_RESTORE_CONFIRM="RESTORE NOVA DOCUMENTS <bucket> BUNDLE SHA256 <sha256-bundle>"
   scripts/ops/nova-documents-snapshot.sh restore | tee "backups/nova/drills/<operationId>/restore-02-documents-restored-and-inventory-verified.receipt"
   ```

3. Restaure PostgreSQL con owner fijo y confirmación exacta:

   ```bash
   export NOVA_RESTORE_ARCHIVE=/opt/hyperion-platform/backups/nova/nova-<operationId>.dump.gz
   export NOVA_RESTORE_DATABASE=hyperion_nova_restore_drill
   export NOVA_RESTORE_SHA256=<sha256-dump>
   export NOVA_RESTORE_CONFIRM="RESTORE NOVA hyperion_nova_restore_drill SHA256 <sha256-dump>"
   scripts/ops/nova-postgres-restore.sh | tee "backups/nova/drills/<operationId>/restore-03-postgres-restored.receipt"
   ```

4. Arranque NOVA contra la base y bucket restaurados; ejecute readiness y el smoke funcional sin LUMEN/PULSO.
   Registre `restore-04-nova-smoke-passed.receipt`.
5. Descongele writes solo después del smoke y registre `restore-05-documents-writes-unfrozen.receipt`.
6. Complete `evidence.json` y verifique archivos, hashes, conteos, orden y duración:

   ```bash
   node scripts/ops/verify-nova-recovery-evidence.mjs --evidence "backups/nova/drills/<operationId>/evidence.json"
   ```

El gate exige exactamente este orden de backup y restore; todos los recibos deben ser archivos regulares únicos
dentro del directorio del drill y sus SHA-256 deben coincidir.

## Rollback de release por digest

Descargue del GitHub Release tanto el bundle NOVA destino como el bundle current. Genere `observed-images.json` v2
con `rollbackImages` para los siete runtimes destino y `forwardOnlyImages` para `nova-migrations` current; tags no
son evidencia. Verifique antes de cambiar tráfico:

```bash
pnpm ops:nova:rollback:verify -- \
  --rollback-bundle /ruta/release-n-1/ \
  --current-bundle /ruta/release-n/ \
  --observed-images /ruta/observed-images.json \
  --confirm "ROLLBACK NOVA RUNTIMES <n-1> MANIFEST SHA256 <sha-n-1> KEEP CONTROL PLANE <n> MANIFEST SHA256 <sha-n>"
```

El verificador valida los dos bundles completos, sus `SHA256SUMS`, attestation, provenance y readbacks; rechaza
manifests draft, componentes faltantes/adicionales, tags y cualquier digest distinto. La política histórica v1 se
normaliza para que `nova-migrations` sea control plane forward-only, y sólo su política current se compara con las
migraciones 047–054 del checkout. Mantenga database-bootstrap, migrador y role-bootstrap current. Adjunte las
salidas `NOVA_ROLLBACK_*` al drill y ejecute smoke; el comando es offline y no cambia imágenes ni tráfico.

## RPO, RTO y frecuencia

| Objetivo operativo NOVA | Umbral inicial | Evidencia obligatoria                                                                                        |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| RPO                     | 24 h           | Backup coordinado PostgreSQL + Documents offsite exitoso; alerta si la última evidencia válida supera 24 h.  |
| RTO                     | 2 h            | Restore completo a entorno de ensayo, inventario de objetos idéntico, migraciones/roles y smoke NOVA verdes. |

Estos umbrales son objetivos, no resultados acreditados por CI. Ejecute backup diario y un restore drill al menos
trimestral. El verificador reporta `NOVA_RECOVERY_BACKUP_DURATION_SECONDS` y
`NOVA_RECOVERY_RESTORE_DURATION_SECONDS`; registre los valores reales por entorno y abra incidente si exceden el
objetivo. Revise además retención, cifrado, lifecycle e independencia física del snapshot en el proveedor.

## Gates locales y CI

`pnpm backup:test` prueba export/restore PostgreSQL, export/restore/inventario Documents, aislamiento de secretos,
confirmaciones destructivas, evidencia coordinada y rollback por digest. Es una prueba del procedimiento y sus
guardas; no reemplaza el drill contra PostgreSQL y MinIO/S3 reales.

El ensayo opt-in siguiente sí crea un proyecto Docker nuevo, ejecuta PostgreSQL 16 y los migradores NOVA reales,
publica un dump mediante los wrappers productivos, lo restaura en `hyperion_nova_restore_drill` y compara marcador,
ledger 047–054, esquema y owner. Falla cerrado si encuentra cualquier contenedor, red, volumen o imagen con el mismo
nombre de proyecto y elimina únicamente los recursos que acaba de crear:

```bash
pnpm ops:nova:postgres:recovery:drill \
  --confirm "RUN ISOLATED NOVA POSTGRES RECOVERY DRILL"
```

Su resultado declara expresamente `scope: postgres-only`: no acredita el backup coordinado de NOVA ni RPO/RTO hasta
que se ejecute también el transporte MinIO/S3 real, el quiesce de Documents y el smoke de la celda restaurada.
