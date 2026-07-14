# Produccion

Este repositorio contiene controles y procedimientos para ambientes con datos operativos. La habilitación
productiva exige validar el despliegue, los backups y la recuperación del ambiente concreto. Este runbook no
autoriza datos clínicos reales en LUMEN: la única ejecución LUMEN cubierta es la demo sintética aislada; sus
registros no se presentan como reales ni deben entrar en los flujos operativos de PULSO IRIS.

## Secretos

- No se guardan claves reales en Git.
- Toda clave compartida por chat, correo o canal no secreto debe rotarse antes de dejarla como acceso permanente.
- `.env.example` contiene placeholders y valores no secretos para documentar la configuracion esperada.
- En `NODE_ENV`/`HYPERION_ENVIRONMENT` `production` o `staging`, el runtime (`@hyperion/config` /
  `startService`) y el bootstrap de roles rechazan cualquier secreto requerido que coincida con
  `/^replace-/i` o con los valores exactos de `.env.example`.
- CI y ensayos locales que cargan `.env.example` pueden fijar `HYPERION_ALLOW_EXAMPLE_SECRETS=true`
  (presente en el ejemplo). En VPS real: omitir esa variable (o `false`), fijar
  `HYPERION_ENVIRONMENT=production` y sustituir todos los `replace-*`.
- `POSTGRES_PASSWORD`, las ocho contraseñas PostgreSQL, las credenciales HTTP por vínculo
  `*_TO_*_TOKEN` y las credenciales de proveedores deben vivir fuera del repositorio.
- Cada `*_TO_*_TOKEN` se entrega únicamente a su productor y consumidor, tiene al menos 24 caracteres
  seguros y no se reutiliza en otro vínculo, en PostgreSQL, en NATS ni con proveedores.
- Los tokens por vínculo son una barrera transicional. Un entorno empresarial debe añadir identidad de workload
  gestionada, mTLS y rotación externa sin retirar la autorización específica por productor/ruta.
- **A-02 (mitigado, no eliminado):** el gateway emite `x-hyperion-operator-assertion` (HMAC-SHA256 con
  `GATEWAY_OPERATOR_ASSERTION_KEY`) junto a `x-operator-id` / `x-operator-role`. Identity exige que la
  aserción coincida con esos headers cuando la clave está configurada, de modo que un token de arista
  estático solo no basta para fabricar rol admin. Riesgo residual: quien robe **ambos**
  `GATEWAY_TO_IDENTITY_TOKEN` y `GATEWAY_OPERATOR_ASSERTION_KEY` aún puede forjar claims hasta mTLS /
  identidad de workload. Sin la clave de aserción, el fallback histórico (headers de rol) permanece
  y debe tratarse como inaceptable en producción.
- Las contraseñas `*_DATABASE_PASSWORD` son distintas entre sí, tienen al menos 24 caracteres URI no
  reservados y nunca se reutilizan como contraseña administrativa.

## VPS

El VPS debe quedar con acceso por llave SSH, firewall activo y login root por password deshabilitado despues del primer aprovisionamiento. El despliegue debe usar las variables reales del ambiente y no valores de ejemplo.

## Puertos

- Gateway: `${API_GATEWAY_HOST_PORT:-8080}`.
- Consola web: `${WEB_CONSOLE_HOST_PORT:-3000}`.
- PostgreSQL no se publica al host; solo queda disponible dentro de la red Docker.

## Runtime compartido

`/health` es liveness del proceso. `/ready` devuelve HTTP 200 sólo cuando las dependencias requeridas están
disponibles y HTTP 503 cuando el cuerpo reporta `status: down`; balanceadores y probes pueden usar el código HTTP
sin interpretar JSON.

El cierre concede 65 segundos por defecto para que los hooks drenen el trabajo en curso antes de forzar la
salida. `SHUTDOWN_TIMEOUT_MS` puede configurarse entre 55000 y 900000 milisegundos, pero no debe reducirse por
debajo del peor tiempo medido del batch. Compose concede 75 segundos mediante `SHUTDOWN_GRACE_PERIOD`; debe
superar el timeout del runtime por al menos cinco segundos. La barrera de arquitectura valida ambos presupuestos
para todos los runtimes Node, incluidos Channel, PULSO, Audit y LUMEN. CI smoke ensaya el stop limpio de
`agent-service` (HTTP y JetStream); el mismo script
[`scripts/ci/verify-compose-graceful-stop.sh`](../scripts/ci/verify-compose-graceful-stop.sh) documenta cómo
rehearsar los demás servicios de outbox antes de un corte productivo.
Los dispatchers y consumidores cierran antes que el pool PostgreSQL. En SOFÍA un único coordinador detiene en
paralelo el runtime, el publicador y todos los consumidores JetStream; cada consumidor limita su parada a 15
segundos y, si el drenaje de NATS agota su plazo, fuerza el cierre del transporte sin confirmar el mensaje activo.
Las consultas de los runtimes tienen `lock_timeout=5000ms`, `statement_timeout=10000ms` y
`query_timeout=12000ms`; las migraciones usan un cliente administrativo separado. SOFÍA propaga la señal de
cierre a DeepSeek y a sus herramientas HTTP, no convierte una cancelación en una respuesta fallback y limita el
drenaje de su dispatcher a cinco entregas de tres segundos. Sus eventos de auditoría de finalización se confirman
en el outbox dentro de la misma transacción que completa el job.

