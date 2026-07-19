---
documentType: runbook
status: not-current
owner: nova-channels
issue: HYP-NOVA-014
reviewDue: 2026-09-30
---

# LIWA webhook cutover (NOVA)

> **No vigente para producción.** Las instrucciones de laboratorio conservan valor diagnóstico, pero el corte debe
> revalidarse con dominio HTTPS estable o túnel privado, secreto rotado y aserción de operador firmada.

Inbound webhooks **no se configuran por API** (ausentes en Swagger). Se pegan en la UI LIWA:
Herramientas → Webhooks / nodos del flow **Renovaciones** (`1782399915832`).

## URL Hyperion

```text
https://<tu-host-publico>/v1/liwa/webhooks
```

Autenticación obligatoria:

```text
Header: X-LIWA-WEBHOOK-SECRET: <mismo valor que LIWA_WEBHOOK_SECRET en .env>
```

No se admiten secretos en query string ni webhooks HTTP. Si la UI del proveedor no
permite enviar el header, el corte queda bloqueado hasta disponer de un proxy privado
que inyecte el header; el secreto nunca debe quedar en URL, logs o historial.

El ingress público NOVA no expone rutas de simulación. La normalización y autenticación de payloads de laboratorio
se comprueban sin publicar un webhook mediante la suite local del servicio:

```powershell
pnpm --filter @hyperion/liwa-channel-service test
```

## Túnel temporal (dev)

1. Arrancar la celda NOVA standalone; el BFF queda ligado sólo a loopback:

```bash
docker compose --env-file .env.nova -f infra/docker-compose.nova.yml up -d nova-bff liwa-channel-service
```

2. Túnel privado/temporal con terminación TLS hacia el ingress NOVA (`8095`):

```bash
cloudflared tunnel --url http://127.0.0.1:8095
```

3. URL TLS = `https://<subdominio-temporal>/v1/liwa/webhooks`.
   `nova-bff` proxya sólo la ruta exacta a `liwa-channel-service`, sin auth de sesión y preservando únicamente el
   header secreto del proveedor.

Si el túnel se reinicia, la URL puede cambiar: actualiza el webhook en LIWA y retíralo al terminar la prueba.

## Payload canónico (runbook piloto)

```json
{
  "event": "document_received",
  "phone": "+573002555948",
  "external_id": "t1",
  "ciudad": "Bucaramanga",
  "filename": "orden_matricula.pdf",
  "kind": "orden_matricula"
}
```

Eventos: `document_received` | `prequal_completed` | `handoff_requested` | `csat` | `tipificacion` | `opt_out` | `message`  
Aliases aceptados: `documento`, `asesor`, `nps`, `baja`, `tipify`, `mensaje`, `chat`, etc.

Clon de chat en NOVA Conversaciones:

| Evento LIWA                                        | Efecto en NOVA                                  |
| -------------------------------------------------- | ----------------------------------------------- |
| `document_received`                                | CRM documento + burbuja inbound (kind=document) |
| `handoff_requested`                                | Handoff cola + burbuja system                   |
| **`message` (+ `text`) — obligatorio para espejo** | Burbuja Asociado (texto libre)                  |
| **`bot_message` (+ `text`) — clon exacto del bot** | Burbuja Bot (texto de la plantilla/burbuja)     |
| Reply asesor                                       | Burbuja outbound + `send/text` LIWA             |

Sin nodo External API `event=message` en el paso donde el usuario escribe, Conversaciones **no** ve el chat aunque WhatsApp funcione.  
Sin `bot_message` tras cada burbuja del bot, Conversaciones solo ve el placeholder del flow y los replies humanos (LIWA **no** expone historial por API — sonda 2026-07-17).  
Cutover Contabo ordenado + guía de nodos: [CONTABO_CHAT_ESPEJO_CUTOVER.md](CONTABO_CHAT_ESPEJO_CUTOVER.md).

```json
{
  "event": "message",
  "phone": "+573004198710",
  "text": "Quiero renovar mi crédito",
  "external_id": "chat-1"
}
```

```json
{
  "event": "bot_message",
  "phone": "+573004198710",
  "text": "Hola, soy el asistente de CoopFuturo. ¿En qué te ayudo?",
  "external_id": "renov-bot-1"
}
```

## Binding de tenant

```bash
DATABASE_URL=... LIWA_ACCOUNT_ID=<cuenta-liwa> LIWA_BIND_TENANT_ID=<uuid-coopfuturo> node scripts/autonomy/liwa-bind-tenant.mjs
```

Cuenta LIWA: `LIWA_ACCOUNT_ID=1656233` (Coopfuturo 2026 Cta Comercial).

La cuenta debe existir como binding único en `liwa.tenant_bindings`. El servicio ignora cualquier `tenant_id` del
payload y rechaza un `account_id` o `page_id` diferente al configurado; no existe fallback por teléfono, contacto ni
tenant predeterminado. La entrega se considera persistida sólo cuando el receipt y sus eventos outbox confirman la
misma transacción.

## Verificación

1. Simular con secret en Hyperion.
2. Disparar nodo real del flow.
3. Confirmar `liwa.webhook_receipts` + outbox LIWA; repetir el mismo `external_id` y verificar `deduped=true` sin un
   segundo efecto en nova-core.
