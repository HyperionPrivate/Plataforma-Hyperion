---
documentType: runbook
status: draft
owner: nova-operations
issue: HYP-FED-014
reviewDue: 2026-10-31
---

# Arranque autónomo de la celda NOVA

Este descriptor acredita la extracción operativa de NOVA sin iniciar migraciones, credenciales ni servicios de
LUMEN o PULSO. Access/JWKS y Audit son dependencias externas del plano neutral: no forman parte del proyecto
Compose y no son dependencias de arranque. Una indisponibilidad temporal de Audit debe dejar el evento en el
outbox para reintento; no debe degradar `/ready`.

El procedimiento está validado para desarrollo y CI. Antes de usarlo en staging o producción hay que sustituir
todos los placeholders, fijar URLs HTTPS reales para Access/JWKS y Audit, configurar Neutral Dialer/LIWA y usar
un manifiesto NOVA con imágenes verificadas por digest.

Neutral Dialer y LIWA se inventarían sólo mediante variables `NOVA_DIALER_*` y `NOVA_LIWA_*`. En el smoke
`contract/local` pueden quedar sin credenciales; los runtimes rechazan esa omisión al cambiar el despliegue a
staging o production. Coopfuturo sigue siendo un cliente específico y se activa opcionalmente con el profile
`customer-coopfuturo`; nunca es requisito de arranque del core ni reemplaza a `nova-console`.

El callback de ElevenLabs usa exclusivamente `NOVA_ELEVENLABS_WEBHOOK_HMAC_SECRET`, que Compose entrega como
`ELEVENLABS_WEBHOOK_HMAC_SECRET` a `voice-channel-service`; no reutiliza `NOVA_ELEVENLABS_API_KEY`. Puede quedar
vacío sólo en el smoke `contract/local`. En `staging` o `production`, el runtime rechaza el callback con 401 si
falta el secreto. No publicar ni promover el hostname NOVA hasta que el secreto dedicado esté aprovisionado.

El descriptor enlaza BFF, consola NOVA y el cliente opcional Coopfuturo sólo a loopback. El BFF es también el
ingress provider-owned de NOVA en `127.0.0.1:${NOVA_BFF_HOST_PORT:-8095}` para que un reverse proxy con TLS
estable o un túnel privado publique exclusivamente estos callbacks:

- `POST /v1/liwa/webhooks`
- `POST /v1/voice/webhooks/dialer`
- `POST /v1/voice/webhooks/elevenlabs`

La superficie preserva el cuerpo JSON exacto y sólo los headers de secreto/firma propios de cada proveedor. No
publica aliases, probes GET ni `/simulate`; esas rutas responden 404. Nunca exponer el puerto HTTP directamente a
Internet ni configurar secretos en query string.

El Compose exige `NOVA_PROVIDER_EDGE_TOKEN`, compartido únicamente entre `hostname-edge` y `nova-bff`. El edge
sobrescribe cualquier identidad aportada por el cliente, acompaña la IP saneada con esa credencial y el BFF limita
cada callback por ruta e IP autenticada. Una llamada directa o una identidad de edge inválida no llega a Voice ni
LIWA. La misma credencial debe configurarse en ambos Compose y rotarse coordinadamente; no es un secreto de
proveedor y no debe reutilizarse como HMAC de Dialer, ElevenLabs o LIWA.

## Preparación

```powershell
Copy-Item infra/nova.env.example .env.nova
$NovaProject = "hyperion-nova-acceptance-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))"
node scripts/docker/generate-cell-contexts.mjs --cell nova
docker compose --project-name $NovaProject --env-file .env.nova -f infra/docker-compose.nova.yml config --quiet
docker compose --project-name $NovaProject --env-file .env.nova -f infra/docker-compose.nova.yml config --environment
```

`config --environment` no debe mostrar variables LUMEN, PULSO, SOFÍA, gateway ni del bootstrap global. El contexto
`.docker-contexts/nova` tampoco contiene fuentes de esas celdas.

El descriptor base necesita un Access/JWKS HTTPS real para llegar a readiness en un arranque frío. Mantenga
`NOVA_ACCESS_JWKS_ALLOW_PRIVATE_HTTP=false` fuera del overlay de aceptación: esta única excepción controla HTTP
privado tanto para `ACCESS_SERVICE_URL` como para `ACCESS_JWKS_URL`, y el BFF la rechaza fuera de
`local`/`development`/`test`/`ci`. Apuntar a `*.example.invalid` acredita únicamente interpolación y cierre de
configuración; no puede hacer que el BFF esté ready.