`TRUST_PROXY` queda vacío o `false` cuando el servicio es alcanzable directamente. Sólo debe configurarse detrás
de un proxy controlado y acepta una lista separada por comas de IP o CIDR explícitos. El runtime rechaza `true`,
hostnames, reglas inválidas y redes `/0`; documentar los hops reales antes de habilitarlo.

## JetStream

El transporte predeterminado del stack base sigue siendo HTTP. El overlay
`infra/docker-compose.jetstream.yml` usa identidades y ACL por servicio, pero permanece como piloto de un solo
nodo: una replica, DLQ con la misma retencion y sin alerta/redrive operativos. **No habilitarlo en produccion**
hasta desplegar cluster con replicas, TLS interno, limites de capacidad, monitorizacion y una prueba documentada de
recuperacion. El runtime refuse `DURABLE_EVENT_TRANSPORT=jetstream` cuando
`HYPERION_ENVIRONMENT=production` o `NODE_ENV=production` salvo que existan a la vez
`PRODUCTION_JETSTREAM_ENABLED=true`, `JETSTREAM_REPLICAS>=3` y `NATS_URL` con esquema `tls:`.
Un solo nodo sigue bloqueado: no hay atajo que simule HA.
Cuando se evalua en un ambiente aislado, los seis `NATS_*_PASSWORD` deben ser distintos y nunca
reutilizar credenciales HTTP `*_TO_*_TOKEN` ni contraseñas PostgreSQL. El bootstrap crea los durables
versionados declarados por la topología y el
durable temporal `audit_event_record_v1`: Audit consume por separado `sofia.audit.event.record.v1` y
`lumen.audit.event.record.v1`, mientras el tercero sólo drena mensajes publicados antes de la migración y los
marca `legacy-unknown`. Ninguna identidad runtime puede publicar nuevos eventos en el subject genérico. Cuando
el durable legado permanezca vacío durante una ventana superior a la retención, se elimina en una migración de
topología posterior. Con JetStream activo, los endpoints HTTP de entrega durable no se registran; HTTP no queda
como bypass paralelo de las ACL.

### Ensayo local aislado de JetStream

Este ensayo valida la secuencia de activacion sin tocar el proyecto Compose habitual ni datos operativos. Crear
`.env.rehearsal.local` a partir de `.env.example`, completar las ocho contraseñas PostgreSQL, las seis de NATS,
todos los vínculos HTTP `*_TO_*_TOKEN` enumerados allí y `POSTGRES_PASSWORD`, y mantener el archivo fuera de Git.
Todas las contraseñas PostgreSQL, incluida la administrativa, deben usar al menos 24 caracteres URI no reservados.
Para impedir llamadas a proveedores durante el ensayo se fijan además:

```dotenv
WHATSAPP_WEB_TEST_ENABLED=false
SOFIA_WORKER_ENABLED=false
SOFIA_LEGACY_POLLING_ENABLED=false
DURABLE_OUTBOX_ENABLED=true
INITIAL_ADMIN_EMAIL=
INITIAL_ADMIN_PASSWORD=
VITE_API_BASE_URL=/api
CORS_ALLOWED_ORIGINS=http://localhost:13000
API_GATEWAY_HOST_PORT=127.0.0.1:18080
WEB_CONSOLE_HOST_PORT=127.0.0.1:13000
```

No usar este procedimiento contra volúmenes existentes. En PowerShell, levantar primero infraestructura y los
workloads one-shot con un nombre de proyecto exclusivo:

```powershell
$Project = "hyperion-autonomy-rehearsal"
$EnvFile = (Resolve-Path ".env.rehearsal.local").Path
$Compose = @(
  "--project-name", $Project,
  "--env-file", $EnvFile,
  "-f", "infra/docker-compose.yml",
  "-f", "infra/docker-compose.jetstream.yml"
)

pnpm compose:check
docker compose @Compose config --quiet
docker compose @Compose build
docker compose @Compose up -d --wait --wait-timeout 120 postgres nats
docker compose @Compose run --rm --no-deps migrations
docker compose @Compose run --rm --no-deps db-role-bootstrap
docker compose @Compose run --rm --no-deps jetstream-topology-bootstrap
```

No iniciar ningún runtime con base de datos entre `migrations` y `db-role-bootstrap`: la migración deja las ocho
identidades como `NOLOGIN` y el bootstrap sólo las activa cuando toda la matriz ya quedó validada y confirmada.

El E2E comparte los durables reales del piloto. Channel, PULSO, SOFIA, Audit y LUMEN deben permanecer detenidos
mientras se ejecuta, para que ningún worker compita por sus mensajes. La imagen `autonomy-e2e-runner` sólo existe
para este ensayo y no es referenciada por ningún servicio productivo:

```powershell
docker compose @Compose stop `
  whatsapp-channel-service pulso-iris-service agent-service audit-service lumen-service

