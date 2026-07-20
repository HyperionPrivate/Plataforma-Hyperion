---
documentType: runbook
status: not-current
owner: platform-operations
issue: HYP-OPS-001
reviewDue: 2026-09-30
---

# Producción

> **No vigente para ejecutar despliegues o cortes.** Este documento conserva procedimientos de la topología
> global transicional y no ha sido revalidado frente a las celdas provider-owned. PULSO ya tiene migrador, base,
> roles, Compose y manifiesto propios en el repositorio, pero no existe aquí evidencia de cutover ni de un drill
> ejecutado sobre el ambiente objetivo. Este texto no autoriza un cambio productivo hasta validar backup/restore y
> el release exacto.

Este repositorio contiene controles y procedimientos para ambientes con datos operativos. La habilitación
productiva exige validar el despliegue, los backups y la recuperación del ambiente concreto. Este runbook no
autoriza datos clínicos reales en LUMEN: la única ejecución LUMEN cubierta es la demo sintética aislada; sus
registros no se presentan como reales ni deben entrar en los flujos operativos de PULSO IRIS.

## Secretos

- No se guardan claves reales en Git.
- Toda clave compartida por chat, correo o canal no secreto debe rotarse antes de dejarla como acceso permanente.
- `.env.example` contiene placeholders y valores no secretos para documentar la configuracion esperada.
- `HYPERION_ENVIRONMENT` es la clasificación canónica; sólo cuando está ausente se traduce `NODE_ENV`.
  Una variable presente pero vacía o un valor desconocido aborta el arranque en vez de asumir `local`. En
  `production` o `staging`, el runtime (`@hyperion/config` / `startService`) y el bootstrap de roles rechazan
  cualquier secreto requerido que coincida con
  `/^replace-/i` o con los valores exactos de `.env.example`.
- CI y ensayos locales que cargan `.env.example` deben declarar explícitamente
  `HYPERION_ENVIRONMENT=ci` o `local`. `CI=true` y la variable histórica
  `HYPERION_ALLOW_EXAMPLE_SECRETS` no reducen las barreras. En VPS real se fija
  `HYPERION_ENVIRONMENT=production` y se sustituyen todos los `replace-*`; Compose propaga esa clase de despliegue
  al gateway, migraciones, bootstrap y cada runtime.
- `POSTGRES_PASSWORD`, las siete contraseñas runtime que aún rota el bootstrap global, las credenciales
  provider-owned por célula y las de sus migradores deben permanecer separadas. Para PULSO son cinco contraseñas runtime más
  `PULSO_MIGRATOR_DATABASE_PASSWORD`; las credenciales HTTP por vínculo
  `*_TO_*_TOKEN` y las credenciales de proveedores deben vivir fuera del repositorio.
- Cada `*_TO_*_TOKEN` se entrega únicamente a su productor y consumidor, tiene al menos 24 caracteres
  seguros y no se reutiliza en otro vínculo, en PostgreSQL, en NATS ni con proveedores.
- Los tokens por vínculo son una barrera transicional. Un entorno empresarial debe añadir identidad de workload
  gestionada, mTLS y rotación externa sin retirar la autorización específica por productor/ruta.
- **A-02 (mitigado, no eliminado):** el gateway emite `x-hyperion-operator-assertion` (HMAC-SHA256 con
  `GATEWAY_OPERATOR_ASSERTION_KEY`) junto a `x-operator-id` / `x-operator-role`. Identity exige coincidencia
  exacta de operador y rol; PULSO IRIS, LUMEN, Integration, NOVA core, Voice, LIWA y Documents exigen además que
  la aserción vigente esté ligada al tenant y producto de la ruta. La clave es obligatoria y su ausencia impide arrancar esos runtimes en staging y
  producción; el fallback histórico sin firma queda limitado a local/CI. Así, un token de arista estático solo
  no basta para fabricar identidad, rol o tenant. Riesgo residual: quien robe **el token del vínculo y la clave
  de aserción** aún puede forjar claims hasta que se adopten mTLS e identidad de workload. Una aserción capturada
  también puede repetirse durante su vigencia máxima de 60 segundos, pero únicamente con el token del vínculo y
  para el mismo operador, rol y tenant (o para el contexto global admin que fue firmado).
