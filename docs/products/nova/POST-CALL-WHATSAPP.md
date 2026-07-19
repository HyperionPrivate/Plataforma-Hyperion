---
documentType: runbook
status: not-current
owner: nova-channels
issue: HYP-NOVA-015
reviewDue: 2026-09-30
---

# Post-llamada → WhatsApp (NOVA / versión limpia)

> **No vigente para producción.** Debe revalidarse con políticas por tenant, LIWA real, recuperación de outbox y
> telemetría del release exacto.

Qué incluye esta entrega:

1. **Auto-send tras tipify positivo** — al completar la llamada con intención CONTINUE (`interesado`, `pedir_whatsapp`, renovar, etc.), nova-core encola `wa.send.requested` y liwa-channel dispara el flujo LIWA (`POST /contacts/{id}/send/{flow_id}`).
2. **Conversaciones Ops** — tras `wa.message.sent`, se abre/actualiza un hilo en `nova.conversations` para que el asesor pueda responder.
3. **Reply asesor** — `POST .../nova/conversations/:id/reply` → `send/text` LIWA (ventana 24h WhatsApp) + burbuja outbound en `nova.conversation_messages`.
4. **Clon inbound (webhook)** — LIWA → `POST /v1/liwa/webhooks` emite `wa.message.received` (texto libre, documento, handoff) → burbujas en Conversaciones. Ver `LIWA-WEBHOOK-CUTOVER.md`.

## Flujo

```text
voice.call.completed (poller o webhook EL)
  → tipify (post-call.ts)
  → si wantsWhatsapp y POST_CALL_WHATSAPP_AUTO_SEND≠false
      → outbox wa.send.requested (mode=flow, flow_id resuelto)
      → liwa: ensureContact + tags + sendFlow
      → wa.message.sent → abre Conversaciones (+ burbuja outbound)
  → LIWA webhook (document/handoff/message)
      → wa.message.received → burbuja inbound
  → asesor: Conversaciones → reply → send/text
```

## Variables de entorno

| Variable                       | Default                    | Rol                                                 |
| ------------------------------ | -------------------------- | --------------------------------------------------- |
| `POST_CALL_WHATSAPP_AUTO_SEND` | `true`                     | `false` = cola de revisión humana                   |
| `LIWA_API_TOKEN`               | —                          | Auth Swagger LIWA                                   |
| `LIWA_BASE_URL`                | `https://chat.liwa.co/api` | Base API                                            |
| `LIWA_DEFAULT_FLOW_ID`         | `1782399915832`            | Renovaciones (prod)                                 |
| `LIWA_FLOW_ID_B`               | `1782486171458`            | Reactivación / A-B                                  |
| `LIWA_VIP_TAG`                 | `RENOVACION_VIP`           | Tag antes del flow                                  |
| `LIWA_BLOCK_TEXT`              | unset                      | Si `1`, bloquea `send/text` salvo `LIWA_FORCE_TEXT` |

Para pruebas con flujo copia LIWA, apuntar `LIWA_DEFAULT_FLOW_ID` al id de prueba (ej. `1784249919201`) **solo en ese entorno**.

## Resolución de `flow_id`

1. Body explícito (review decide)
2. `nova.agent_configs.liwa_flow_id` por `product_flow`
3. Env `LIWA_FLOW_ID_B` / `LIWA_DEFAULT_FLOW_ID`

## Prueba rápida (sin llamada de voz)

```bash
# Smoke LIWA real (requiere token + teléfono E.164 autorizado)
LIWA_API_TOKEN=... LIWA_SMOKE_PHONE=+57300... node scripts/autonomy/liwa-outbound-smoke.mjs
```

E2E Hyperion (stack compose arriba): emitir `voice.call.completed` con intent CONTINUE → verificar mensaje WA + fila en Conversaciones → reply desde consola.

## Relación con main

Cambios solo dentro de servicios/apps/packages/docs/infra ya existentes en Hyperion. No se altera la topología del monorepo ni se añaden overlays Contabo.
