# Contribuir

## Ownership

Cada microservicio tiene un dueño (ver `docs/service-ownership.md`).  
Trabaja en tu carpeta `services/<name>/` sin tocar el código de otros servicios.

## Reglas de autonomía

1. No importes módulos de otro servicio.
2. No leas/escribas la base de datos de otro servicio.
3. No llames al Dialer salvo desde `orchestrator`.
4. Contratos compartidos solo vía `contracts/` (schemas versionados).
5. Cambios incompatibles en eventos → nueva versión (`v2`) + entrada en `contracts/CHANGELOG.md`.

## Añadir un microservicio

1. Copia el esqueleto de un servicio existente.
2. Asigna puerto, database y ruta Traefik.
3. Añade `CREATE DATABASE` en `infra/postgres/init-databases.sql`.
4. Regístralo en `docker-compose.dev.yml` y en `docs/service-ownership.md`.
5. Documenta eventos que publica/consume en su `README.md`.

## Rutas stub

Los stubs responden `501` en endpoints de negocio y `200` en `/health` y `/health/ready`.  
Implementa lógica real detrás de esas rutas sin cambiar el contrato público sin versionar.

## Correlation ID

Propaga el header `X-Correlation-ID` en HTTP y el campo `correlation_id` en eventos (`contracts/events/v1/_envelope.json`).

## CI (nota)

Cuando exista CI, usar **path filters** por servicio (`services/crm/**`, etc.) para que cada equipo valide solo su imagen. Este scaffold no incluye pipelines cloud.

## Branches sugeridas

- `feat/<servicio>-<descripcion>`
- `fix/<servicio>-<descripcion>`
- `docs/...` para contratos y ADRs
