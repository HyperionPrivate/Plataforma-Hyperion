---
documentType: runbook
status: draft
owner: platform-operations
issue: HYP-OPS-003
reviewDue: 2026-10-18
---

# Recuperación independiente de Access y Audit

> **Procedimiento preparado, no acreditado en producción.** Los wrappers, manifiestos y drills aislados están activos;
> este runbook seguirá en `draft` hasta conservar evidencia offsite y de restore del entorno aprobado.

Access (`hyperion_access`) y Audit (`hyperion_audit`) son bases lógicas separadas. Cada una tiene migrador, roles de
runtime, ledger, descriptor Compose de operaciones, archivo de entorno y directorio de backups propios. Ningún
procedimiento de este runbook carga migraciones ni credenciales de NOVA, LUMEN o PULSO.

| Provider | Directorio        | Owner restaurado           | Roles runtime                          | Ledger obligatorio                |
| -------- | ----------------- | -------------------------- | -------------------------------------- | --------------------------------- |
| Access   | `backups/access/` | `hyperion_access_migrator` | `hyperion_identity`, `hyperion_tenant` | `access_runtime.migration_ledger` |
| Audit    | `backups/audit/`  | `hyperion_audit_migrator`  | `hyperion_audit`                       | `audit_runtime.migration_ledger`  |

Los wrappers fallan cerrado si el nombre lógico sale de `hyperion_access(_*)` o `hyperion_audit(_*)`, si el archivo
sale del directorio asignado, si el SHA-256 no coincide, si cambia el owner o si la confirmación no es exacta. El
descriptor `*-ops.yml` es una vista `exec` del PostgreSQL ya desplegado; no crea infraestructura.

## Preparación

En el host canónico `/opt/hyperion-platform`, instale solo el archivo del provider que se operará y manténgalo con
modo `0600`:

```bash
cp infra/access-ops.env.example .env.access-ops
cp infra/audit-ops.env.example .env.audit-ops
chmod 0600 .env.access-ops .env.audit-ops
```

No agregue contraseñas de servicio a esos archivos. Docker Compose identifica el contenedor PostgreSQL existente por
el proyecto `hyperion-platform`; `pg_dump` y `pg_restore` usan la identidad administrativa que ya existe dentro del
contenedor.

## Backup Access

```bash
export ACCESS_POSTGRES_DB=hyperion_access
sudo --preserve-env=ACCESS_POSTGRES_DB scripts/ops/access-postgres-backup.sh
```

Conserve como una unidad la salida `BACKUP_FILE`, `BACKUP_SHA256`, `BACKUP_CATALOG_ENTRIES` y el recibo del transporte
offsite. El artefacto resultante se publica como `backups/access/access-<UTC>.dump.gz` con modo `0600`.

## Backup Audit

```bash
export AUDIT_POSTGRES_DB=hyperion_audit
sudo --preserve-env=AUDIT_POSTGRES_DB scripts/ops/audit-postgres-backup.sh
```

El artefacto se publica como `backups/audit/audit-<UTC>.dump.gz`. Una caída de Audit no debe detener productores; el
RPO efectivo también depende de que los outboxes de cada productor conserven los eventos pendientes.

## Restore Access

En un clúster nuevo, ejecute primero **solo** `@hyperion/access-migrations` con
`ACCESS_POSTGRES_ADMIN_URL`, `ACCESS_POSTGRES_DB`, `ACCESS_MIGRATOR_DATABASE_PASSWORD`,
`IDENTITY_DATABASE_PASSWORD` y `TENANT_DATABASE_PASSWORD`. `bootstrap:database` crea las identidades necesarias; no
ejecute migraciones de producto. En un clúster existente, confirme que las tres identidades ya existen y no tienen
sesiones runtime abiertas.

```bash
export ACCESS_RESTORE_ARCHIVE=/opt/hyperion-platform/backups/access/access-<UTC>.dump.gz
export ACCESS_RESTORE_DATABASE=hyperion_access_restore_drill
export ACCESS_RESTORE_SHA256=<sha256-exacto>
export ACCESS_RESTORE_CONFIRM="RESTORE ACCESS hyperion_access_restore_drill SHA256 <sha256-exacto>"
sudo --preserve-env=ACCESS_RESTORE_ARCHIVE,ACCESS_RESTORE_DATABASE,ACCESS_RESTORE_SHA256,ACCESS_RESTORE_CONFIRM \
  scripts/ops/access-postgres-restore.sh
```

