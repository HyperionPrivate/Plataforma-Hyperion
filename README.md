# Plataforma Hyperion

Base de producto para Hyperion con arquitectura de microservicios. Esta carpeta es la superficie de desarrollo real; los documentos viejos quedan solo como referencia.

## Que contiene

- Gateway HTTP para exponer la plataforma.
- Servicios separados para identidad, tenants, agentes, flujos, conocimiento, integraciones y auditoria.
- Contratos compartidos TypeScript/Zod.
- PostgreSQL como almacenamiento inicial.
- Consola web operativa para ver estado real de servicios.
- Docker Compose listo para variables reales de produccion.
- Canal temporal WhatsApp Web por QR y orquestacion durable de SOFIA sobre la agenda interna.

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

No se deben guardar credenciales reales en Git.

## Piloto WhatsApp + SOFIA

El adaptador `whatsapp_web_test` esta deshabilitado por defecto. Requiere configurar fuera de Git
`DEEPSEEK_API_KEY`, `WHATSAPP_TEST_ALLOWED_NUMBERS` e `INTERNAL_SERVICE_TOKEN`; el numero solo se
acepta desde la allowlist. El QR existe exclusivamente en memoria y la sesion de Linked Devices se
guarda en el volumen privado `whatsapp_sessions`.

La consola usa estas rutas tenant-scoped:

- `GET|POST /v1/tenants/:tenantId/integrations/whatsapp/...`
- `GET /v1/tenants/:tenantId/pulso-iris/sofia/readiness`

Solo `admin` conecta, consulta el QR o desconecta. `admin` y `coordinator` pueden leer estado y
readiness. Para rollback, deshabilitar `WHATSAPP_WEB_TEST_ENABLED`, revocar/desconectar el dispositivo
y detener solo `whatsapp-channel-service`; la agenda, conversaciones y auditoria permanecen intactas.
