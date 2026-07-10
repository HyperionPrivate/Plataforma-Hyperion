# Produccion

Este repo esta preparado para datos reales, no para demos con datos inventados.

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

Antes de aplicar cualquier migracion nueva o redeploy productivo en el VPS se debe crear un dump comprimido de PostgreSQL fuera de Git:

```bash
mkdir -p /opt/hyperion-platform/backups
docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres \
  sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > "/opt/hyperion-platform/backups/hyperion-$(date +%Y%m%d-%H%M%S).dump.gz"
```

Luego se verifica el log del servicio `migrations`, se despliega y se validan endpoints publicos. La carpeta `backups/` queda ignorada por Git.

Para considerar valido el backup comprimido se deben comprobar las cuatro evidencias sin imprimir
credenciales: `gzip -t`,
`gzip -dc "$backup" | docker compose --env-file .env -f infra/docker-compose.yml exec -T postgres pg_restore --list`,
tamano mayor que cero y SHA-256. Registrar el nombre, tamano, cantidad de entradas del catalogo y hash
antes de desplegar.

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