docker build `
  --file infra/docker/node-service.Dockerfile `
  --target autonomy-e2e-runner `
  --tag hyperion-autonomy-e2e:local .

docker run --rm `
  --network "${Project}_default" `
  --env-file $EnvFile `
  --env NATS_URL=nats://nats:4222 `
  hyperion-autonomy-e2e:local `
  node --input-type=module -e '
    const user = encodeURIComponent(process.env.POSTGRES_USER || "hyperion");
    const password = encodeURIComponent(process.env.POSTGRES_PASSWORD);
    const database = encodeURIComponent(process.env.POSTGRES_DB || "hyperion");
    process.env.TEST_DATABASE_URL =
      "postgres://" + user + ":" + password + "@postgres:5432/" + database;
    await import("file:///app/scripts/autonomy/real-flow.e2e.mjs");
  '
```

El resultado aprobado contiene `status=passed`, las diez cuentas de efectos en `1` y limpia su tenant sintetico.
Después se levantan consumidores de aguas abajo hacia aguas arriba, y finalmente el gateway y la consola:

```powershell
docker compose @Compose up -d --no-deps --no-build --wait audit-service
docker compose @Compose up -d --no-deps --no-build --wait agent-service lumen-service
docker compose @Compose up -d --no-deps --no-build --wait pulso-iris-service
docker compose @Compose up -d --no-deps --no-build --wait whatsapp-channel-service
docker compose @Compose up -d --no-deps --no-build --wait `
  identity-service tenant-service prompt-flow-service knowledge-service integration-service
docker compose @Compose up -d --no-deps --no-build --wait api-gateway
docker compose @Compose up -d --no-deps --no-build --wait web-console

$ReadyPorts = @{
  "identity-service" = 8081
  "tenant-service" = 8082
  "agent-service" = 8083
  "prompt-flow-service" = 8084
  "knowledge-service" = 8085
  "audit-service" = 8086
  "integration-service" = 8087
  "pulso-iris-service" = 8088
  "whatsapp-channel-service" = 8089
  "lumen-service" = 8090
}
foreach ($Entry in $ReadyPorts.GetEnumerator()) {
  docker compose @Compose exec -T $Entry.Key node -e `
    "fetch('http://127.0.0.1:$($Entry.Value)/ready').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); })"
  if ($LASTEXITCODE -ne 0) { throw "Readiness failed for $($Entry.Key)" }
}

$DisabledHttpIngress = @{
  "agent-service" = @(8083, "/internal/v1/events/pulso-message-received")
  "audit-service" = @(8086, "/internal/v1/events")
  "pulso-iris-service" = @(8088, "/internal/v1/events/channel-inbound")
  "lumen-service" = @(8090, "/internal/v1/events/lumen-projections")
}
foreach ($Entry in $DisabledHttpIngress.GetEnumerator()) {
  docker compose @Compose exec -T $Entry.Key node -e `
    "fetch('http://127.0.0.1:$($Entry.Value[0])$($Entry.Value[1])', { method: 'POST' }).then(r => { console.log(r.status); process.exit(r.status === 404 ? 0 : 1); })"
  if ($LASTEXITCODE -ne 0) { throw "HTTP durable ingress remains enabled for $($Entry.Key)" }
}
```

No ejecutar las pruebas de ACL ni de upgrade de topologia contra este broker persistente: usan mensajes o durables
deliberadamente anómalos y pertenecen a un NATS descartable independiente. El rollback del piloto consiste en
retirar el overlay JetStream y recrear los servicios con `DURABLE_EVENT_TRANSPORT=http`; no se deben borrar el
stream ni los outbox hasta verificar que no quedan mensajes pendientes. Al terminar el ensayo aislado:

```powershell
docker compose @Compose down --volumes --remove-orphans
```

## Backup antes de migraciones y deploys

Antes de aplicar cualquier migracion nueva o redeploy productivo en el VPS se debe crear un dump
comprimido de PostgreSQL fuera de Git mediante el procedimiento versionado:

```bash
cd /opt/hyperion-platform
./scripts/ops/postgres-backup.sh
```

El script usa Bash estricto, `umask 077`, `pg_dump` custom sin compresion interna y `gzip -n`.
Primero escribe un archivo temporal privado dentro de `backups/`; solo publica el nombre final mediante
un hard link atomico despues de completar todas las validaciones. Un nombre existente se rechaza y
nunca se sobrescribe. `EXIT`, `HUP`, `INT` y `TERM` limpian el temporal mediante `trap` sin dejar un
backup final parcial; `sync` fuerza el archivo y el directorio antes de reportar exito. `SIGKILL` o una
perdida de energia todavia pueden dejar un temporal oculto, que nunca se publica antes de validar.

En cada ejecucion el procedimiento garantiza `0700` para `backups/`, aplica `0600` a todos sus archivos
regulares existentes y crea el nuevo backup como `0600`. En produccion se ejecuta como `root`, por lo
que exige `root:root` para el repositorio, scripts, Compose, archivo de entorno, carpeta y backups. Los
archivos y directorios de control no pueden ser escribibles por grupo u otros, y `.env` debe ser
privado. Un propietario inesperado, un enlace simbolico o un archivo con multiples hard links
interrumpe la operacion. Fuera de pruebas aisladas exige el repositorio canonico
`/opt/hyperion-platform` y no acepta rutas alternativas para backups, Compose ni el archivo de entorno.
La carpeta `backups/` permanece ignorada por Git. El host debe proporcionar GNU `realpath`, `stat`,
`ln`, `sync`, `sha256sum`, `gzip` y Docker Compose; su presencia y version deben verificarse en el VPS Linux
antes de operar.

Antes de publicar, el script exige tamano mayor que cero, ejecuta `gzip -t`, descomprime por `stdin`
hacia `pg_restore --list`, exige al menos una entrada de catalogo y calcula SHA-256. La salida registra
unicamente nombre, tamano, numero de entradas, hash, modos y propietarios; no imprime variables ni
credenciales. Conservar esa salida junto al registro del deploy.

Comprobacion operativa de permisos y propietario, sin inspeccionar contenido:

```bash
stat -c '%a %U:%G %n' /opt/hyperion-platform/backups
find /opt/hyperion-platform/backups -mindepth 1 -maxdepth 1 -type f \
  -printf '%m %u:%g %f\n' | sort
