# Interfaz CoopFuturo Ops (`apps/web`) + estado WhatsApp / LIWA

**Rama:** `interfaz-coopfuturo`  
**Repo:** `AdministracionHyperion/CoopFuturo_`  
**UI de referencia local:** `http://localhost:3004` (API `127.0.0.1:8204`)  
**Actualizado:** 17 jul 2026

---

## 1. Qué interfaz usar (evitar confusiones)

| Qué | Dónde |
|---|---|
| **Ops UI CoopFuturo (esta rama)** | `apps/web` — Conversaciones, Handoff, Lab, CRM, Revisión post-llamada |
| **No confundir con** | Mock `Pulso/apps/web` ni Hyperion/NOVA (`version limpia`) |
| **API Ops** | `apps/pilot-core` → `/ops/*` |
| **Voz** | ElevenLabs SIP desde pilot-core (independiente del espejo de chat) |

```powershell
# UI
cd apps/web
# .env.local: NEXT_PUBLIC_API_MODE=live, NEXT_PUBLIC_PILOT_CORE_URL=http://127.0.0.1:8204
npm run dev -- --port 3004

# API (ejemplo staging)
# PULSO_DATA_DIR=…\.data-liwa-local  AUTH_DISABLED=true  LIWA_MODE=real|mock
uv run uvicorn pilot_core.main:app --host 127.0.0.1 --port 8204 --reload
```

---

## 2. Empaquetado validado en esta rama (antes de Contabo)

| Fix | Por qué |
|---|---|
| `saludo` + vars Flujo A (`lead_context` → ElevenLabs `dynamic_variables`) | Evita cuelgue ~1s / first_message sin `{{saludo}}` |
| IDs EL `phnum_8201…`, `agent_0701…` / `agent_2901…` | Evita 404 SIP en workspace actual |
| `accepted_pending` → reply HTTP 200 | Sin 502 falso al escribir el asesor (LIWA a menudo no manda `message_id`) |
| UI draft optimista + labels **Asesor / Bot WhatsApp / Asociado / Sistema** | Conversaciones usable |
| Webhook `bot_message` (+ role hints) | Bot LIWA aparece como bot en el hilo |
| Transferir a asesor reusa `conversation_id` | No clona chats vacíos |
| Cola handoff solo `queued`; Atender → `claimed` | Cola coherente |

**No va en git:** `LIWA_API_TOKEN`, `ELEVENLABS_API_KEY`, secrets de webhook Contabo, SSH keys, `.data-liwa-local/`.

---

## 3. Conversaciones **no es** espejo de LIWA (lo que falta)

**No es mentira del WhatsApp:** el celular puede estar perfecto y Conversaciones verse incompleto. Son dos sistemas.

| En WhatsApp real | En Conversaciones PULSO |
|---|---|
| Plantillas “cupo preaprobado…”, “No olvides adjuntar…” | No llegan (LIWA no las notifica) |
| Mensaje del usuario “Hola” | Solo si hay webhook `event=message` |
| Texto enviado desde PULSO (asesor) | Sí |
| Eventos cableados (documento / handoff / bot_message) | Sí, si LIWA hace el POST |

### Por qué

1. **LIWA no tiene API de historial** (no hay `GET` de mensajes del chat).  
2. PULSO solo muestra: lo que **envía** desde Conversaciones, o lo que LIWA **avisa por webhook**.  
3. Hoy el External API del flujo suele estar solo en pasos concretos (documento / handoff), **no** en cada texto del usuario.

### Secret vs URL (dos problemas distintos)

| Problema | Efecto |
|---|---|
| URL antigua Hyperion `…/v1/liwa/webhooks` + secret de otro stack | Apunta a otro servicio (o túnel muerto) → “Probar Ahora” falla |
| External API solo en documento/handoff | Aunque el túnel PULSO esté bien, tu “Hola” **no dispara** nada hacia Conversaciones |

El **secret** es solo la llave (`X-LIWA-WEBHOOK-SECRET`). Lo crítico es **en qué nodo** LIWA llama a PULSO y con **qué URL**.

### Para que se vea el chat de verdad

En LIWA, en el nodo donde el **usuario escribe texto** (no solo al guardar documento), External API / External Request:

- **URL PULSO** (ejemplo local con túnel):  
  `https://<tu-tunnel>/ops/webhooks/liwa`  
  En Contabo: `https://<host-publico>/pilot-core/ops/webhooks/liwa`  
  **No** usar la URL Hyperion `…/v1/liwa/webhooks` para este Ops.
- **Header:** `X-LIWA-WEBHOOK-SECRET: <mismo que LIWA_WEBHOOK_SECRET del pilot-core>`  
  (local staging suele ser `local-liwa-secret-test`; Contabo usa el secret del server).
- **Body mínimo:**

```json
{
  "event": "message",
  "phone": "{{contact.phone}}",
  "text": "{{message.text}}",
  "tenant_id": "coopfuturo"
}
```

Opcional bot outbound: `"event": "bot_message"` o `"role": "bot"` para etiquetar **Bot WhatsApp**.

Sin ese nodo `message`, Conversaciones **nunca** verá lo que escribes en WhatsApp, aunque el celular funcione.

Nodos ya recomendados (C1–C5): `document_received`, `prequal_completed`, `handoff_requested`, `csat`, `opt_out` — ver también [Paso_a_paso en Pulso/documentacion](file:///c:/Users/qfue1/OneDrive/Desktop/ZELIO/Pulso/documentacion/Paso_a_paso_LIWA_PULSO.md) (copia local del equipo).

---

## 4. Camino feliz ya validado (voz → WA)

```text
Dispatch llamada (ElevenLabs SIP + saludo/vars)
  → tipify interesado / pedir_whatsapp
  → LIWA send flow Renovaciones (1782399915832)
  → celular recibe plantilla
  → (pendiente) webhooks message/bot → Conversaciones
  → asesor claim + send/text (accepted_pending = OK)
```

Flags: `LIWA_MODE=real`, token, `POST_CALL_WHATSAPP_AUTO_SEND` true/false según negocio.

---

## 5. Pendiente para chat espejo en Contabo (configuración, no código)

Runbook ordenado (SSH, env, nodos LIWA, smoke, checklist):  
**[CONTABO_CHAT_ESPEJO_CUTOVER.md](CONTABO_CHAT_ESPEJO_CUTOVER.md)**

Resumen:

1. Deploy rama + rebuild `pilot-core` / `web`.  
2. `.env.contabo` con LIWA real + secret completo + EL IDs nuevos.  
3. LIWA External API → **solo** `https://<host>/pilot-core/ops/webhooks/liwa` (prohibido Hyperion `/v1/…` y trycloudflare).  
4. Nodo obligatorio `event=message` (+ documento / handoff / bot opcional).  
5. Smoke E2E y apagar túneles locales.

Sin nodo `message`, Conversaciones no ve lo que escribe el asociado aunque WhatsApp funcione.

---

## 6. Tests útiles

```powershell
uv run pytest tests/product/test_handoff_saga.py tests/product/test_liwa_inbound_webhook.py tests/product/test_conversaciones_advisor_send.py -q
```