Después del restore, ejecute `@hyperion/access-migrations bootstrap:roles` con credenciales nuevas. Valide readiness de
Identity y Tenant, el ledger exacto, una lectura autorizada y la denegación de `CREATE`/`TEMPORARY` para ambos roles
antes de cambiar tráfico. El ledger Access debe contener, sin filas adicionales, `001-access-fresh-baseline.sql`,
`002-access-runtime-role-boundary.sql`, `003-access-tenant-projection.sql` y
`004-access-tenant-lifecycle-integrity.sql`, conservando sus checksums publicados.

La validación del restore también debe acreditar `trg_access_tenant_lifecycle_v1` como `ENABLE ALWAYS` sobre
`platform.tenants` y la función
`access_runtime.enforce_tenant_lifecycle_v1()` con owner `hyperion_access_migrator`, sin `EXECUTE` para `PUBLIC`,
`hyperion_identity` ni `hyperion_tenant`. En la base aislada del drill, una inserción con `updated_at` arbitrario debe
recibir la hora del provider, dos `UPDATE` consecutivos deben devolver marcas estrictamente crecientes y un `DELETE`
debe fallar con SQLSTATE `55000`. No habilite tráfico si alguna de estas pruebas falla: snapshot v1 todavía no tiene
tombstone y el borrado cascada perdería estado y outbox.

## Restore Audit

En un clúster nuevo, ejecute primero **solo** `@hyperion/audit-migrations bootstrap:database` para crear
`hyperion_audit_migrator` y `hyperion_audit`. Luego restaure:

```bash
export AUDIT_RESTORE_ARCHIVE=/opt/hyperion-platform/backups/audit/audit-<UTC>.dump.gz
export AUDIT_RESTORE_DATABASE=hyperion_audit_restore_drill
export AUDIT_RESTORE_SHA256=<sha256-exacto>
export AUDIT_RESTORE_CONFIRM="RESTORE AUDIT hyperion_audit_restore_drill SHA256 <sha256-exacto>"
sudo --preserve-env=AUDIT_RESTORE_ARCHIVE,AUDIT_RESTORE_DATABASE,AUDIT_RESTORE_SHA256,AUDIT_RESTORE_CONFIRM \
  scripts/ops/audit-postgres-restore.sh
```

Rote la contraseña con `@hyperion/audit-migrations bootstrap:roles`, arranque Audit contra la base restaurada y
compruebe inserción idempotente del mismo `event_id`. Después habilite productores y observe el drenaje de sus
outboxes; la unicidad lógica se mantiene en `audit_runtime.inbox_events`.

## Drills aislados

Los siguientes comandos son opt-in. Cada uno crea un proyecto Compose nuevo, ejecuta únicamente el migrador elegido,
genera un dump real de PostgreSQL 16, lo restaura en otra base lógica y compara ledger, tablas, esquemas, dato marcador,
owner y ACL. El cleanup usa exclusivamente las etiquetas del proyecto recién creado.

```bash
pnpm ops:access:postgres:recovery:drill -- \
  --confirm "RUN ISOLATED ACCESS POSTGRES RECOVERY DRILL"

pnpm ops:audit:postgres:recovery:drill -- \
  --confirm "RUN ISOLATED AUDIT POSTGRES RECOVERY DRILL"
```

Los tests sintéticos, que no crean contenedores, se ejecutan con:

```bash
pnpm ops:platform:postgres:recovery:test
```

El resultado del drill declara `scope: postgres-only`. Retención, cifrado, copia offsite y restore en el proveedor de
infraestructura siguen requiriendo evidencia operacional. Objetivos iniciales: backup diario, RPO de 24 horas, RTO de
2 horas y drill trimestral por provider; son objetivos hasta que los recibos reales demuestren lo contrario.