## Arranque y smoke local/CI

El overlay [docker-compose.nova.acceptance.yml](../../infra/docker-compose.nova.acceptance.yml) añade un fixture
efímero construido desde el mismo target `nova-bff` y el contexto NOVA. El fixture contiene sólo una clave pública,
expone `/jwks` dentro de la red y responde `503 degraded` a `/ready`: permite cargar JWKS en frío, pero no puede
emitir tokens, autenticar usuarios ni sustituir Access. Tanto el fixture como el BFF rechazan HTTP privado fuera de
`local`, `development`, `test` o `ci`.

```powershell
docker compose --project-name $NovaProject --env-file .env.nova -f infra/docker-compose.nova.yml -f infra/docker-compose.nova.acceptance.yml config --quiet
docker compose --project-name $NovaProject --env-file .env.nova -f infra/docker-compose.nova.yml -f infra/docker-compose.nova.acceptance.yml up --detach --build --wait
docker compose --project-name $NovaProject --env-file .env.nova -f infra/docker-compose.nova.yml -f infra/docker-compose.nova.acceptance.yml ps
curl.exe --fail --silent http://127.0.0.1:3010/healthz
curl.exe --fail --silent http://127.0.0.1:8095/ready
docker compose --project-name $NovaProject --env-file .env.nova -f infra/docker-compose.nova.yml -f infra/docker-compose.nova.acceptance.yml exec -T postgres psql -U hyperion_nova_admin -d hyperion_nova -Atc "select current_database()"
```

Para incluir el cliente Coopfuturo en la misma celda, añadir `--profile customer-coopfuturo` al comando `up`.

El smoke es válido cuando la consola, el BFF y los cuatro runtimes están saludables, PostgreSQL devuelve
`hyperion_nova`, `access-signing-keys` está `ok`, `access-token-minting` está `degraded` y no requerido, y el modelo
no declara un runtime de Access ni Audit. El fixture se llama explícitamente `nova-access-jwks-fixture`; no posee
base ni clave privada. Aunque su imagen reutiliza el target `nova-bff`, el proceso inline que se ejecuta queda
aislado en una red interna compartida sólo con el BFF y su superficie HTTP no expone contratos ni endpoints de
Access, incluidos login y emisión de tokens.

Para un smoke autenticado omita el overlay, sustituya las tres URLs/issuer de Access por endpoints HTTPS reales,
mantenga `NOVA_ACCESS_JWKS_ALLOW_PRIVATE_HTTP=false` y aprovisione un operador, tenant UUID y grant NOVA. Sólo en
ese modo puede ejecutarse `scripts/autonomy/nova-smoke.e2e.mjs`. Validar además un evento real de outbox contra un
Audit de prueba antes de promover la release.

## Cierre

```powershell
docker compose --project-name $NovaProject --env-file .env.nova -f infra/docker-compose.nova.yml -f infra/docker-compose.nova.acceptance.yml down --remove-orphans
```

No usar `--volumes` salvo que se haya aprobado borrar la base, los objetos y los documentos locales de NOVA. Para
una aceptación completamente desechable, valide primero el nombre y elimine sólo el proyecto exacto:

```powershell
if ($NovaProject -notmatch '^hyperion-nova-acceptance-\d{14}$') { throw "Nombre de proyecto NOVA inesperado" }
docker compose --project-name $NovaProject --env-file .env.nova -f infra/docker-compose.nova.yml -f infra/docker-compose.nova.acceptance.yml down --volumes --remove-orphans --rmi local
docker ps --all --filter "label=com.docker.compose.project=$NovaProject" --format "{{.ID}}"
docker volume ls --filter "label=com.docker.compose.project=$NovaProject" --format "{{.Name}}"
docker network ls --filter "label=com.docker.compose.project=$NovaProject" --format "{{.Name}}"
docker image ls --filter "label=com.docker.compose.project=$NovaProject" --format "{{.Repository}}:{{.Tag}}"
```

Las cuatro consultas finales deben quedar vacías. Una interrupción durante el build puede dejar capas compartidas en
la caché de BuildKit; no ejecute limpiezas globales ni borre imágenes que existían antes del ensayo.