```

Si el script falla antes de publicar, el temporal queda eliminado y el nombre final no aparece. Un
fallo posterior al hard link puede conservar un backup final ya validado, pero nunca uno parcial;
revisar el resultado sin borrarlo ni sobrescribirlo antes de volver a ejecutar. No borrar, renombrar ni
reemplazar backups anteriores para recuperarse de un fallo.

### Restore controlado

La restauracion vive en `scripts/ops/postgres-restore.sh`. Exige un archivo bajo `backups/`, un nombre de
base de datos destino aprobado y la confirmacion literal
`HYPERION_RESTORE_CONFIRM='RESTORE <database>'`. Valida `gzip`, el catalogo `pg_restore --list` y el
SHA-256 opcional (`HYPERION_RESTORE_SHA256`) antes de recrear solo esa base. No restaura a ciegas sobre
el volumen productivo: el destino debe ser una base de ensayo o un host aprobado. `pnpm backup:test`
incluye el round-trip mock de restore.

#### Objetivos de recuperación (RPO/RTO)

| Objetivo                      | Valor declarado                                                                                                      | Evidencia actual                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| RPO (pérdida máxima de datos) | ≤ 24 h para dumps programados diarios; ≤ intervalo del cron real en el host                                          | Dump local `postgres-backup.sh` + copia offsite obligatoria (`OFFSITE-BACKUP.md`). Sin offsite el RPO es el disco del VPS. |
| RTO (tiempo de recuperación)  | ≤ 2 h para restore a base de ensayo + revalidación de migraciones/roles en un VPS de tamaño similar al de referencia | Procedimiento manual versionado; el ensayo automatizado de CI valida scripts, no un cluster productivo.                    |

Antes de cutover productivo: ejecutar backup → restore a base de ensayo → `pnpm db:migrate` / bootstrap de roles → smoke `/ready`, y registrar el tiempo real como evidencia del RTO del ambiente.

### Copia offsite

El dump local no basta ante fallo de disco/host. Ver [`ops/OFFSITE-BACKUP.md`](ops/OFFSITE-BACKUP.md) y el
stub `scripts/ops/postgres-offsite-copy.sh`: la infraestructura externa (objeto, otro host o agente del
proveedor) es obligatoria; el repositorio no inventa un destino.

`migrations` crea o desactiva primero como `NOLOGIN` las identidades PostgreSQL de servicio, exige que no queden
sesiones de runtime, aplica la matriz de privilegios y confirma su validación. Después, `db-role-bootstrap` toma
un mutex con espera acotada, vuelve a confirmar el fence `NOLOGIN` y, en una transacción final, repara la matriz,
valida que no haya sesiones antiguas y activa o rota juntas las ocho identidades. Si cualquier alteración falla,
PostgreSQL revierte la rotación completa y los roles permanecen `NOLOGIN`. Solo esos dos procesos reciben la conexión
administrativa; los diez runtimes usan su URL restringida y verifican `EXPECTED_DATABASE_ROLE` antes de registrar
rutas o workers. El orden obligatorio es:

```bash
docker compose --env-file .env -f infra/docker-compose.yml stop \
  identity-service tenant-service agent-service prompt-flow-service knowledge-service \
  audit-service integration-service pulso-iris-service whatsapp-channel-service lumen-service
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps migrations
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps db-role-bootstrap
```

La primera ejecución aplica, entre otras, los fences y `024-service-database-roles.sql`; la segunda vuelve a
aplicar y validar la matriz vigente antes de activar los roles. Después se verifican ambos logs, se despliegan los
servicios y se validan sus endpoints de readiness. Si el bootstrap informa sesiones activas o deja los roles
`NOLOGIN`, se completa el drenaje y se reintenta el bootstrap; no se corrige con `ALTER ROLE` manual.
La matriz y sus denegaciones esperadas están descritas en
[`architecture/POSTGRESQL-SERVICE-ROLES.md`](architecture/POSTGRESQL-SERVICE-ROLES.md).

El runner aplica por defecto `lock_timeout=10000ms` y `statement_timeout=300000ms` a cada migración. Sólo se
ajustan con enteros positivos en `MIGRATION_LOCK_TIMEOUT_MS` y `MIGRATION_STATEMENT_TIMEOUT_MS`, después de medir
la ventana; aumentar un valor no sustituye revisar el lock esperado. La migración 021 se divide en bloques
autocommit idempotentes y crea sus índices de forma concurrente. La procedencia Audit separa expansión y
backfill (026), contrato validado (027) e índice concurrente idempotente fuera de transacción (028). La migración
022 instala un trigger-fence antes del backfill histórico 023 para cubrir writers Channel N-1 que ya estaban en
curso.

En cada PR, CI construye todas las imágenes y resuelve de forma fail-closed el contrato del SHA base desde
`infra/compatibility-policy.json`. Si la base ya contiene el descriptor usa sus capacidades `current_v2` y
`deterministic_v2`; la única excepción bootstrap está ligada al SHA histórico exacto y declara los contratos
legacy. Una base legacy deja un inbound pre-outbox pendiente con el binario N-1 detenido; la migración/backfill lo
convierte en v1, current lo drena con compatibilidad temporal, cierra esa ventana y prueba un inbound v2. Una base
current conserva el escritor y los contratos v2 sin abrir una ventana legacy.

Después CI vuelve a las imágenes base exactas sobre el mismo volumen. Una base pre-durable valida su polling
Channel → SOFÍA original y no se presenta como productora de inbox/outbox inexistentes; una base `current_v2`
genera tráfico nuevo y exige Channel → PULSO → SOFÍA, posiciones durables, ejecución y outbound. La migración 038
protege por separado escritores v1 durables transicionales: sólo acepta tipos exactos y posiciones verificadas
contra el ledger propietario. CI comprueba además identidad del clúster, ledger, liveness y readiness en las etapas
aplicables. Para LUMEN, `legacy_ephemeral_v1` ensaya la
ventana administrativa cercada; `deterministic_v2` ensaya caída, expiración controlada de lease, recuperación y
eliminación del temporal sin degradar al protocolo legacy.

El rehearsal es deliberadamente HTTP: no prueba un mensaje JetStream pendiente creado por N-1 y el overlay sigue
siendo un piloto separado. Tampoco demuestra compatibilidad universal: antes de producción se debe ensayar una
copia de cardinalidad representativa, generar tráfico concurrente, medir locks y ejecutar operaciones de negocio
durante upgrade y rollback. Los timeouts y smokes fallan cerrado, pero no sustituyen esa validación operativa. Dos
checksums exactos de borradores no publicados de 021/026 se aceptan sólo para actualizar ambientes de ensayo tras
validar su catálogo; el rollback soportado es a la base real del PR, no a commits intermedios de esta rama.

## Demo clinica LUMEN

LUMEN usa datos sinteticos separados de la operacion real. Después de aplicar en orden todas las migraciones
versionadas vigentes —incluidos recuperación, contrato e índices de limpieza de audio— y activar la matriz de
roles, el único seed autorizado para este vertical es:

```bash
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps \
  migrations node packages/migrations/dist/seed-lumen-demo.js
