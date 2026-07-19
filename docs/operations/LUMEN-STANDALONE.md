---
documentType: runbook
status: draft
owner: lumen-operations
issue: HYP-LUM-002
reviewDue: 2026-10-31
---

# Arranque autónomo de la celda LUMEN

Este descriptor levanta la clausura técnica de LUMEN para desarrollo y CI: `lumen-console`, `lumen-bff`,
`lumen-service`, su migrador provider-owned y una base lógica PostgreSQL propia. No inicia migraciones, roles,
servicios ni fuentes de NOVA o PULSO. El contexto generado tampoco debe contener sus fuentes.

Este procedimiento **no autoriza uso clínico real ni un despliegue productivo**. LUMEN permanece limitado a datos y
encuentros sintéticos según la [especificación vigente](../products/LUMEN.md) y la
[decisión de retención de audio](../architecture/decisions/ADR-0002-lumen-audio-retention.md).

## Preparación e inspección

Se requiere Docker con Compose v2, Node.js y `pnpm`. Use únicamente secretos locales nuevos; no reutilice
credenciales de otro stack. El nombre de proyecto explícito evita colisionar con un stack ya existente:

```powershell
Copy-Item infra/lumen.env.example .env.lumen
$LumenProject = "hyperion-lumen-acceptance-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))"
node scripts/docker/generate-cell-contexts.mjs --cell lumen
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml config --quiet
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml config --environment
```

Antes de continuar, sustituya todos los valores `replace-*` en `.env.lumen`. La salida de `config --environment`
solo debe declarar configuración propia del descriptor LUMEN. `ACCESS_TO_LUMEN_TOKEN` y `PULSO_TO_LUMEN_TOKEN`
son las dos credenciales de ingreso para sus productores de proyecciones externos; no debe aparecer ninguna
credencial de runtime, migración o base de NOVA, PULSO, SOFÍA, gateway ni del migrador global. Compruebe además que
`.docker-contexts/lumen` incluye `packages/lumen-migrations`, `lumen-service`, el BFF y la consola, pero no código
de las demás celdas.

## Build, arranque y salud

```powershell
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml build
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml up --detach --wait
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml ps
curl.exe --fail --silent http://127.0.0.1:3002/healthz
curl.exe --fail --silent http://127.0.0.1:8096/ready
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml exec -T postgres psql -U hyperion_lumen_admin -d hyperion_lumen -Atc "select current_version from lumen.schema_version where service_name = 'lumen'"
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml exec -T postgres psql -U hyperion_lumen_admin -d hyperion_lumen -Atc "select schema_name from information_schema.schemata where schema_name in ('platform','pulso_iris','nova','voice','liwa','documents')"
```

Con los puertos predeterminados, la consola debe devolver `200`, el BFF debe responder `status: ok`, la versión de
esquema debe ser `40` y la última consulta no debe devolver filas. Si se cambian `LUMEN_CONSOLE_HOST_PORT`,
`LUMEN_BFF_HOST_PORT` o `LUMEN_POSTGRES_HOST_PORT`, ajuste las URLs de estas comprobaciones.

## Aceptación PostgreSQL real

Exporte dos URLs contra el puerto PostgreSQL publicado en loopback usando **los mismos secretos** configurados en
`.env.lumen`. No pegue esas URLs en logs ni en incidencias:

```powershell
$env:TEST_LUMEN_MIGRATOR_DATABASE_URL = "postgres://hyperion_lumen_migrator:<migrator-secret>@127.0.0.1:55439/hyperion_lumen"
$env:TEST_LUMEN_DATABASE_URL = "postgres://hyperion_lumen:<runtime-secret>@127.0.0.1:55439/hyperion_lumen"
pnpm --filter @hyperion/lumen-migrations exec vitest run src/autonomy.integration.test.ts
$env:TEST_DATABASE_URL = $env:TEST_LUMEN_DATABASE_URL
$env:TEST_LUMEN_FIXTURE_DATABASE_URL = $env:TEST_LUMEN_MIGRATOR_DATABASE_URL
pnpm --filter @hyperion/lumen-service exec vitest run src/lumen.integration.test.ts src/projection-events.integration.test.ts src/audio-cleanup-readiness.integration.test.ts --no-file-parallelism
Remove-Item Env:TEST_DATABASE_URL, Env:TEST_LUMEN_FIXTURE_DATABASE_URL, Env:TEST_LUMEN_DATABASE_URL, Env:TEST_LUMEN_MIGRATOR_DATABASE_URL
```

