# Contabo — cutover chat espejo (LIWA → Conversaciones)

**Rama de código:** `interfaz-coopfuturo`  
**Objetivo:** que Conversaciones vea lo que el asociado escribe en WhatsApp (y opcionalmente el bot), sin depender de túneles Cloudflare locales.  
**Premisa:** WhatsApp vive en LIWA; PULSO solo ve webhooks + lo que envía el asesor. Sin nodo `message`, no hay espejo.

Relacionado: [INTERFAZ_COOPFUTURO_WHATSAPP.md](INTERFAZ_COOPFUTURO_WHATSAPP.md)

---

## “Ya está” cuando

- [ ] E2E Contabo: Lab → tipify → WA → inbound → reply asesor  
- [ ] Webhook estable en host **público PULSO** (sin `*.trycloudflare.com`)  
- [ ] Fixes de la rama `interfaz-coopfuturo` desplegados  
- [ ] Hyperion / NOVA **intacto** (no mezclar URLs ni secrets)

---

## Orden en Contabo

### 1. Stack arriba + código con fixes

```bash
ssh root@<host>
cd /opt/pulso
docker ps   # pulso-* healthy

git fetch origin
git checkout interfaz-coopfuturo   # o SHA concreto validado
# opcional: git pull origin interfaz-coopfuturo

docker compose -f docker-compose.contabo.yml --env-file .env.contabo up -d --build
```

Rebuild mínimo: `pulso-pilot-core` + `pulso-web`.  
UI vía Traefik (80/443) → path API `/pilot-core`.

### 2. `.env.contabo` (real)

| Variable | Valor |
|---|---|
| `LIWA_MODE` | `real` |
| `LIWA_API_TOKEN` | token vigente (nunca en git) |
| `LIWA_DEFAULT_FLOW_ID` | `1782399915832` (Renovaciones / copia de prueba) |
| `LIWA_WEBHOOK_SECRET` | completo (no truncar al pegar en LIWA) |
| `LIWA_WEBHOOK_TENANT_ID` | `coopfuturo` (alineado con JWT/UI) |
| `POST_CALL_WHATSAPP_AUTO_SEND` | `true` para demo tipify→WA |
| `ELEVENLABS_API_KEY` | workspace con `+573110456598` |
| `DIALER_DEFAULT_PHONE_NUMBER_ID` | `phnum_8201kxpqbx2tep8vs46t888y3gv8` |
| `DIALER_BASE_URL` | vacío |

Tras editar env:

```bash
docker compose -f docker-compose.contabo.yml --env-file .env.contabo up -d --force-recreate pulso-pilot-core
```

En Ops **settings / agent_config**: Flujo A/B con agents/phone nuevos (`agent_0701…` / `agent_2901…`, `phnum_8201…`). Si aún hay `phnum_0001…`, actualizar.

### 3. LIWA External API → Contabo (definitivo)

**URL única:**

```text
https://<host-publico-pulso>/pilot-core/ops/webhooks/liwa
```

**Header:** `X-LIWA-WEBHOOK-SECRET: <mismo valor que LIWA_WEBHOOK_SECRET en .env.contabo>`

**Prohibido apuntar a:**

- `/v1/liwa/webhooks` (Hyperion/NOVA)
- `*.trycloudflare.com` (túneles locales)
- secret de Hyperion u otro stack

| Nodo en flujo Renovaciones | Body (ejemplo) |
|---|---|
| **Texto usuario (obligatorio para chat espejo)** | `{"event":"message","phone":"{{phone}}","text":"{{text}}","tenant_id":"coopfuturo"}` |
| Documento | `{"event":"document_received","phone":"{{phone}}","filename":"{{filename}}","tenant_id":"coopfuturo"}` |
| Handoff | `{"event":"handoff_requested","phone":"{{phone}}","ciudad":"{{ciudad}}","tenant_id":"coopfuturo"}` |
| Bot (opcional) | `{"event":"bot_message","phone":"{{phone}}","text":"{{text}}","tenant_id":"coopfuturo"}` |

