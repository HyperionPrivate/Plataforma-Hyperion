# Contabo / Hyperion — cutover chat espejo (LIWA → NOVA Conversaciones)

**Repo correcto:** `AdministracionHyperion/Plataforma-Hyperion`  
**UI producto:** `apps/coopfuturo-console` (Next.js Ops UI PULSO/CoopFuturo — misma interfaz del monolito)  
**Puerto Contabo:** `http://144.91.100.31:19001`  
**Webhook path Hyperion:** `/v1/liwa/webhooks` (vía api-gateway)

> La UI visual vive en `apps/coopfuturo-console` (portada desde `CoopFuturo_/apps/web`).  
> El BFF en `/pilot-core/*` traduce a las APIs NOVA del gateway. No usar `web-console` Vite para CoopFuturo.

Relacionado: [LIWA-WEBHOOK-CUTOVER.md](LIWA-WEBHOOK-CUTOVER.md) · [CONTABO-TEST-WEBHOOK.md](CONTABO-TEST-WEBHOOK.md) · [POST-CALL-WHATSAPP.md](POST-CALL-WHATSAPP.md)

---

## Por qué Conversaciones no es espejo automático

LIWA no expone historial por API. NOVA solo muestra:

1. Lo que el asesor envía desde Conversaciones (`send/text`), o
2. Lo que LIWA notifica por webhook (`message` / `bot_message` / documento / handoff), o
3. El placeholder al disparar un flow desde Hyperion (`Flujo <nombre> enviado`).

### Hallazgo sonda historial (2026-07-17, cuenta `1656233`)

Se probaron (GET, solo lectura, `X-ACCESS-TOKEN`) los candidatos:

`/contacts/{id}/messages`, `/conversation`, `/conversations`, `/history`, `/chat`, `/conversations/{id}/messages`, `/accounts/messages?contact_id=`, `/messages?contact_id=`, variantes con `+phone`.

**Resultado:** todos responden HTTP 200 con cuerpo `{"error":{"code":404,"message":"The requested resource doesn't exist..."}}`.  
`GET /contacts/{id}` y `GET /accounts/flows` sí funcionan.

**Consecuencia:** no hay sync-messages / poller de transcript. El clon exacto de burbujas del bot depende de nodos External Request en el flow LIWA (`event=bot_message` tras cada burbuja) + `event=message` para el usuario. Ver guía abajo y [LIWA-WEBHOOK-CUTOVER.md](LIWA-WEBHOOK-CUTOVER.md).

Sin nodo External API `event=message` en el flujo, el celular puede estar perfecto y Conversaciones incompleto.

| En WhatsApp                   | En Conversaciones NOVA                                      |
| ----------------------------- | ----------------------------------------------------------- |
| Plantillas / burbujas del bot | Solo con webhook `bot_message` (texto exacto de la burbuja) |
| Texto del asociado            | Solo con webhook `message`                                  |
| Disparo de flow desde Ops     | Placeholder `Flujo <nombre> enviado` (nombre vía listFlows) |
| Reply desde consola           | Sí                                                          |
| Documento / handoff cableados | Sí                                                          |

---

## “Ya está” cuando

- [ ] E2E Contabo (o stack prueba): tipify → WA → inbound message → reply asesor
- [ ] Webhook en host público Hyperion (sin depender de trycloudflare permanente)
- [ ] Rama `interfaz-coopfuturo` (o merge a main) desplegada
- [ ] Piloto CoopFuturo en `:80/:443` **intacto** si se usa stack prueba en puertos aislados

---

## Orden Contabo

### 1. Stack arriba + código

**Opción A — stack prueba aislado** (recomendado mientras vive el piloto en 80/443): ver [CONTABO-TEST-WEBHOOK.md](CONTABO-TEST-WEBHOOK.md).

```bash
ssh root@<host>
cd /opt/hyperion-test   # NO mezclar con /opt/pulso piloto
git fetch origin
git checkout interfaz-coopfuturo
# completar .env.contabo-test

export COMPOSE_PROJECT_NAME=hyperion-test
export API_GATEWAY_HOST_PORT=18081
export WEB_CONSOLE_HOST_PORT=13001
docker compose --env-file .env.contabo-test -f infra/docker-compose.yml -f infra/docker-compose.contabo-test.yml up -d --build
```

Webhook prueba:

```text
http://<host>:18081/v1/liwa/webhooks
```

Consola: `http://<host>:13001`

**Opción B — cutover sobre el host público definitivo** (cuando toque):

```text
https://<host-publico>/v1/liwa/webhooks
```

### 2. Env (real)

| Variable                       | Valor                         |
| ------------------------------ | ----------------------------- |
| `LIWA_MODE` / live             | según compose Hyperion        |
| `LIWA_API_TOKEN`               | token vigente (nunca en git)  |
| `LIWA_DEFAULT_FLOW_ID`         | Renovaciones / copia prueba   |
| `LIWA_WEBHOOK_SECRET`          | completo (no truncar en LIWA) |
| `POST_CALL_WHATSAPP_AUTO_SEND` | `true` para demo tipify→WA    |
| `ELEVENLABS_API_KEY`           | workspace con SIP CoopFuturo  |
| Dialer HTTP                    | vacío si SIP directo          |

### 3. LIWA External API → Hyperion (definitivo)

**URL única (Hyperion):**

```text
https://<host-publico>/v1/liwa/webhooks
# o prueba: http://<host>:18081/v1/liwa/webhooks
```