```

Este comando usa `DATABASE_URL` solo dentro de la red privada de Compose; no se debe construir ni
exportar esa variable en el host. El seed usa una transaccion y un advisory lock, es idempotente y crea
un paciente, un profesional y un encuentro marcados como demo. Para retirarlos se ejecuta el mismo
comando con `--clear` al final, siempre antes de aprobar una HC. Un encuentro aprobado es inmutable y
el clear falla cerrado; su retencion o purga requiere un procedimiento clinico separado y controlado.
No ejecutar el seed general de PULSO IRIS para habilitar LUMEN.

La transcripcion real usa exclusivamente el endpoint batch Speech-to-Text de ElevenLabs con Scribe v2;
no crea llamadas ni agentes. La referencia oficial vigente es
[Create transcript](https://elevenlabs.io/docs/api-reference/speech-to-text/convert). La configuracion
autorizada es:

```dotenv
ELEVENLABS_API_KEY=
ELEVENLABS_STT_MODEL=scribe_v2
ELEVENLABS_STT_LANGUAGE=spa
ELEVENLABS_STT_TIMEOUT_MS=120000
ELEVENLABS_ZERO_RETENTION_MODE=true
LUMEN_AUDIO_TEMP_DIR=/tmp/lumen-audio
LUMEN_INSTANCE_ID=lumen-stateful-0
LUMEN_AUDIO_CLEANUP_RETRY_MS=30000
LUMEN_AUDIO_CLEANUP_BATCH_SIZE=25
LUMEN_AUDIO_CLEANUP_LEASE_TTL_MS=1800000
LUMEN_AUDIO_CLEANUP_HEARTBEAT_MS=30000
```

La clave debe provisionarse directamente en el `.env` privado del VPS mediante el canal secreto
autorizado. No copiar claves desde otros sistemas, logs, terminal compartida, chat ni archivos del repositorio.
Para comprobar solo nombres y presencia sin imprimir valores:

```bash
cd /opt/hyperion-platform
awk -F= '
  $1 ~ /^(ELEVENLABS_API_KEY|DEEPSEEK_API_KEY)$/ {
    value = substr($0, index($0, "=") + 1)
    print $1 "=" (length(value) > 0 ? "present" : "missing")
  }
