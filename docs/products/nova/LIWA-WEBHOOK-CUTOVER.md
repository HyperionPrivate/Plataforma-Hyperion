# LIWA webhook cutover (NOVA)

Inbound webhooks **no se configuran por API** (ausentes en Swagger). Se pegan en la UI LIWA:
Herramientas → Webhooks / nodos del flow **Renovaciones** (`1782399915832`).

## URL Hyperion

```text
https://<tu-host-publico>/v1/liwa/webhooks
```

Header obligatorio:

```text
X-LIWA-WEBHOOK-SECRET: <mismo valor que LIWA_WEBHOOK_SECRET en .env>
```

Lab local (mismo secret):

```text
POST /v1/liwa/webhooks/simulate
```

## Túnel temporal (dev)

Ejemplo Cloudflare quick tunnel hacia el api-gateway local (`8080`):

```bash
cloudflared tunnel --url http://localhost:8080
```

Usa la URL HTTPS resultante + path `/v1/liwa/webhooks`.

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

Eventos: `document_received` | `prequal_completed` | `handoff_requested` | `csat` | `tipificacion` | `opt_out`  
Aliases aceptados: `documento`, `asesor`, `nps`, `baja`, `tipify`, etc.

## Binding de tenant

```bash
DATABASE_URL=... LIWA_BIND_TENANT_ID=<uuid-coopfuturo> node scripts/autonomy/liwa-bind-tenant.mjs
```

Cuenta LIWA: `LIWA_ACCOUNT_ID=1656233` (Coopfuturo 2026 Cta Comercial).

## Verificación

1. Simular con secret en Hyperion.
2. Disparar nodo real del flow.
3. Confirmar `liwa.webhook_receipts` + handoff/CRM en nova-core.