- Las contraseñas `*_DATABASE_PASSWORD` son distintas entre sí, tienen al menos 24 caracteres URI no
  reservados y nunca se reutilizan como contraseña administrativa.

## VPS

El VPS debe quedar con acceso por llave SSH, firewall activo y login root por password deshabilitado despues del primer aprovisionamiento. El despliegue debe usar las variables reales del ambiente y no valores de ejemplo.

## Puertos

- Fachada gateway heredada: `127.0.0.1:${API_GATEWAY_HOST_PORT:-8080}`, sólo con el perfil `legacy-gateway`.
- Consola web: `${WEB_CONSOLE_HOST_PORT:-3000}`.
- PostgreSQL no se publica al host; solo queda disponible dentro de la red Docker.

La definición standalone PULSO enlaza por defecto BFF en `127.0.0.1:8097`, consola en `3000` y PostgreSQL de
desarrollo en `127.0.0.1:55440`; los nombres de sus variables están inventariados en
`infra/pulso.env.example`. Esa publicación de PostgreSQL es sólo para entorno aislado; un despliegue real debe
mantenerlo en red privada.

### Topología PULSO versionada

`infra/docker-compose.pulso.yml` describe una base lógica `hyperion_pulso` y esta secuencia obligatoria:

1. `pulso-database-bootstrap` crea el owner y cinco roles como `NOLOGIN`;
2. `pulso-migrations` aplica el manifiesto provider-owned como `hyperion_pulso_migrator`; y
3. `pulso-role-bootstrap` valida estructura/ACL, rota credenciales distintas y activa los roles runtime.

Después arrancan Agent, Prompt Flow, Knowledge, Integration, PULSO y WhatsApp; BFF y consola dependen sólo de la
célula y de URLs externas explícitas hacia Access/Audit. La configuración puede renderizarse sin mutar estado:

```bash
node scripts/docker/generate-cell-contexts.mjs --cell pulso
docker compose --env-file infra/pulso.env.example -f infra/docker-compose.pulso.yml config --quiet
```

No ejecutar `up` con `infra/pulso.env.example`: sus valores son placeholders y el render correcto no prueba
migración, arranque, backup, restore, RPO/RTO ni rollback.

### Topología Audit provider-owned

En el Compose transicional, `audit-service` depende sólo de
`audit-database-bootstrap` → `audit-migrations` → `audit-role-bootstrap` y PostgreSQL. Ejecutar
`docker compose --env-file .env.example -f infra/docker-compose.yml up audit-service` no incorpora
`migrations`, `db-role-bootstrap` ni `platform-migrations` a esa clausura. Los one-shots usan la base lógica
`hyperion_audit`, el owner `hyperion_audit_migrator` y el runtime append-only `hyperion_audit`; la readiness lee
exclusivamente `audit_runtime.migration_ledger`.

Esto describe el artefacto versionado, no autoriza un cutover de datos. El ledger global histórico y las tablas
Audit antiguas deben permanecer intactos hasta definir exportación, verificación de conteos/checksums, ventana de
doble lectura y rollback. El migrador nuevo sólo acepta una base fresh o una repetición con su checksum exacto.

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

PULSO exige una `DatabaseTransaction` activa para encolar cada auditoría de mutación relevante; si falla el
insert del outbox se revierte también el cambio de dominio. Channel confirma `channel.message.sent` y su evento de
auditoría en una sola transacción. Audit aplica ambos contratos con inbox idempotente. Asimismo, Channel no llama
el comando remoto de delivery dentro de su transacción: persiste `channel.delivery.updated.v1` con secuencia por
mensaje y PULSO lo proyecta en otra transacción inbox+dominio.

`TRUST_PROXY` queda vacío o `false` cuando el servicio es alcanzable directamente. Sólo debe configurarse detrás
de un proxy controlado y acepta una lista separada por comas de IP o CIDR explícitos. El runtime rechaza `true`,
hostnames, reglas inválidas y redes `/0`; documentar los hops reales antes de habilitarlo.

