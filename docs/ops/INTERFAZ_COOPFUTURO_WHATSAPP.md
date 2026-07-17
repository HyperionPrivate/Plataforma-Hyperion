# Interfaz CoopFuturo Ops (`apps/web`) + estado WhatsApp / LIWA

**Rama:** `interfaz-coopfuturo`  
**Repo:** `AdministracionHyperion/CoopFuturo_`  
**UI de referencia local:** `http://localhost:3004` (staging LIWA; API `127.0.0.1:8204`)  
**Fecha:** 17 jul 2026

## 1. Para el equipo — qué interfaz usar

| Qué | Dónde |
|---|---|
| **Ops UI CoopFuturo (esta rama)** | `apps/web` → Conversaciones, Handoff, Laboratorio, CRM, Revisión post-llamada |
| **No confundir con** | Mock `Pulso/apps/web` ni consola Hyperion/NOVA (`version limpia`) |
| **API Ops** | `apps/pilot-core` rutas `/ops/*` |
| **Llamadas (voz)** | Microservicio / integración ElevenLabs + post-call; **independiente** del bug de Transferir |

`main` ya es arquitectura de microservicios (`pilot-core`, adapters, Traefik, etc.). El problema de “chat duplicado al Transferir” era de **frontend + saga handoff en Ops**, no del dialer.

### Cómo levantar la misma UI que localhost:3004

```powershell
cd apps/web
# .env.local (no commitear secretos):
# NEXT_PUBLIC_API_MODE=live
# NEXT_PUBLIC_PILOT_CORE_URL=http://127.0.0.1:8204
# NEXT_PUBLIC_REQUIRE_AUTH=false
npm install
npm run dev -- --port 3004
```

API staging (ejemplo):

```powershell
cd apps/pilot-core
# PULSO_DATA_DIR=...\CoopFuturo_repo\.data-liwa-local
# AUTH_DISABLED=true
# LIWA_MODE=mock|real
uv run uvicorn pilot_core.main:app --host 127.0.0.1 --port 8204 --reload
```

---

## 2. Arquitectura (main) — voz vs frontend Ops

```text
[Dialer / ElevenLabs]     → voz outbound + webhook/poller post-call
        ↓
[pilot-core /ops]         → tipify, CRM, Conversaciones, Handoff, LIWA HTTP
        ↓
[apps/web Ops UI]         ← ESTA interfaz (rama)
        ↓
[LIWA chat.liwa.co]       → flujo Renovaciones, bot, live chat, tags AG_*
```

- **Voz** puede vivir / desplegarse aparte; tipificación entra por webhook o Laboratorio.
- **WhatsApp** sale por `liwa_whatsapp` desde pilot-core (`LIWA_MODE=real` + token).
- **Inbox humano en PULSO** = Conversaciones + Handoff (no es el panel LIWA).

---

## 3. Fix incluido: Transferir a asesor ya no clona chats

**Bug:** `Transferir a asesor` creaba un `cv_*` nuevo → al Atender se abría un chat vacío y la cola se llenaba de “Transferido desde Conversaciones”.

**Fix (esta rama):**

1. UI envía `conversation_id`, `phone`, `idempotency_key=handoff:{id}`.
2. Backend reusa ese hilo (`botPaused`, tag Handoff); no inventa otro `cv_*`.
3. Reusa handoff `queued` si el bridge LIWA ya lo creó.
4. Cola solo lista `queued`; Atender marca `claimed`.

Archivos: `apps/web/.../conversaciones/page.tsx`, `ops-client.ts`, `pilot_core/routers/ops.py`, `ops_store.py`, `tests/product/test_handoff_saga.py`.

---

## 4. Estado WhatsApp (honesto — no 100%)

| Capacidad | Estado |
|---|---|
| Post-llamada tipify → cola / envío flujo Renovaciones | Funciona (auto o revisión según `POST_CALL_WHATSAPP_AUTO_SEND`) |
| Send flow LIWA (`1782399915832`) | Funciona con `LIWA_MODE=real` + token |
| Reply asesor `send/text` tras claim | Funciona |
| Un hilo por teléfono (voz + WA) | Funciona |
| Transferir / Atender sin clonar | **Corregido en esta rama** |
| Bridge `liwa-status` (live_chat + tags) | Parcial (estado, no historial) |
| Webhook inbound LIWA → burbujas | Código listo; hace falta C1–C5 en flujo LIWA + URL Contabo |
| Chat clon completo (historial bot) | **Pendiente** — LIWA no expone GET historial; depende de webhooks por mensaje |

### Variables clave Contabo / staging

| Variable | Nota |
|---|---|
| `LIWA_MODE` | `real` en prod |
| `LIWA_API_TOKEN` | Cuenta comercial |
| `LIWA_DEFAULT_FLOW_ID` | `1782399915832` Renovaciones |
| `LIWA_WEBHOOK_SECRET` | Header `X-LIWA-WEBHOOK-SECRET` |
| `POST_CALL_WHATSAPP_AUTO_SEND` | Default Contabo `false` (revisión) |

### Nodos API externa en LIWA (solo C1–C5, no todas las fases)

1. `document_received`  
2. `prequal_completed`  
3. `handoff_requested`  
4. `csat`  
5. `opt_out`  

(+ opcional `message` para espejo completo).

---

## 5. Prueba rápida en Laboratorio

1. Abrir `/laboratorio`  
2. Teléfono de prueba + ciudad  
3. Simular `document_received` → `handoff_requested`  
4. CRM / Conversaciones / Handoff → Atender **mismo** `cv_*`  
5. Transferir 2 veces → no debe aparecer chat vacío nuevo  

---

## 6. Fuera de esta PR

- Deploy Contabo (VPS puede estar en recuperación).  
- Cutover a Hyperion/NOVA (`Pulso/version limpia`).  
- Configurar nodos API externa en panel LIWA (requiere admin LIWA).
