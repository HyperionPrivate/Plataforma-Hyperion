# WhatsApp channel service

Canal privado y temporal de prueba para PULSO IRIS. El servicio usa Baileys sin Chromium, conserva el estado de vinculacion en un volumen privado y mantiene el QR exclusivamente en memoria.

## Configuracion

- `WHATSAPP_WEB_TEST_ENABLED`: debe ser `true` para permitir conexiones.
- `WHATSAPP_TEST_ALLOWED_NUMBERS`: lista separada por comas de numeros de prueba autorizados.
- `WHATSAPP_SESSION_DIR`: ruta del volumen privado para material de sesion.
- `WHATSAPP_PHONE_HASH_KEY`: clave dedicada de 32 a 512 caracteres seguros para el HMAC del teléfono; no se reutiliza como credencial HTTP.
- `INTEGRATION_TO_CHANNEL_TOKEN`: autoriza únicamente las operaciones de estado, conexión, QR y desconexión desde Integration.
- `SOFIA_TO_CHANNEL_TOKEN`: autoriza únicamente el envío y las rutas transitorias de consumo desde SOFÍA.
- `PULSO_TO_CHANNEL_TOKEN`: autoriza únicamente la consulta interna de la posición propietaria de un evento Channel durante una ventana v1 compatible.
- `CHANNEL_TO_PULSO_TOKEN` y `CHANNEL_TO_AUDIT_TOKEN`: credenciales salientes separadas para cada destino.

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

La fachada publica y el RBAC pertenecen a `integration-service` y `api-gateway`.

## Semantica de entrega

Baileys no ofrece una clave de idempotencia remota que permita demostrar si un envio interrumpido alcanzo WhatsApp. El outbox separa `processing`, fase recuperable previa al envio, de `sending`, que se persiste justo antes de llamar al proveedor. Un lease vencido en `processing` puede reintentarse; un lease vencido en `sending` o un resultado incierto pasa a `reconciliation_required` y nunca se reenvia automaticamente. Esta politica evita duplicados sin perder trabajo que todavia no habia llegado al proveedor; un operador debe conciliar los resultados ambiguos antes de cualquier reenvio manual.

La entrega Channel → PULSO usa outbox/inbox. En cambio, la notificación directa `channel.message.sent` hacia Audit
es HTTP best-effort: no participa en la transacción del outbox, no tiene retry durable y puede perderse si Audit no
está disponible. `CHANNEL_TO_AUDIT_TOKEN` autentica esa arista, pero no convierte la entrega en durable.
