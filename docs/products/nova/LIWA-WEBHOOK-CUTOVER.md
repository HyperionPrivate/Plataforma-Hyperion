# LIWA webhook cutover (NOVA)

Inbound webhooks **no se configuran por API** (ausentes en Swagger). Se pegan en la UI LIWA:
Herramientas → Webhooks / nodos del flow **Renovaciones** (`1782399915832`).

## URL Hyperion

```text
https://<tu-host-publico>/v1/liwa/webhooks
```

Autenticación (cualquiera de estas):

```text
Header: X-LIWA-WEBHOOK-SECRET: <mismo valor que LIWA_WEBHOOK_SECRET en .env>
# o, si Tools→Webhooks no permite headers:
URL: https://<host>/v1/liwa/webhooks?secret=<LIWA_WEBHOOK_SECRET>
```

La URL con `?secret=` está en `docs/products/nova/LIWA-WEBHOOK-LIVE-URL.txt` (local, no commitear el secret).

Fallback local (`HYPERION_ENVIRONMENT=local` + `LIWA_WEBHOOK_ALLOW_INSECURE=1`): acepta sin secret. Solo cutover.

Lab local (mismo secret):

```text
POST /v1/liwa/webhooks/simulate
```

## Túnel temporal (dev)

1. Publicar LIWA (opcional) + gateway:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.liwa-tunnel.yml --env-file .env up -d api-gateway liwa-channel-service
```

2. Quick tunnel Cloudflare hacia el api-gateway (`8080`):

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```

3. URL pública = `https://<subdominio>.trycloudflare.com/v1/liwa/webhooks`  
   El gateway proxya a `liwa-channel-service` sin auth de sesión (solo header secret).

Si el quick tunnel se reinicia, la URL cambia: actualiza el webhook en LIWA.

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

| Evento LIWA | Efecto en NOVA |
| --- | --- |
| `document_received` | CRM documento + burbuja inbound (kind=document) |
| `handoff_requested` | Handoff cola + burbuja system |
| **`message` (+ `text`) — obligatorio para espejo** | Burbuja Asociado (texto libre) |
| `bot_message` (opcional) | Burbuja Bot WhatsApp |
| Reply asesor | Burbuja outbound + `send/text` LIWA |

Sin nodo External API `event=message` en el paso donde el usuario escribe, Conversaciones **no** ve el chat aunque WhatsApp funcione.  
Cutover Contabo ordenado: [CONTABO_CHAT_ESPEJO_CUTOVER.md](CONTABO_CHAT_ESPEJO_CUTOVER.md).

```json
{
  "event": "message",
  "phone": "+573004198710",
  "text": "Quiero renovar mi crédito",
  "external_id": "chat-1"
}
```

## Binding de tenant

```bash
DATABASE_URL=... LIWA_BIND_TENANT_ID=<uuid-coopfuturo> node scripts/autonomy/liwa-bind-tenant.mjs
```

Cuenta LIWA: `LIWA_ACCOUNT_ID=1656233` (Coopfuturo 2026 Cta Comercial).

## Verificación

1. Simular con secret en Hyperion.
2. Disparar nodo real del flow.
3. Confirmar `liwa.webhook_receipts` + handoff/CRM en nova-core.
