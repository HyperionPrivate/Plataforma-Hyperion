---
documentType: runbook
status: not-current
owner: platform-operations
issue: HYP-OPS-002
reviewDue: 2026-09-30
---

# Offsite backup copy — interface stub

> **No vigente como procedimiento de recuperación.** Sigue siendo una interfaz fail-closed y no acredita destino,
> retención, restore ni RPO/RTO de ningún producto.

Hyperion versiona el dump local (`scripts/ops/postgres-backup.sh`) y la
restauración controlada (`scripts/ops/postgres-restore.sh`). **La copia offsite
no vive en este repositorio**: requiere infraestructura externa al VPS
(objeto S3/GCS, disco en otro host, o appliance de backup).

## Contrato esperado del operador

1. Tras un `postgres-backup.sh` exitoso, copiar el artefacto
   `backups/hyperion-*.dump.gz` y su SHA-256 reportado a un destino **fuera del
   host** que aloja PostgreSQL.
2. Conservar retención mínima (por ejemplo 7–30 días) y una alerta si el último
   offsite bueno supera el umbral de edad acordado.
3. Ensayar restore desde la copia offsite al menos una vez por trimestre en un
   destino aprobado (nunca sobre producción a ciegas).

## Stub de interfaz

`scripts/ops/postgres-offsite-copy.sh` es un stub fail-closed: documenta las
variables y sale con error hasta que el entorno provea el transport real
(`HYPERION_OFFSITE_COPY_COMMAND` o integración con el agente de backup del
proveedor). No simula HA ni inventa un destino.

## Fuera de alcance en-repo

- Credenciales de object storage
- Políticas IAM / bucket lifecycle
- Monitorización del proveedor cloud

Esos controles son del plano de infraestructura; el runbook de aplicación solo
exige evidencia de que existen.
