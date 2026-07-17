# Contabo / Hyperion — cutover chat espejo (LIWA → NOVA Conversaciones)

**Repo correcto:** `AdministracionHyperion/Plataforma-Hyperion`  
**Rama:** `interfaz-coopfuturo`  
**UI producto:** `apps/web-console` (tabs NOVA — Conversaciones, Handoff, Lab, …)  
**Webhook path Hyperion:** `/v1/liwa/webhooks` (vía api-gateway)

> **Nota de repos:** `CoopFuturo_` guarda el shell Ops legacy (`apps/web` Next en `:3004`).  
> **Este** monorepo es la plataforma con lógica de producto (microservicios NOVA).  
> El chat espejo y la UI de Conversaciones que deben operar en Contabo van aquí.

Relacionado: [LIWA-WEBHOOK-CUTOVER.md](LIWA-WEBHOOK-CUTOVER.md) · [CONTABO-TEST-WEBHOOK.md](CONTABO-TEST-WEBHOOK.md) · [POST-CALL-WHATSAPP.md](POST-CALL-WHATSAPP.md)

---

## Por qué Conversaciones no es espejo automático

LIWA no expone historial por API. NOVA solo muestra:

1. Lo que el asesor envía desde Conversaciones (`send/text`), o
2. Lo que LIWA notifica por webhook.

Sin nodo External API `event=message` en el flujo, el celular puede estar perfecto y Conversaciones incompleto.

| En WhatsApp                   | En Conversaciones NOVA           |
| ----------------------------- | -------------------------------- |
| Plantillas del flujo          | No llegan (LIWA no las notifica) |
| Texto del asociado            | Solo con webhook `message`       |
| Reply desde consola           | Sí                               |
| Documento / handoff cableados | Sí                               |

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
| Bot (opcional)                            | `{"event":"bot_message","phone":"{{phone}}","text":"{{text}}"}`               |

**Probar Ahora** en LIWA → HTTP 200. Sin nodo `message`, Conversaciones no ve al asociado.

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
