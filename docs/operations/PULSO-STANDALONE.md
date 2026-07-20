---
documentType: runbook
status: draft
owner: pulso-operations
issue: HYP-PUL-001
reviewDue: 2026-10-31
---

# Arranque autónomo de la celda PULSO

Este descriptor materializa la clausura técnica de PULSO para desarrollo y CI: `pulso-console`, `pulso-bff`,
PULSO Core, SOFÍA, Prompt Flow, Knowledge, Integration, WhatsApp, su migrador provider-owned y la base lógica
`hyperion_pulso`. No inicia migraciones, roles, servicios ni fuentes de NOVA o LUMEN. Access/JWKS y Audit
permanecen como dependencias externas del plano neutral y no forman parte del proyecto Compose.

El procedimiento permanece en `draft`: la base y el recovery PostgreSQL se validaron localmente, pero no se ha
acreditado todavía el arranque completo de la celda contra proveedores reales, imágenes publicadas ni un entorno
productivo. Los valores de `infra/pulso.env.example` son placeholders; deben reemplazarse por secretos exclusivos
antes de cualquier ensayo fuera de local/CI.

## Preparación e inspección

Use un nombre de proyecto explícito para no colisionar con otro stack y revise el modelo antes de construir:

```powershell
Copy-Item infra/pulso.env.example .env.pulso
$PulsoProject = "hyperion-pulso-acceptance-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))"
node scripts/docker/generate-cell-contexts.mjs --cell pulso
docker compose --project-name $PulsoProject --env-file .env.pulso -f infra/docker-compose.pulso.yml config --quiet
docker compose --project-name $PulsoProject --env-file .env.pulso -f infra/docker-compose.pulso.yml config --environment
```

La salida no debe declarar configuración NOVA, LUMEN, gateway ni del migrador global. El contexto
`.docker-contexts/pulso` debe incluir únicamente la clausura PULSO y no debe contener fuentes de otras celdas ni un
build recursivo `pnpm -r build`. Las URLs de Access/JWKS y Audit deben ser HTTPS fuera de un entorno local privado.

## Build, arranque y salud

```powershell
$env:PULSO_MIGRATION_PHASE = "contract" # greenfield; use expand first for an existing cutover
docker compose --project-name $PulsoProject --env-file .env.pulso -f infra/docker-compose.pulso.yml build
docker compose --project-name $PulsoProject --env-file .env.pulso -f infra/docker-compose.pulso.yml up --detach --wait
docker compose --project-name $PulsoProject --env-file .env.pulso -f infra/docker-compose.pulso.yml ps
curl.exe --fail --silent http://127.0.0.1:3000/healthz
curl.exe --fail --silent http://127.0.0.1:8097/health
docker compose --project-name $PulsoProject --env-file .env.pulso -f infra/docker-compose.pulso.yml exec -T postgres psql -U hyperion_pulso_admin -d hyperion_pulso -Atc "select current_version || '/' || migration_name from pulso_iris.schema_version where service_name = 'pulso'"
docker compose --project-name $PulsoProject --env-file .env.pulso -f infra/docker-compose.pulso.yml exec -T postgres psql -U hyperion_pulso_admin -d hyperion_pulso -Atc "select current_version || '/' || migration_name from agent_runtime.schema_version where service_name = 'sofia'"
```

PostgreSQL debe responder `16/016-attest-access-fk-contract.sql` para PULSO y
`2/006-access-sofia-tenant-projection.sql` para SOFÍA. Un despliegue aceptable usa el migrador
`hyperion_pulso_migrator` y exactamente cinco roles runtime: `hyperion_pulso`, `hyperion_sofia`,
`hyperion_knowledge`, `hyperion_integration` y `hyperion_channel`. Cada servicio debe llegar a `healthy` con su rol
propio; que el BFF o la consola respondan no sustituye esa comprobación.

El descriptor standalone construye desde la clausura local y no representa por sí mismo un manifiesto publicado.
Sus siete runtimes Node reciben una variable `SERVICE_VERSION` específica, con defaults iguales al catálogo PULSO
`1.4.0`; no existe un fallback compartido que pueda hacer pasar Agent o Prompt Flow `0.2.0` por otra versión. Para
staging o producción, las imágenes deben provenir de un manifiesto `published`, verificadas y fijadas por digest;
el borrador `0.5.0-dev.0` conserva `imagesVerified: false` y no autoriza despliegue.

Las claves de DeepSeek y la conectividad real de WhatsApp están vacías o deshabilitadas por defecto. Ese modo
permite validar infraestructura y salud, pero no acredita generación con IA, mensajería real ni operación de
negocio. Audit debe permanecer fuera del camino crítico mediante el outbox; una caída temporal no debe convertir
la indisponibilidad de Audit en fallo de readiness de PULSO.