' .env
```

Cada solicitud ElevenLabs envia `enable_logging=false`. `ELEVENLABS_ZERO_RETENTION_MODE=true` es
obligatorio y el servicio falla cerrado si se cambia o falta; no existe degradacion silenciosa a
retencion normal ni a otro proveedor. ElevenLabs documenta que Zero Retention Mode requiere una cuenta
elegible, normalmente Enterprise: consultar
[Zero Retention Mode](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode). La credencial
autorizada debe tener esa capacidad activa antes de la primera llamada real; si no la tiene, detener la
prueba y resolver la habilitacion con ElevenLabs.

La entrada acepta solo MIME de audio permitidos, maximo 5 MiB decodificados y duracion declarada entre
1 y 90 segundos. Antes de crear el temporal o llamar al proveedor, LUMEN deriva la duracion real del
contenedor y falla cerrado si no puede determinarla, supera 90 segundos o no coincide con la declarada;
los timestamps de palabras del proveedor aportan una segunda comprobacion. El archivo vive unicamente
en el `tmpfs` privado, no ejecutable y limitado del contenedor LUMEN. La finalizacion intenta eliminarlo
en exito, error, cancelacion y aborto; si el sistema de archivos no confirma el borrado, el intento queda
en `cleanup_pending` y el reconciliador de arranque y periodico lo reintenta antes de permitir un estado
terminal. Cada replica debe tener un `LUMEN_INSTANCE_ID` estable y exclusivo. No se guardan audio, rutas,
base64, identificadores crudos del proveedor ni transcript completo en logs. PostgreSQL conserva el
transcript, revision humana, proveedor/modelo, duracion verificada, estados, timestamps, hashes tecnicos e
idempotencia.

El reconciliador adquiere una lease exclusiva por `LUMEN_INSTANCE_ID`; una segunda réplica con el mismo valor
falla el arranque y la pérdida de heartbeat cambia `/ready` a HTTP 503. El TTL predeterminado es 30 minutos, su
mínimo es 20 minutos y el heartbeat predeterminado es 30 segundos. Un reemplazo conserva la identidad. En Compose,
el `tmpfs` privado se destruye al eliminar el contenedor y el proceso nuevo reconcilia tanto el intento
`processing` como la ausencia confirmada de su ruta determinista. Si otro orquestador usa almacenamiento temporal
persistente, debe volver a montar la misma frontera exclusiva hasta completar la limpieza. Para escalar se asignan
identidades y directorios distintos; nunca se duplica un owner en dos procesos.

Después de una terminación no controlada, el reemplazo con la misma identidad espera a que expire la lease anterior;
el intervalo de 20–30 minutos es un cerco deliberado que cubre el tiempo máximo de transcripción y apagado, no un
parámetro para acelerar manualmente. El workload debe derivar `LUMEN_INSTANCE_ID` de una identidad estable (por
ejemplo, el ordinal de un workload con estado), nunca de un nombre aleatorio de despliegue. Si queda trabajo
determinista no terminal de otra identidad cuya lease expiró o desapareció, todas las réplicas actuales pasan a
`not ready`: el operador debe restaurar esa misma identidad y su frontera de almacenamiento para reconciliarla. Una
réplica distinta no reclama ni borra automáticamente directorios ajenos.

### Ventana de rollback LUMEN N-1

La imagen exacta anterior a la migración 029 usa directorios aleatorios y no conoce `cleanup_owner`. No se debe
asignarle un owner ficticio ni permitir que el reconciliador actual calcule una ruta para esos intentos. Sólo puede
existir una ventana administrativa global, identificada por un scope nuevo con formato `lumen-n1-...`. Todos los
procesos LUMEN N-1 admitidos durante esa única ventana usan ese valor exacto en `LUMEN_N1_CLEANUP_SCOPE_ID` y
`PGAPPNAME`; no se pueden abrir scopes paralelos. Sus directorios temporales deben formar una frontera efímera
exclusiva y destruible en conjunto, como `tmpfs` privados. Un volumen persistente o compartido con otro workload
invalida este procedimiento.

Antes de abrir, se detienen los workloads current que serán reemplazados, se drena toda sesión `hyperion_lumen` y
se confirma que el bootstrap normal dejó los ocho roles completos, seguros y en `LOGIN`. El operador calcula fuera
de PostgreSQL el SHA-256 de la evidencia aprobada del rollback y abre la ventana con la imagen actual de migraciones
y su conexión administrativa privada:

```bash
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps \
  -e LUMEN_N1_CLEANUP_SCOPE_ID="$LUMEN_N1_CLEANUP_SCOPE_ID" \
  -e LUMEN_N1_ROLLBACK_EVIDENCE_SHA256="$LUMEN_N1_ROLLBACK_EVIDENCE_SHA256" \
  migrations node packages/migrations/dist/lumen-n-minus-one-compatibility.js open
```

`open` comparte el mutex global del bootstrap. Primero confirma `hyperion_lumen NOLOGIN` en una transacción y
sólo después crea la única ventana, concede la allow-list transitoria y reactiva esa identidad. Cualquier fallo
posterior al fence la deja en `NOLOGIN`. La allow-list contiene únicamente `USAGE` sobre `platform`/`pulso_iris`,
`SELECT` sobre el ledger de migraciones y las tres referencias PULSO que lee N-1, e `INSERT` sobre Audit. No concede
`UPDATE`, `DELETE`, ownership, membresías, capacidades de rol ni acceso a las tablas o funciones administrativas
de compatibilidad. El manifest de rollback debe usar `hyperion_lumen`; no se autoriza volver a la URL administrativa
del Compose antiguo.

Al terminar, se detienen todos los procesos LUMEN N-1, se destruyen sus contenedores/pods y la frontera efímera
completa, y se conservan fuera de PostgreSQL la hora y evidencia de esa destrucción. Después de drenar sus pools se
cierra la ventana global:

```bash
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps \
  -e LUMEN_N1_CLEANUP_SCOPE_ID="$LUMEN_N1_CLEANUP_SCOPE_ID" \
  migrations node packages/migrations/dist/lumen-n-minus-one-compatibility.js close
