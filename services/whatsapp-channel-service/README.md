# WhatsApp channel service

Canal privado y temporal de prueba para PULSO IRIS. El servicio usa Baileys sin Chromium, conserva el estado de vinculacion en un volumen privado y mantiene el QR exclusivamente en memoria.

## Configuracion

- `WHATSAPP_WEB_TEST_ENABLED`: debe ser `true` para permitir conexiones.
- `WHATSAPP_TEST_ALLOWED_NUMBERS`: lista separada por comas de numeros de prueba autorizados.
- `WHATSAPP_SESSION_DIR`: ruta del volumen privado para material de sesion.
- `WHATSAPP_PHONE_HASH_KEY`: clave de al menos 32 caracteres; si se omite, usa `INTERNAL_SERVICE_TOKEN` para el HMAC del telefono.
- `INTERNAL_SERVICE_TOKEN`: autentica todos los endpoints internos.

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

La fachada publica y el RBAC pertenecen a `integration-service` y `api-gateway`.

## Semantica de entrega

Baileys no ofrece una clave de idempotencia remota que permita demostrar si un envio interrumpido alcanzo WhatsApp. El outbox separa `processing`, fase recuperable previa al envio, de `sending`, que se persiste justo antes de llamar al proveedor. Un lease vencido en `processing` puede reintentarse; un lease vencido en `sending` o un resultado incierto pasa a `reconciliation_required` y nunca se reenvia automaticamente. Esta politica evita duplicados sin perder trabajo que todavia no habia llegado al proveedor; un operador debe conciliar los resultados ambiguos antes de cualquier reenvio manual.