## JetStream

El transporte predeterminado del stack base sigue siendo HTTP. El overlay
`infra/docker-compose.jetstream.yml` usa identidades y ACL por servicio, pero permanece como piloto de un solo
nodo: una replica, DLQ con la misma retencion y sin alerta/redrive operativos. **No habilitarlo en produccion**
hasta desplegar cluster con replicas, TLS interno, limites de capacidad, monitorizacion y una prueba documentada de
recuperacion. El runtime y el bootstrap rechazan incondicionalmente `DURABLE_EVENT_TRANSPORT=jetstream` cuando
la clasificación canónica es `production` o `staging`. Declarar `PRODUCTION_JETSTREAM_ENABLED`,
`JETSTREAM_REPLICAS`, TLS, límites, monitorización o un runbook no promueve este overlay ni evita el bloqueo:
esas variables no sustituyen una topología real. Levantar el gate exige primero implementar y revisar en el
repositorio el cluster, las réplicas, TLS, capacidad, alertas/redrive, recuperación y sus pruebas/ADR. Hasta
entonces el overlay sólo se admite con `HYPERION_ENVIRONMENT=local|ci`; no existe un atajo declarativo que simule
alta disponibilidad.
Cuando se evalua en un ambiente aislado, los siete `NATS_*_PASSWORD` deben ser distintos y nunca
reutilizar credenciales HTTP `*_TO_*_TOKEN` ni contraseñas PostgreSQL. El bootstrap crea catorce durables
administrados: once activos, dos de compatibilidad v1 y el drenaje temporal `audit_event_record_v1`. Audit consume
por separado `sofia.audit.event.record.v1`, `lumen.audit.event.record.v1`, `pulso.audit.event.record.v1` y
`channel.audit.event.record.v1`; el durable genérico sólo drena mensajes publicados antes de la migración y los
marca `legacy-unknown`. Ninguna identidad runtime puede publicar nuevos eventos en el subject genérico. Cuando
el durable legado permanezca vacío durante una ventana superior a la retención, se elimina en una migración de
topología posterior. Con JetStream activo, los endpoints HTTP que reciben los sobres durables no se registran;
el `POST` directo de delivery Channel → PULSO se conserva autenticado exclusivamente para compatibilidad N-1 y
no es usado por el Channel actual. Esa superficie transitoria debe retirarse al cerrar la ventana N-1 y es otra
razón por la que el overlay actual no se declara productivo.

### Ensayo local aislado de JetStream

Este ensayo valida la secuencia de activacion sin tocar el proyecto Compose habitual ni datos operativos. Crear
`.env.rehearsal.local` a partir de `.env.example`, completar las siete contraseñas runtime aún globales, las dos
credenciales provider-owned de Audit, las cuatro runtime NOVA, la credencial del migrador NOVA, las siete de NATS,
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
API_GATEWAY_HOST_PORT=18080
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
  "--profile", "legacy-gateway",
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

No iniciar ningún runtime de la unidad heredada entre `migrations` y `db-role-bootstrap`: la migración deja las ocho
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