La aceptación es válida cuando las tres suites del servicio reportan exactamente 22/22 pruebas aprobadas y cero
omitidas, el catálogo efectivo contiene únicamente el esquema
LUMEN v40, el runtime `hyperion_lumen` puede operar tablas clínicas pero no el ledger ni DDL, y las integraciones
del servicio usan solo proyecciones locales. `TEST_LUMEN_FIXTURE_DATABASE_URL` se limita a preparar y limpiar datos
de prueba; la aplicación bajo prueba conserva `TEST_DATABASE_URL` con el rol runtime. Los valores entre `<...>` son
marcadores y deben sustituirse; no son credenciales válidas.

## Cierre y limpieza exacta

Para detener el proyecto conservando la base local:

```powershell
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml down --remove-orphans
```

Solo para una aceptación desechable, elimine también el volumen después de validar que la variable conserva el
nombre exacto creado en esta sesión:

```powershell
if ($LumenProject -notmatch '^hyperion-lumen-acceptance-\d{14}$') { throw "Nombre de proyecto LUMEN inesperado" }
docker compose --project-name $LumenProject --env-file .env.lumen -f infra/docker-compose.lumen.yml down --volumes --remove-orphans --rmi local
docker ps --all --filter "label=com.docker.compose.project=$LumenProject" --format "{{.ID}}"
docker volume ls --filter "label=com.docker.compose.project=$LumenProject" --format "{{.Name}}"
docker network ls --filter "label=com.docker.compose.project=$LumenProject" --format "{{.Name}}"
docker image ls --filter "label=com.docker.compose.project=$LumenProject" --format "{{.Repository}}:{{.Tag}}"
```

Las cuatro últimas consultas deben quedar vacías. No use patrones, nombres de otros proyectos ni una limpieza global.
`--volumes` destruye de forma irreversible la base de este proyecto exacto.

## Límites conocidos

- La autorización vigente es **synthetic only**. Las invariantes de base rechazan encuentros no sintéticos y este
  runbook no habilita datos clínicos reales.
- Access/SSO sigue siendo externo. El Compose no emite JWT, no publica JWKS ni aprovisiona tenants/grants; el BFF
  necesita las URLs y contratos de Access para un flujo autenticado extremo a extremo.
- Audit es un consumidor externo. El Compose no lo inicia; cuando la entrega está habilitada, una indisponibilidad
  debe conservar eventos en el outbox para reintento, no convertir Audit en dependencia SQL o de migración.
- Los productores de las proyecciones `tenant`, `operator-grant` y `encounter-reference` son externos (Access y
  PULSO). El arranque autónomo acredita infraestructura y límites, no que esas proyecciones estén pobladas.
- El puente administrativo de compatibilidad y limpieza de audio N-1 permanece en el migrador global legado y no
  se incluye en la imagen ni en el runtime autónomo de LUMEN.
- Existe un procedimiento provider-owned `postgres-only` con wrappers y gates no-Docker en
  [LUMEN-RECOVERY.md](LUMEN-RECOVERY.md), pero todavía no se ha ejecutado su drill real en el entorno objetivo ni
  se han validado offsite, RPO/RTO, rollback o alta disponibilidad. Tampoco se han resuelto DNS, terminación TLS,
  certificados, observabilidad ni rotación de secretos para producción.
- Las credenciales de proveedores clínicos no forman parte del ejemplo. El health puede indicar transcripción o
  estructuración no configuradas; eso no acredita un flujo clínico completo.
