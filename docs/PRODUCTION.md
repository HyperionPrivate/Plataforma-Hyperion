# Produccion

Este repo esta preparado para datos operativos reales. La unica excepcion autorizada es la demo clinica
LUMEN descrita abajo, aislada y marcada con datos sinteticos; esos registros no se presentan como datos
reales ni deben entrar en los flujos operativos de PULSO IRIS.

## Secretos

- No se guardan claves reales en Git.
- Toda clave compartida por chat, correo o canal no secreto debe rotarse antes de dejarla como acceso permanente.
- `.env.example` solo muestra nombres de variables.
- `INTERNAL_SERVICE_TOKEN`, `POSTGRES_PASSWORD` y credenciales de proveedores deben vivir fuera del repositorio.

## VPS

El VPS debe quedar con acceso por llave SSH, firewall activo y login root por password deshabilitado despues del primer aprovisionamiento. El despliegue debe usar las variables reales del ambiente y no valores de ejemplo.

## Puertos

- Gateway: `${API_GATEWAY_HOST_PORT:-8080}`.
- Consola web: `${WEB_CONSOLE_HOST_PORT:-3000}`.
- PostgreSQL no se publica al host; solo queda disponible dentro de la red Docker.

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
`ln`, `sync`, `sha256sum`, `gzip` y Docker Compose; son dependencias ya presentes en el VPS Linux.

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
reemplazar backups anteriores para recuperarse de un fallo. La restauracion no forma parte de este
script: requiere un procedimiento separado, controlado, con destino explicitamente aprobado y una
ventana operativa propia.

Luego se verifica el log del servicio `migrations`, se despliega y se validan endpoints publicos.

## Demo clinica LUMEN

LUMEN usa datos sinteticos separados de la operacion real. Despues de aplicar en orden las migraciones
hasta `019-lumen-clinical-invariants.sql`, el unico seed autorizado para este vertical es:

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
```

La clave debe provisionarse directamente en el `.env` privado del VPS mediante el canal secreto
autorizado. No copiar claves desde VetIA, logs, terminal compartida, chat ni archivos del repositorio.
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
en el `tmpfs` privado, no ejecutable y limitado del contenedor LUMEN; se elimina en `finally` tanto en
exito como en error. No se guardan audio, base64, identificadores crudos del proveedor ni transcript
completo en logs. PostgreSQL conserva el transcript, revision humana, proveedor/modelo, duracion
verificada, estados, timestamps, hashes tecnicos e idempotencia.

La estructuracion usa exclusivamente `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` y `DEEPSEEK_MODEL`.
La ausencia de ElevenLabs o DeepSeek se muestra como proveedor no configurado y la operacion falla
cerrada; nunca se genera una salida simulada ni se cambia a OpenAI. El transcript de proveedor se
conserva separado del transcript revisado. Toda HC queda en `draft`, con fuentes, confianza e
incertidumbres, hasta una accion humana explicita; el pipeline nunca aprueba automaticamente.

La captura y la carga de audio en navegador requieren HTTPS seguro o un origen loopback exacto. Mientras
la consola productiva se publique por HTTP, la URL IP bloquea toda salida de audio y mantiene unicamente
el transcript manual; tampoco debe solicitar permisos de microfono. Para una prueba personal autorizada
sin habilitar TLS global, crear un tunel local (no compartirlo ni usar `-g`):

```bash
ssh -N -L 127.0.0.1:19000:127.0.0.1:19000 contabo
```

Con el tunel activo, abrir exactamente `http://localhost:19000/lumen/dictado`. La consola detecta
`localhost` y envia `/api` por su proxy interno al gateway, por lo que no requiere publicar PostgreSQL
ni abrir otro puerto. El operador debe iniciar personalmente la grabacion y conceder el permiso del
navegador; nadie debe pulsar el microfono ni aceptar permisos en su nombre. Usar solo una frase clinica
sintetica en el encuentro demo, nunca nombres, documentos ni datos de un paciente real.

### Despliegue acotado de LUMEN

Despues del backup validado y con `main` fusionado y verde, capturar primero IDs e imagenes de
PostgreSQL, PULSO IRIS y WhatsApp. Si el encuentro demo ya existe, no ejecutar ningun seed durante el
deploy. El seed LUMEN solo corresponde al aprovisionamiento inicial controlado, nunca a una
actualizacion de una demo existente.

Construir y migrar, y luego desplegar exclusivamente las imagenes modificadas en el orden backend,
gateway (solo si su codigo cambio) y consola. No ejecutar `up` sobre el proyecto completo:

```bash
docker compose --env-file .env -f infra/docker-compose.yml build \
  migrations lumen-service api-gateway web-console
docker compose --env-file .env -f infra/docker-compose.yml run --rm --no-deps \
  migrations node packages/migrations/dist/index.js
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 lumen-service
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 api-gateway
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --no-build \
  --wait --wait-timeout 120 web-console
```

Esperar el `healthy` de cada etapa antes de continuar. Confirmar `020-lumen-real-audio-pipeline.sql`,
readiness, rutas profundas y logs sanitizados. Antes y despues comparar IDs e imagenes de `postgres`,
`pulso-iris-service` y `whatsapp-channel-service`; deben permanecer exactamente iguales. Si el gateway
no cambio, omitir su build/up y confirmar tambien que conserva ID e imagen. Nunca ejecutar el seed
general para habilitar esta demo.

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
cierra el socket y queda degradado hasta una reconexion explicita. Si PostgreSQL tambien falla en ese
borde, el evento ya entregado por Baileys no es recuperable despues de reiniciar; se debe tratar como
perdida potencial, no como entrega garantizada. No se conserva una copia del cuerpo sin cifrar en heap.
En un apagado controlado el proveedor cierra primero los sockets y espera hasta 5 segundos las capturas
ya iniciadas para que alcancen el fsync de la spool; la ventana anterior a esa retencion sigue siendo un
limite del borde Baileys, no una garantia exactamente-una-vez.

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
