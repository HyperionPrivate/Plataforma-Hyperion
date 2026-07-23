# WhatsApp channel service

Canal privado y temporal de prueba para PULSO IRIS. El servicio usa Baileys sin Chromium, conserva el estado de vinculacion en un volumen privado y mantiene el QR exclusivamente en memoria.

## Configuracion

- `WHATSAPP_WEB_TEST_ENABLED`: debe ser `true` para permitir conexiones.
- `WHATSAPP_TEST_ALLOWED_NUMBERS`: lista separada por comas de numeros de prueba autorizados.
- `WHATSAPP_SESSION_DIR`: ruta del volumen privado para material de sesion.
- `WHATSAPP_PHONE_HASH_KEY`: clave dedicada de 32 a 512 caracteres seguros para el HMAC del teléfono; no se reutiliza como credencial HTTP.
- `INTEGRATION_TO_CHANNEL_TOKEN`: autoriza únicamente las operaciones de estado, conexión, QR y desconexión desde Integration.
- `SOFIA_TO_CHANNEL_TOKEN`: autoriza únicamente el envío y las rutas transitorias de consumo desde SOFÍA.
- `PULSO_TO_CHANNEL_TOKEN`: autoriza la consulta de posición durante una ventana v1 y las rutas actuales de
  consulta/vinculación del thread propietario; no autoriza operaciones de Integration ni de SOFÍA.
- `CHANNEL_TO_PULSO_TOKEN` y `CHANNEL_TO_AUDIT_TOKEN`: credenciales salientes separadas para los dispatchers HTTP
  y los comandos síncronos estrictamente necesarios. En JetStream se usan identidades NATS separadas.
- `ACCESS_TO_CHANNEL_TOKEN`: credencial exclusiva del productor Access para el fallback HTTP de
  `access.tenant.snapshot.v1`; el transporte JetStream usa el durable `channel_access_tenant_snapshot_v1`.

No se deben registrar QR, cuerpos de mensajes, numeros completos ni archivos del directorio de sesion. El rollback consiste en deshabilitar `WHATSAPP_WEB_TEST_ENABLED`, llamar `disconnect` para revocar el dispositivo y detener solo este servicio.

## API interna

- `GET /internal/v1/tenants/:tenantId/whatsapp/status`
- `POST /internal/v1/tenants/:tenantId/whatsapp/connect`
- `GET /internal/v1/tenants/:tenantId/whatsapp/qr`
- `POST /internal/v1/tenants/:tenantId/whatsapp/disconnect`
- `POST /internal/v1/tenants/:tenantId/whatsapp/messages`
- `POST /internal/v1/whatsapp/inbound/claim`
- `POST /internal/v1/tenants/:tenantId/whatsapp/inbound/:eventId/complete`
- `POST /internal/v1/tenants/:tenantId/whatsapp/inbound/:eventId/fail`
- `GET /internal/v1/tenants/:tenantId/channel-inbound/:eventId/stream-position`
- `GET /internal/v1/tenants/:tenantId/whatsapp/threads/:threadBindingId`
- `POST /internal/v1/tenants/:tenantId/whatsapp/threads/:threadBindingId/bind`
- `POST /internal/v1/events/access-tenant-snapshots`

Las rutas de posición y thread validan conjuntamente `x-hyperion-caller=pulso-iris-service` y
`PULSO_TO_CHANNEL_TOKEN`; el bind asocia paciente, conversación y mensaje dentro de una transacción Channel. La
fachada publica y el RBAC pertenecen a `integration-service` y `api-gateway`.

## Semantica de entrega

Baileys no ofrece una clave de idempotencia remota que permita demostrar si un envio interrumpido alcanzo WhatsApp. El outbox separa `processing`, fase recuperable previa al envio, de `sending`, que se persiste justo antes de llamar al proveedor. Un lease vencido en `processing` puede reintentarse; un lease vencido en `sending` o un resultado incierto pasa a `reconciliation_required` y nunca se reenvia automaticamente. Esta politica evita duplicados sin perder trabajo que todavia no habia llegado al proveedor; un operador debe conciliar los resultados ambiguos antes de cualquier reenvio manual.

Cada transición de delivery agrega `channel.delivery.updated.v1` al outbox Channel en la misma transacción. Los
eventos forman un stream monotónico por mensaje, de modo que un retry del estado N impide adelantar N+1. PULSO
registra el evento en su inbox y aplica el resultado idempotentemente; el Channel actual no ejecuta el `POST`
directo de actualización PULSO, que permanece en el consumidor sólo como compatibilidad N-1.

Cuando un outbound pasa a `sent`, Channel agrega además `channel.audit.event.record.v1` en la misma transacción que
la mutación. Audit deduplica por `event_id` antes de escribir el ledger. Los dispatchers reintentan por HTTP, que
es el transporte predeterminado, o publican el mismo sobre mediante el overlay JetStream opt-in; cambiar el
transporte no cambia la semántica outbox/inbox. El overlay sigue siendo un piloto de un nodo y no está aprobado
para producción.