## Aceptación PostgreSQL provider-owned

La suite de autonomía requiere seis URLs separadas: migrador y cinco runtimes. No las imprima ni las copie a
incidencias. Los dos ensayos que modifican markers o simulan un upgrade solo se habilitan contra una base
desechable cuyo nombre cumpla `^hyperion_pulso_n1_fixture_`; `hyperion_pulso` no es un destino válido para esos
ensayos. Provisione primero esa base con el migrador y los cinco roles provider-owned:

```powershell
$PulsoAcceptanceDatabase = "hyperion_pulso_n1_fixture_local"
$env:REQUIRE_PULSO_READINESS_ACCEPTANCE = "1"
$env:PULSO_READINESS_ACCEPTANCE_DATABASE_NAME = $PulsoAcceptanceDatabase
$env:REQUIRE_SOFIA_N_MINUS_ONE_FIXTURE = "1"
$env:SOFIA_N_MINUS_ONE_FIXTURE_DATABASE_NAME = $PulsoAcceptanceDatabase
$env:TEST_PULSO_MIGRATOR_DATABASE_URL = "postgres://hyperion_pulso_migrator:<secret>@127.0.0.1:55440/$($PulsoAcceptanceDatabase)"
$env:TEST_PULSO_DATABASE_URL = "postgres://hyperion_pulso:<secret>@127.0.0.1:55440/$($PulsoAcceptanceDatabase)"
$env:TEST_SOFIA_DATABASE_URL = "postgres://hyperion_sofia:<secret>@127.0.0.1:55440/$($PulsoAcceptanceDatabase)"
$env:TEST_KNOWLEDGE_DATABASE_URL = "postgres://hyperion_knowledge:<secret>@127.0.0.1:55440/$($PulsoAcceptanceDatabase)"
$env:TEST_INTEGRATION_DATABASE_URL = "postgres://hyperion_integration:<secret>@127.0.0.1:55440/$($PulsoAcceptanceDatabase)"
$env:TEST_CHANNEL_DATABASE_URL = "postgres://hyperion_channel:<secret>@127.0.0.1:55440/$($PulsoAcceptanceDatabase)"
pnpm --filter @hyperion/pulso-migrations exec vitest run src/autonomy.integration.test.ts
pnpm --filter @hyperion/service-runtime exec vitest run src/sofia-n-minus-one-readiness.integration.test.ts --no-file-parallelism
Remove-Item Env:SOFIA_N_MINUS_ONE_FIXTURE_DATABASE_NAME, Env:REQUIRE_SOFIA_N_MINUS_ONE_FIXTURE, Env:PULSO_READINESS_ACCEPTANCE_DATABASE_NAME, Env:REQUIRE_PULSO_READINESS_ACCEPTANCE, Env:TEST_CHANNEL_DATABASE_URL, Env:TEST_INTEGRATION_DATABASE_URL, Env:TEST_KNOWLEDGE_DATABASE_URL, Env:TEST_SOFIA_DATABASE_URL, Env:TEST_PULSO_DATABASE_URL, Env:TEST_PULSO_MIGRATOR_DATABASE_URL
```

Antes de la primera escritura, la suite compara `current_database()` de las seis conexiones con
`PULSO_READINESS_ACCEPTANCE_DATABASE_NAME`; una diferencia falla el gate. Sin ambas guardas
`REQUIRE_PULSO_READINESS_ACCEPTANCE=1` y `PULSO_READINESS_ACCEPTANCE_DATABASE_NAME`, los dos ensayos mutantes se
omiten deliberadamente y la ejecución no constituye una aceptación completa. La aceptación exige la suite completa
sin pruebas omitidas: catálogo provider-owned 001–004, versión global 4,
marker local SOFÍA versión 1, upgrade exacto desde 003, ownership/ACL exactos y DDL denegado a cada runtime. La
segunda suite congela el requisito 002 como fixture de contrato y demuestra que los markers global y local fallan
de forma independiente; no sustituye una imagen N−1 publicada ni un rehearsal por digest. La
evidencia de backup y restore real se conserva en
[PULSO-RECOVERY](PULSO-RECOVERY.md).

## Cierre y limpieza exacta

Para detener conservando los volúmenes:

```powershell
docker compose --project-name $PulsoProject --env-file .env.pulso -f infra/docker-compose.pulso.yml down --remove-orphans
```

Solo en una aceptación desechable y después de validar el nombre exacto creado en esta sesión puede añadirse
`--volumes --rmi local`. El volumen `pulso_whatsapp_sessions` contiene credenciales de sesión: no se elimina ni se
restaura como efecto colateral de una prueba PostgreSQL.