```

`close` no confía en `application_name`: confirma primero `hyperion_lumen NOLOGIN` y falla mientras exista
cualquier sesión de esa identidad. En ese caso el fence queda confirmado, la ventana permanece abierta y se debe
completar el drenaje antes de reintentar. Al cerrar revoca la allow-list transitoria, verifica sus denegaciones y
deja `hyperion_lumen NOLOGIN`; no reactiva un solo rol por separado.

Un intento N-1 sólo queda terminal si su propio finalizador confirmó la eliminación. Si falla, el trigger convierte
su escritura antigua a `cleanup_pending`; si el proceso cae, queda `processing`. El reconciliador actual filtra
ambos porque no conoce sus rutas aleatorias. Para resolverlos se debe demostrar primero, desde el orquestador, que
el contenedor/pod y toda la frontera temporal del scope fueron destruidos. La mera ausencia de una sesión PostgreSQL
no es esa prueba. Después de cerrar la ventana, y mientras `hyperion_lumen` sigue en `NOLOGIN`, se registra sólo el
hash de la evidencia, su timestamp y un UUID de atestación:

```bash
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps \
  -e LUMEN_N1_CLEANUP_SCOPE_ID="$LUMEN_N1_CLEANUP_SCOPE_ID" \
  -e LUMEN_N1_SCOPE_DESTRUCTION_CONFIRMED=true \
  -e LUMEN_N1_SCOPE_DESTROYED_AT="$LUMEN_N1_SCOPE_DESTROYED_AT" \
  -e LUMEN_N1_SCOPE_EVIDENCE_SHA256="$LUMEN_N1_SCOPE_EVIDENCE_SHA256" \
  -e LUMEN_N1_SCOPE_ATTESTATION_ID="$LUMEN_N1_SCOPE_ATTESTATION_ID" \
  migrations node packages/migrations/dist/lumen-n-minus-one-compatibility.js attest-destroyed-scope
```

El one-shot no inspecciona ni elimina archivos. Finaliza solamente filas `legacy_ephemeral_v1` del scope exacto y
registra `ephemeral_scope_destroyed`; el runtime LUMEN no tiene permisos para crear esa atestación. Los logs y la
evidencia cruda permanecen en el sistema operativo autorizado, no en PostgreSQL. Este mecanismo demuestra
compatibilidad del contrato de base de datos con N-1; no demuestra al proveedor real, carga representativa ni
autoriza audio clínico real.

La atestación debe terminar antes de retornar a current. Sólo entonces se ejecuta el bootstrap completo de los ocho
roles para restaurar `LOGIN`; ejecutarlo antes hace que la atestación falle cerrada. Como recuperación adicional, el
bootstrap vuelve a aplicar la allow-list normal, revoca grants transitorios y marca cualquier ventana abierta como
`bootstrap_reconciled`. Un `close` repetido sobre una ventana ya cerrada vuelve a comprobar las revocaciones sin
cambiar el estado de login vigente.

La estructuracion usa exclusivamente `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` y `DEEPSEEK_MODEL`.
La ausencia de ElevenLabs o DeepSeek se muestra como proveedor no configurado y la operacion falla
cerrada; nunca se genera una salida simulada ni se cambia a OpenAI. El transcript de proveedor se
conserva separado del transcript revisado. Toda HC queda en `draft`, con fuentes, confianza e
incertidumbres, hasta una accion humana explicita; el pipeline nunca aprueba automaticamente.

La captura y la carga de audio en navegador requieren HTTPS seguro o un origen loopback exacto. Mientras
la consola productiva se publique por HTTP, la URL IP bloquea toda salida de audio y mantiene unicamente
el transcript manual; tampoco debe solicitar permisos de microfono. Para una prueba controlada y autorizada
sin habilitar TLS global, crear un tunel local (no compartirlo ni usar `-g`):

```bash
ssh -N -L 127.0.0.1:19000:127.0.0.1:3000 usuario@host-vps
```

Con el tunel activo, abrir exactamente `http://localhost:19000/lumen/dictado`. La consola detecta
`localhost` y envia `/api` por su proxy interno al gateway. El destino remoto `3000` corresponde a
`WEB_CONSOLE_HOST_PORT` predeterminado; si el VPS lo cambia, sustituirlo por ese puerto real después de verificarlo.
Esto no requiere publicar PostgreSQL
ni abrir otro puerto. El operador debe iniciar personalmente la grabacion y conceder el permiso del
navegador; nadie debe pulsar el microfono ni aceptar permisos en su nombre. Usar solo una frase clinica
sintetica en el encuentro demo, nunca nombres, documentos ni datos de un paciente real.

### Despliegue de LUMEN

Después del backup validado y con `main` fusionado y verde, capturar IDs e imágenes de PostgreSQL, PULSO IRIS y
WhatsApp. Si el encuentro demo ya existe, no ejecutar ningún seed: el seed LUMEN corresponde sólo al
aprovisionamiento inicial controlado.

Primero clasificar el release. Si no agrega ni modifica migraciones, roles o contratos de base, el despliegue puede
ser acotado: construir y recrear únicamente LUMEN y, sólo si cambiaron, gateway y consola. No ejecutar los one-shots
de migración/bootstrap en esa ruta.