El resultado aprobado contiene `status=passed` y 19 campos de conteo: 16 deben valer `1`; los campos
`pulsoAuditOutbox`, `pulsoAuditInbox` y `pulsoAuditEffect` deben valer `2` porque se emiten dos auditorías PULSO.
El ensayo limpia después su tenant sintético.
Para Channel → PULSO, tanto el mensaje inbound como el delivery deben devolver ACK confirmado con
`deliveryCount=1`; una segunda lectura debe quedar en `idle`, sin NAK, redelivery ni DLQ. El inbound también debe
dejar vinculados en Channel el paciente, la conversación y el mensaje propietarios; comprobar sólo filas PULSO no
es evidencia suficiente.
Después se levantan consumidores de aguas abajo hacia aguas arriba, y finalmente la fachada opt-in y la consola.
`$Compose` activa `legacy-gateway` de forma explícita; sin ese perfil el build/up normal no incluye la fachada:

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
docker compose @Compose exec -T pulso-iris-service node -e `
  "fetch('http://127.0.0.1:8088/internal/v1/events/channel-delivery', { method: 'POST' }).then(r => { console.log(r.status); process.exit(r.status === 404 ? 0 : 1); })"
if ($LASTEXITCODE -ne 0) { throw "HTTP durable delivery ingress remains enabled for pulso-iris-service" }
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

`migrations` crea o desactiva primero como `NOLOGIN` las ocho identidades PostgreSQL de la unidad heredada, exige que no queden
sesiones de runtime, aplica la matriz de privilegios y confirma su validación. Después, `db-role-bootstrap` toma
un mutex con espera acotada, vuelve a confirmar el fence `NOLOGIN` y, en una transacción final, repara la matriz,
valida que no haya sesiones antiguas y activa o rota juntas esas ocho identidades. Si cualquier alteración falla,
PostgreSQL revierte la rotación completa y los roles permanecen `NOLOGIN`. El bootstrap global no recibe ninguna
contraseña NOVA. Los runtimes heredados usan su URL restringida y verifican `EXPECTED_DATABASE_ROLE` antes de registrar
rutas o workers. El orden obligatorio para esta unidad es:

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

NOVA usa una ventana independiente y no se incluye en los comandos anteriores: se drenan sus cuatro runtimes y se
ejecuta `nova-database-bootstrap` → `nova-migrations` → `nova-role-bootstrap`. Sólo el último one-shot recibe
`NOVA_DATABASE_PASSWORD`, `VOICE_DATABASE_PASSWORD`, `LIWA_DATABASE_PASSWORD` y `DOCUMENTS_DATABASE_PASSWORD`.

PULSO también tiene una secuencia independiente en `infra/docker-compose.pulso.yml`:
`pulso-database-bootstrap` → `pulso-migrations` → `pulso-role-bootstrap`. El runner recibe sólo
`PULSO_MIGRATOR_DATABASE_URL`; el último one-shot recibe `PULSO_DATABASE_PASSWORD`, `SOFIA_DATABASE_PASSWORD`,
`KNOWLEDGE_DATABASE_PASSWORD`, `INTEGRATION_DATABASE_PASSWORD` y `CHANNEL_DATABASE_PASSWORD`. Agent y Prompt Flow
validan `agent_runtime.schema_version/service_name=sofia`; Core, Knowledge, Integration y Channel continúan
temporalmente sobre `pulso_iris.schema_version/service_name=pulso`. SOFÍA conserva lectura del marker global sólo
para una futura imagen N−1 publicada; el runtime current no usa ese fallback. La secuencia global anterior se
conserva para compatibilidad y no debe mezclarse con la provider-owned en una misma ventana improvisada.

El artefacto PULSO revoca los grants históricos de readiness y de SOFÍA → PULSO en su propia matriz. Esos grants
todavía existen en la cadena global congelada para binarios N−1; sólo pueden retirarse allí durante un cutover
rehearsado. El trigger Access → PULSO ya no forma parte del camino current: plataforma lo elimina y PULSO crea sus
defaults de agenda idempotentemente en el primer uso autorizado.

El runner aplica por defecto `lock_timeout=10000ms` y `statement_timeout=300000ms` a cada migración. Sólo se
ajustan con enteros positivos en `MIGRATION_LOCK_TIMEOUT_MS` y `MIGRATION_STATEMENT_TIMEOUT_MS`, después de medir
la ventana; aumentar un valor no sustituye revisar el lock esperado. La migración 021 se divide en bloques
autocommit idempotentes y crea sus índices de forma concurrente. La procedencia Audit separa expansión y
backfill (026), contrato validado (027) e índice concurrente idempotente fuera de transacción (028). La migración
022 instala un trigger-fence antes del backfill histórico 023 para cubrir writers Channel N-1 que ya estaban en
curso.

La auditoría PULSO/Channel y la proyección de delivery también se migran por fases. 041 expande dedupe y el
contrato de procedencia Audit con checks `NOT VALID`; 042 construye sus índices únicos concurrentes y 043 valida
el contrato. 044 expande el contrato ordenado del inbox de delivery; 045 crea concurrentemente su unicidad por
tenant/servicio/stream/secuencia y 046 valida el check y el catálogo. Un índice interrumpido se elimina y recrea
antes de que el ledger avance, pero el cutover sigue requiriendo medir locks y duración sobre una copia
representativa.

Los PR ejecutan los workflows de celda `platform`, `nova`, `lumen` y `pulso` solo cuando el grafo los marca como
afectados; el stack completo queda en `main` y en la ejecución programada. El rehearsal completo resuelve de forma
fail-closed el contrato del SHA base desde `infra/compatibility-policy.json`. Si la base ya contiene el descriptor usa sus capacidades `current_v2`,
`deterministic_v2` y `owner_api_v2`; la única excepción bootstrap está ligada al SHA histórico exacto y declara
por separado Channel pre-outbox, audio efímero, acceso SOFÍA → PULSO y validación de delivery Channel → PULSO por
SQL heredado. Una base legacy deja un
inbound pre-outbox pendiente con el binario N-1 detenido; la migración/backfill lo convierte en v1, current lo
drena con compatibilidad temporal, cierra esa ventana y prueba un inbound v2. Una base current conserva el escritor
y los contratos v2 sin abrir una ventana legacy.

Después CI vuelve a las imágenes base exactas sobre el mismo volumen. Una base pre-durable valida su polling
Channel → SOFÍA original y no se presenta como productora de inbox/outbox inexistentes; una base `current_v2`
genera tráfico nuevo y exige Channel → PULSO → SOFÍA, posiciones durables, ejecución y outbound. La migración 038
protege por separado escritores v1 durables transicionales: sólo acepta tipos exactos y posiciones verificadas
contra el ledger propietario. CI comprueba además identidad del clúster, ledger, liveness y readiness en las etapas
aplicables. Para LUMEN, `legacy_ephemeral_v1` ensaya la
ventana administrativa cercada; `deterministic_v2` ensaya caída, expiración controlada de lease, recuperación y
eliminación del temporal sin degradar al protocolo legacy.

Después de detener los workloads current y antes de iniciar cualquier imagen N-1, el rehearsal arranca únicamente
PostgreSQL. Un preflight inserta y elimina evidencia sintética para comprobar que el gate real rechaza
`queued`, `retry_scheduled`, `processing` y `dead_letter`, y acepta `published`; después exige que cada evento
`channel.delivery.updated.v1` real esté `published` y guarda un fingerprint de todas esas filas. Una base
pre-durable abre sólo durante su polling la siguiente allow-list para `hyperion_pulso`:

- `USAGE` en el esquema `channel_runtime`;
- `SELECT` en `thread_bindings(id, patient_id, conversation_id, tenant_id)`;
- `UPDATE` en `thread_bindings(patient_id, conversation_id, last_inbound_at, updated_at)`;
- `SELECT` en `inbound_events(tenant_id, external_message_id, provider)`;
- `UPDATE` en `inbound_events(thread_binding_id, message_id, updated_at)`.

El probe de Channel rechaza permisos de tabla completa o cualquier columna adicional. También antes de iniciar
workloads, una base `legacy_direct_sql_v1` reconstruye el baseline de lectura de
`hyperion_sofia` y abre únicamente `UPDATE(metadata, primary_intent, updated_at)` en `conversations`, más
`INSERT(tenant_id, conversation_id, sender, body, provider, external_message_id, delivery_status, metadata)` y
`UPDATE(body)` en `messages`. El verificador rechaza propiedad de objetos PULSO, membresías, grant options,
escrituras de tabla completa, columnas DML adicionales, lectura de otras tablas, secuencias y rutinas; además
autoriza formas representativas de las sentencias ejercitadas del binario histórico dentro de una transacción sin
filas.

El Channel de esa misma base tiene una capacidad independiente `legacy_direct_sql_v1`: antes de los workloads se
abre `USAGE` en `pulso_iris`, `SELECT` sólo sobre
`messages(id, tenant_id, conversation_id, sender, body, provider, delivery_status, delivered_at, metadata)` y
`UPDATE` sólo sobre
`messages(provider, provider_message_id, delivery_status, delivered_at, metadata)`. Esto cubre la validación de la
fuente y las transiciones históricas de delivery; no concede permisos de tabla completa, otras tablas, secuencias,
rutinas, ownership, membresías ni grant options. El Channel actual declara `owner_api_v2` y no abre esta ventana.

El paso separado con `if: always()` detiene primero Agent, Prompt Flow, Channel y PULSO, conserva sus contenedores
para diagnóstico, compara el fingerprint de delivery, cierra cada ventana aplicable de forma idempotente y verifica
el estado cerrado aunque una apertura haya quedado incompleta. En `channel_runtime` no puede quedar ningún acceso de
`hyperion_pulso`; en `pulso_iris`, `hyperion_sofia` vuelve exactamente a `USAGE` y a los tres `SELECT` transitorios
del baseline vigente de la matriz 024, sin escrituras. El cierre elimina además todo acceso de `hyperion_channel` a
`pulso_iris`. Como los binarios históricos necesitan esas excepciones, el cierre termina también su capacidad
operativa: el ensayo certifica un rollback temporal y supervisado, no un estado
N-1 autónomo que pueda mantenerse indefinidamente.

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
  -e LUMEN_DEMO_TENANT_ID=<tenant-uuid> \
  migrations node packages/migrations/dist/seed-lumen-demo.js
```

