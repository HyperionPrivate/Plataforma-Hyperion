---
documentType: runbook
status: not-current
owner: nova-operations
issue: HYP-NOVA-012
reviewDue: 2026-09-30
---

# Contabo — stack de prueba (puerto aislado)

> **Estado: no vigente para exposición pública.** Este runbook solo puede usarse
> detrás de un túnel privado con TLS hasta que se valide de nuevo para producción.

Entorno **solo pruebas** en el VPS Contabo, sin tocar lo que ya escucha en 80/443.

## Inventario (17 jul 2026)

| Puerto   | Desde red externa | Notas                                           |
| -------- | ----------------- | ----------------------------------------------- |
| 22       | Abierto           | SSH solo `publickey` (password rechazado)       |
| 25384    | Cerrado / timeout | No usable desde esta red                        |
| 80 / 443 | Abiertos          | Ya hay algo en producción/piloto — **no pisar** |

URL de prueba del webhook (cuando el stack `hyperion-test` y el túnel TLS estén up):

```text
https://<host-del-tunel-privado>/v1/liwa/webhooks
```

Consola Ops prueba: acceso local mediante port-forward SSH a `http://127.0.0.1:13001`.

## Requisitos de acceso

Hace falta una **llave SSH** autorizada en Contabo (`root@144.91.100.31:22`).  
Sin llave no se puede inventariar Docker ni desplegar desde este entorno.

## Deploy (quien tenga SSH)

En el VPS, checkout de Hyperion limpia (rama con post-call WA, p.ej. `feat/nova-post-call-wa-ops`):

```bash
cd /opt/hyperion-test   # o ruta acordada, NO mezclar con piloto 80/443
git clone <repo> .      # o pull
cp .env.example .env.contabo-test
# Completar secretos: LIWA_*, tokens *_TO_*, POSTGRES_*, POST_CALL_WHATSAPP_AUTO_SEND=true
# LIWA_DEFAULT_FLOW_ID=1784249919201   # flujo copia de prueba

export COMPOSE_PROJECT_NAME=hyperion-test
export API_GATEWAY_HOST_PORT=18081
export WEB_CONSOLE_HOST_PORT=13001

docker compose --profile legacy-gateway -p hyperion-test \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.contabo-test.yml \
  --env-file .env.contabo-test \
  up -d --build
```

No abrir `18081` ni `13001` al Internet. El overlay los enlaza a loopback; usar
un túnel TLS para LIWA y port-forward SSH para la consola.

## Smoke webhook

```bash
curl -i -X POST "https://<host-del-tunel-privado>/v1/liwa/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-LIWA-WEBHOOK-SECRET: <secret>" \
  -d '{"event":"handoff_requested","phone":"+573004198710","agencia":"AG_PIEDECUESTA","ciudad":"Piedecuesta"}'
```

Esperado: HTTP **200** (no código 0).

Luego en LIWA (flujo `1784249919201`): misma URL + header secret → **Probar Ahora**.

## LIWA — nodos (tras smoke 200)

| Nodo               | event               |
| ------------------ | ------------------- |
| Documento (fase 2) | `document_received` |
| Acciones (fase 4)  | `handoff_requested` |

No apuntar el flujo prod `1782399915832` a este puerto de prueba.

## Después del smoke

1. Código clon inbound (`event: message` → Conversaciones) en limpia.
2. E2E WA con celular autorizado.
3. Cutover prod = dominio HTTPS en 443 (otro paso; no este overlay).