Ajustar placeholders a los del builder LIWA. Mínimo: `event`, `phone`, `text` (en message), `tenant_id`.

En LIWA, **Probar Ahora** debe dar HTTP **200** / `ok`.  
**Sin nodo `message`, Conversaciones no ve lo que escribe el asociado.**

### 4. Smoke (15–20 min)

1. Health UI + `GET https://<host>/pilot-core/health/live`  
2. Webhook test (curl abajo) → burbuja en Conversaciones  
3. Lab → llamada >30s (saludo OK, sin cuelgue ~1s)  
4. Tipificar `interesado` → WA solo (flujo Renovaciones)  
5. Asociado escribe en WhatsApp → burbuja **Asociado**  
6. Atender → reply asesor → toast OK, draft limpio, llega al celular, **sin 502**  
7. Transferir ×2 → mismo `cv_*`  
8. Apagar túneles Cloudflare locales; LIWA solo apunta a Contabo  

---

## Comandos copy-paste

### Health

```bash
curl -sS "https://<host-publico-pulso>/pilot-core/health/live"
```

### Webhook test (message → Conversaciones)

```bash
# En el server o desde tu PC (secret = valor completo de .env.contabo)
export HOST="https://<host-publico-pulso>"
export SECRET="<LIWA_WEBHOOK_SECRET>"
export PHONE="57300XXXXXXX"   # número de prueba E.164 sin + o con +, ambos OK en normalizer

curl -sS -X POST "$HOST/pilot-core/ops/webhooks/liwa" \
  -H "Content-Type: application/json" \
  -H "X-LIWA-WEBHOOK-SECRET: $SECRET" \
  -d "{\"event\":\"message\",\"phone\":\"$PHONE\",\"text\":\"Hola desde Contabo smoke\",\"tenant_id\":\"coopfuturo\",\"name\":\"Prueba\"}"
```

Esperado: JSON con `"ok": true` y actions que incluyan append de mensaje. Abrir Conversaciones y recargar el hilo del teléfono.

### Webhook bot (opcional)

```bash
curl -sS -X POST "$HOST/pilot-core/ops/webhooks/liwa" \
  -H "Content-Type: application/json" \
  -H "X-LIWA-WEBHOOK-SECRET: $SECRET" \
  -d "{\"event\":\"bot_message\",\"phone\":\"$PHONE\",\"text\":\"Plantilla/bot de prueba\",\"tenant_id\":\"coopfuturo\"}"
```

### Ver secret en server (no copiar a git/chat)

```bash
grep LIWA_WEBHOOK_SECRET /opt/pulso/.env.contabo
# o el paste file si existe:
# cat /opt/pulso/.liwa_webhook_paste.txt
```

---

## Checklist rápida

- [ ] Push/deploy código con fixes (`interfaz-coopfuturo` o SHA)  
- [ ] Build Contabo + env LIWA / EL / `AUTO_SEND`  
- [ ] `agent_config` con IDs nuevos (no `phnum_0001…`)  
- [ ] Reapuntar nodos LIWA a `/pilot-core/ops/webhooks/liwa`  
- [ ] Nodo **message** (obligatorio) + documento/handoff (+ bot opcional)  
- [ ] Smoke E2E y cortar túneles locales  
- [ ] Hyperion intacto  

---

## Qué NO falta en código (ya en la rama)

| Pieza | Estado |
|---|---|
| Receptor `POST /ops/webhooks/liwa` + `message` / `bot_message` | En código |
| Reply asesor `accepted_pending` → 200 | En código |
| Labels Asesor / Bot / Asociado + draft UI | En código |
| Transferir sin clonar `cv_*` | En código |
| `saludo` + IDs EL nuevos | En código |

**Lo que falta para el espejo en prod es configuración Contabo + nodos LIWA**, no reescribir el inbox.
