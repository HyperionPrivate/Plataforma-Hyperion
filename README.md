# Plataforma Hyperion

Base de producto para Hyperion con arquitectura de microservicios. Esta carpeta es la superficie de desarrollo real; los documentos viejos quedan solo como referencia.

## Que contiene

- Gateway HTTP para exponer la plataforma.
- Servicios separados para identidad, tenants, agentes, flujos, conocimiento, integraciones y auditoria.
- Contratos compartidos TypeScript/Zod.
- PostgreSQL compartido como etapa de transicion, con identidad y privilegios distintos por contexto.
- Consola web operativa para ver estado real de servicios.
- Docker Compose listo para variables reales de produccion.
- Canal temporal WhatsApp Web por QR y orquestacion durable de SOFIA sobre la agenda interna.
- Primer flujo autonomo Channel -> PULSO -> SOFIA -> Audit con outbox/inbox HTTP y JetStream opt-in.
- LUMEN con esquema, readiness, proyecciones, inbox y outbox propios, sin SQL de runtime sobre Access o PULSO.

## Comandos

```bash
pnpm install
pnpm check
pnpm dev:gateway
pnpm dev:web
```

Para levantar todo con contenedores:

```bash
copy .env.example .env
docker compose --env-file .env -f infra/docker-compose.yml up --build
```

Antes de levantar Compose se reemplazan el secreto administrador, las ocho contraseñas PostgreSQL de servicio y
los demas placeholders. `db-role-bootstrap` crea o rota los roles antes de que `migrations` aplique sus grants;
los runtimes nunca reciben la URL administrativa. No se deben guardar credenciales reales en Git.

JetStream permanece opcional y no sustituye el transporte HTTP predeterminado:

```bash
docker compose --env-file .env \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.jetstream.yml up --build
```

El overlay exige seis passwords NATS distintos y aprovisiona siete durables activos más uno temporal de drenaje
para auditoría legada. SOFIA y LUMEN publican auditoria en subjects separados por origen; ninguna identidad de
runtime puede publicar en el subject genérico anterior. Es un
piloto de un solo nodo, no una configuracion de alta disponibilidad. La decision completa esta en
[`docs/architecture/AUTONOMOUS-MICROSERVICES.md`](docs/architecture/AUTONOMOUS-MICROSERVICES.md).

## Piloto WhatsApp + SOFIA

El adaptador `whatsapp_web_test` esta deshabilitado por defecto. Requiere configurar fuera de Git
`DEEPSEEK_API_KEY`, `WHATSAPP_TEST_ALLOWED_NUMBERS` e `INTERNAL_SERVICE_TOKEN`; el numero solo se
acepta desde la allowlist. El QR existe exclusivamente en memoria y la sesion de Linked Devices se
guarda en el volumen privado `whatsapp_sessions`. Antes de intentar PostgreSQL, cada inbound aceptado
y cada receipt de entrega se retiene en una spool cifrada AES-256-GCM dentro del mismo volumen. La
spool esta acotada por cantidad y bytes; nunca expone cuerpos en logs o telemetria y nunca los guarda
sin cifrar. Conserva el `externalMessageId` para
que el indice unico de PostgreSQL haga seguro el replay tras una caida o reinicio.

La entrega no se presenta como exactamente-una-vez en el borde no oficial de WhatsApp: una vez que el
evento entra en la spool, el canal lo reprocesa al menos una vez y PostgreSQL evita el doble efecto. Si
la spool no puede retener un evento, el canal intenta una proyeccion directa idempotente y se degrada
sin reconectar automaticamente. Si tambien falla PostgreSQL, no existe una copia recuperable tras
reinicio; este borde se reporta como perdida potencial y no como entrega garantizada. Un outbound
`sent` solo prueba que Baileys devolvio un identificador; cambia a
`delivered` o `read` unicamente al recibir evidencia del proveedor.

Los receipts que se adelantan a la asociacion del identificador quedan en una cuarentena PostgreSQL
sin cuerpos (maximo 2000 identidades por tenant con todos sus estados, retencion de 7 dias desde la
evidencia mas reciente) y se reconcilian atomicamente al marcar el outbound como enviado.

Controles operativos (los valores son limites, no secretos):

- `WHATSAPP_INBOUND_PERSIST_MAX_ATTEMPTS` y `WHATSAPP_INBOUND_PERSIST_RETRY_BASE_DELAY_MS` controlan
  el reintento inmediato con el mismo evento.
- `WHATSAPP_INBOUND_PERSIST_ATTEMPT_TIMEOUT_MS` impide que una proyeccion bloqueada deje el canal en
  estado listo indefinidamente.
- `WHATSAPP_INBOUND_SPOOL_MAX_RECORDS` y `WHATSAPP_INBOUND_SPOOL_MAX_BYTES` limitan la spool durable.
- `WHATSAPP_PHONE_HASH_KEY` debe mantenerse estable mientras existan entradas pendientes, porque
  tambien deriva la clave de cifrado de la spool.

La consola usa estas rutas tenant-scoped:

- `GET|POST /v1/tenants/:tenantId/integrations/whatsapp/...`
- `GET /v1/tenants/:tenantId/pulso-iris/sofia/readiness`

Solo `admin` conecta, consulta el QR o desconecta. `admin` y `coordinator` pueden leer estado y
readiness. Para rollback, deshabilitar `WHATSAPP_WEB_TEST_ENABLED`, revocar/desconectar el dispositivo
y detener solo `whatsapp-channel-service`; la agenda, conversaciones y auditoria permanecen intactas.