**Header:** `X-LIWA-WEBHOOK-SECRET: <mismo .env>`  
(o `?secret=` si la UI LIWA no permite headers — ver LIWA-WEBHOOK-CUTOVER).

**Prohibido para este stack:**

- `/pilot-core/ops/webhooks/liwa` (eso es **CoopFuturo_** / piloto PULSO Ops)
- secret / URL de otro producto mezclado sin querer
- dejar trycloudflare como destino permanente en prod

| Nodo                                      | Body                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| **Texto usuario (obligatorio para chat)** | `{"event":"message","phone":"{{phone}}","text":"{{text}}"}`                   |
| Documento                                 | `{"event":"document_received","phone":"{{phone}}","filename":"{{filename}}"}` |
| Handoff                                   | `{"event":"handoff_requested","phone":"{{phone}}","ciudad":"{{ciudad}}"}`     |
| **Bot (obligatorio para clon exacto)**    | `{"event":"bot_message","phone":"{{phone}}","text":"<texto de la burbuja>"}`  |

**Probar Ahora** en LIWA → HTTP 200. Sin nodo `message`, Conversaciones no ve al asociado. Sin `bot_message`, solo verás el placeholder del flow / replies del asesor.

### Guía paso a paso — nodos `message` / `bot_message` (flujo Renovación)

1. Abre el flow builder LIWA del flujo Renovación (o copia de prueba).
2. **Mensajes del asociado:** en el trigger / paso donde el usuario escribe, agrega External Request → URL Hyperion webhook + header secret → body:

```json
{"event":"message","phone":"{{phone}}","text":"{{text}}","external_id":"{{message_id}}"}
```

3. **Cada burbuja del bot:** inmediatamente después de cada nodo Message / Bot Message del flow, agrega External Request con el **texto literal** de esa burbuja (o variable si LIWA la expone):

```json
{"event":"bot_message","phone":"{{phone}}","text":"Hola, soy el asistente de CoopFuturo. ¿En qué te ayudo?","external_id":"renov-bot-1"}
```

   Repite con `external_id` distinto por burbuja (`renov-bot-2`, …) para dedup en Hyperion.

4. Guarda el flow. **Probar Ahora** en cada nodo → HTTP 200.
5. Smoke E2E: tipify / Lab envía flow → en Conversaciones aparece `Flujo <nombre> enviado` → el bot habla en WhatsApp → cada `bot_message` aparece como burbuja **Bot** con el texto exacto → el asociado responde → burbuja **Asociado** → reply asesor llega al celular.

Curl de verificación (sin esperar al flow):

```bash
export HOST="http://144.91.100.31:19080"
export SECRET="<LIWA_WEBHOOK_SECRET>"
export PHONE="573004198710"

curl -sS -X POST "$HOST/v1/liwa/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-LIWA-WEBHOOK-SECRET: $SECRET" \
  -d "{\"event\":\"bot_message\",\"phone\":\"$PHONE\",\"text\":\"Hola espejo bot Renovación\",\"external_id\":\"e2e-bot-$(date +%s)\"}"

curl -sS -X POST "$HOST/v1/liwa/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-LIWA-WEBHOOK-SECRET: $SECRET" \
  -d "{\"event\":\"message\",\"phone\":\"$PHONE\",\"text\":\"Hola espejo usuario\",\"external_id\":\"e2e-user-$(date +%s)\"}"
```

### 4. Smoke (15–20 min)

1. Health gateway + consola
2. `curl` webhook `message` → burbuja en Conversaciones
3. Lab / tipify interesado → WA
4. Asociado escribe WhatsApp → burbuja Asociado
5. Claim → reply asesor → llega al celular (sin 502 / accepted_pending OK)
6. Handoff claim sin duplicar conversación
7. Apagar túneles locales; LIWA solo apunta al host Contabo/Hyperion

### Curl smoke

```bash
export HOST="http://<host>:18081"   # o https://<host-publico>
export SECRET="<LIWA_WEBHOOK_SECRET>"
export PHONE="57300XXXXXXX"

curl -sS -X POST "$HOST/v1/liwa/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-LIWA-WEBHOOK-SECRET: $SECRET" \
  -d "{\"event\":\"message\",\"phone\":\"$PHONE\",\"text\":\"Hola desde Hyperion smoke\",\"name\":\"Prueba\"}"
```

---

## Checklist rápida

- [ ] Push/deploy `interfaz-coopfuturo` en Hyperion
- [ ] Build Contabo (prueba 18081/13001 o host definitivo)
- [ ] Env LIWA / EL / AUTO_SEND
- [ ] Reapuntar nodos LIWA a `/v1/liwa/webhooks`
- [ ] Nodo **message** obligatorio
- [ ] Smoke E2E y cortar túneles
- [ ] No pisar piloto CoopFuturo en 80/443 sin acuerdo

---

## Mapa mental CoopFuturo_ vs Hyperion

|         | CoopFuturo_ (legacy Ops)        | Plataforma-Hyperion (este repo)         |
| ------- | ------------------------------- | --------------------------------------- |
| UI      | `apps/web` Next Ops             | `apps/web-console` NOVA                 |
| Webhook | `/pilot-core/ops/webhooks/liwa` | `/v1/liwa/webhooks`                     |
| Runtime | pilot-core monolito Ops         | microservicios nova-core + liwa-channel |
| Rol     | Referencia Contabo piloto       | **Base activa** producto                |

Ambos repos pueden coexistir; el cutover de chat espejo de producto va en **Hyperion**.