Este comando usa `DATABASE_URL` solo dentro de la red privada de Compose; no se debe construir ni
exportar esa variable en el host. `LUMEN_DEMO_TENANT_ID` es obligatorio, debe ser el UUID opaco provisionado
por Access y no puede sustituirse por un slug de cliente. El seed usa una transaccion y un advisory lock, es idempotente y crea
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
se confirma que el bootstrap global dejó sus siete roles completos, seguros y en `LOGIN`; Audit y los cinco roles NOVA no
forman parte de esta ventana LUMEN. El operador calcula fuera
de PostgreSQL el SHA-256 de la evidencia aprobada del rollback y abre la ventana con la imagen actual de migraciones
y su conexión administrativa privada:

```bash
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps \
  -e LUMEN_N1_COMPAT_ENABLED=true \
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
  -e LUMEN_N1_COMPAT_ENABLED=true \
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
  -e LUMEN_N1_COMPAT_ENABLED=true \
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

La atestación debe terminar antes de retornar a current. Sólo entonces se ejecuta el bootstrap global de los siete
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
docker compose --env-file .env --profile legacy-gateway -f infra/docker-compose.yml build \
  api-gateway web-console
docker compose --env-file .env --profile legacy-gateway -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 api-gateway
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 web-console
```

Si el release incluye cualquier migración o cambio de roles heredado, deja de ser un despliegue acotado. Se usa la
ventana global descrita en “Migraciones y roles”: detener y drenar los diez runtimes heredados con base de datos,
ejecutar primero `migrations` y después `db-role-bootstrap`, y sólo entonces volver a iniciar todos los servicios detenidos. Nunca
ejecutar esos one-shots mientras queden sesiones runtime.

```bash
# Construir todo antes del corte evita reiniciar un runtime modificado con una imagen anterior.
docker compose --env-file .env --profile legacy-gateway -f infra/docker-compose.yml build
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
docker compose --env-file .env --profile legacy-gateway -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 api-gateway
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 web-console
```

El perfil sólo conserva coexistencia; no resuelve `DEBT-032`, no convierte el gateway en borde objetivo y no
autoriza tráfico público nuevo. Esperar `healthy` antes de continuar y confirmar migraciones/checksums, readiness, rutas profundas y logs
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

El comando siguiente levanta el stack global de compatibilidad descrito por este runbook no vigente; no es el
comando de despliegue de la célula PULSO provider-owned.

```bash
docker compose --profile legacy-gateway --env-file .env -f infra/docker-compose.yml up --build -d
```