```bash
docker compose --env-file .env -f infra/docker-compose.yml build \
  lumen-service
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 lumen-service
# Si también cambió gateway o consola, construir y recrear sólo esos artefactos.
docker compose --env-file .env -f infra/docker-compose.yml build \
  api-gateway web-console
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 api-gateway
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 web-console
```

Si el release incluye cualquier migración o cambio de roles, deja de ser un despliegue acotado. Se usa la ventana
global descrita en “Migraciones y roles”: detener y drenar los diez runtimes con base de datos, ejecutar primero
`migrations` y después `db-role-bootstrap`, y sólo entonces volver a iniciar todos los servicios detenidos. Nunca
ejecutar esos one-shots mientras queden sesiones runtime.

```bash
# Construir todo antes del corte evita reiniciar un runtime modificado con una imagen anterior.
docker compose --env-file .env -f infra/docker-compose.yml build
docker compose --env-file .env -f infra/docker-compose.yml stop \
  identity-service tenant-service agent-service prompt-flow-service knowledge-service \
  audit-service integration-service pulso-iris-service whatsapp-channel-service lumen-service
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps migrations
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps db-role-bootstrap
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 300 \
  identity-service tenant-service agent-service prompt-flow-service knowledge-service \
  audit-service integration-service pulso-iris-service whatsapp-channel-service lumen-service
# Ejecutar cada comando siguiente sólo si cambió ese artefacto.
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 api-gateway
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 web-console
```

Esperar `healthy` antes de continuar y confirmar migraciones/checksums, readiness, rutas profundas y logs
sanitizados. Comparar IDs e imágenes antes/después: PostgreSQL nunca debe recrearse; PULSO y WhatsApp tampoco deben
cambiar salvo que el release los incluya explícitamente. Si gateway o consola no cambiaron, omitir únicamente su
`up`; la construcción completa anterior es deliberada para que ningún runtime modificado quede con una imagen vieja.
Nunca ejecutar el seed general para habilitar esta demo.

## Durabilidad del canal WhatsApp privado

En su camino normal el canal escribe los inbound aceptados y los receipts del proveedor en una spool
cifrada antes de proyectarlos en PostgreSQL. La spool vive bajo
`WHATSAPP_SESSION_DIR/.channel-event-spool`, con
directorios `0700`, archivos `0600`, nombres derivados por HMAC y contenido AES-256-GCM. Nunca se
deben copiar ni inspeccionar sus archivos para diagnosticar cuerpos; la telemetria usa solamente
codigos y conteos.

Variables operativas con valores por defecto seguros:

```dotenv
WHATSAPP_INBOUND_PERSIST_MAX_ATTEMPTS=3
WHATSAPP_INBOUND_PERSIST_RETRY_BASE_DELAY_MS=250
WHATSAPP_INBOUND_PERSIST_ATTEMPT_TIMEOUT_MS=10000
WHATSAPP_INBOUND_SPOOL_MAX_RECORDS=2000
WHATSAPP_INBOUND_SPOOL_MAX_BYTES=16777216
```

La spool no expira eventos automaticamente. Al alcanzar un limite o detectar corrupcion, el canal
queda degradado y requiere corregir almacenamiento/clave antes de continuar. No se afirma entrega
exactamente una vez en el transporte Baileys: despues de la retencion durable hay replay al menos una
vez y deduplicacion PostgreSQL por tenant, proveedor e identificador externo.

Si la spool no puede hacer la retencion durable, el canal intenta una proyeccion directa idempotente,
cierra el socket y queda degradado hasta una reconexion explicita **sin** llamar a `readMessages` del
proveedor. Si PostgreSQL tambien falla en ese borde (fallo dual), no hay ack de proveedor ni copia
durable: el evento ya visto por Baileys puede perderse tras reiniciar. Tras un fsync exitoso el canal
invoca `readMessages` antes de liberar la barrera de captura. Residual: Baileys puede haber emitido
acks de protocolo antes del handler asíncrono; esa ventana pre-evento sigue siendo limite del borde,
no una garantia exactamente-una-vez.
En un apagado controlado el proveedor cierra primero los sockets y espera hasta 5 segundos las capturas
ya iniciadas para que alcancen el fsync de la spool.

Los estados outbound son deliberadamente conservadores: `sent` significa que el proveedor devolvio
un `providerMessageId`; `delivered` y `read` requieren un receipt real. Nunca promover manualmente un
mensaje antiguo a `delivered`. Los receipts que llegan durante una indisponibilidad de PostgreSQL se
conservan en la misma spool y se reprocesan sin guardar el cuerpo del mensaje.

Si un receipt real llega antes de asociar su `providerMessageId`, PostgreSQL lo conserva sin cuerpo en
`channel_runtime.delivery_receipts` y lo reconcilia dentro de la misma transaccion que marca el outbound
como `sent`. La cuarentena es tenant-aware, deduplica por proveedor/ID/estado, conserva como maximo 2000
identidades de mensaje por tenant (con todos sus estados) y elimina identidades sin correlacion cuya
evidencia mas reciente supera 7 dias cuando ingresa un receipt nuevo.
Estos limites evitan que actividad historica o manual del linked device agote la spool.

## Comando base

```bash
docker compose --env-file .env -f infra/docker-compose.yml up --build -d
```
