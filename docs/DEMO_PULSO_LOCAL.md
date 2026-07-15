# Demo local PULSO — qué probar ya

Stack esperado:

- UI: http://localhost:3000
- API: http://127.0.0.1:8201 (`NEXT_PUBLIC_API_MODE=live`)

## Flujo E2E renovación (demoable)

**Un clic:** Laboratorio → **E2E renovación (WA→doc→handoff→CRM)**  
API: `POST /ops/e2e/renovacion` (`skip_voice=true` por defecto en UI para no gastar cupo SIP).

**Puente post-llamada (producto real):**

1. Llamada termina → ElevenLabs webhook `POST /ops/webhooks/elevenlabs/post-call`  
   (o simular: Laboratorio → **Simular post-llamada → WA** / `POST /ops/calls/complete` con `flow=A|B`)
2. Tipificación / intención (`interesado`, `renovar`, `reactivar`, …)
3. Si continúa → envío automático flujo WhatsApp LIWA del perfil A o B
4. CRM avanza a `interesado` → `documento` (funnel Renovación o Reactivación)

**Flujo B · Reactivación:** agente `agent_1401…`, tag `REACTIVACION_VIP`, E2E `POST /ops/e2e/reactivacion`.  
Si `LIWA_FLOW_ID_B` está vacío, el WA de B usa temporalmente el flujo Renovaciones hasta provisionar plantilla propia.

Orden de ejecución interno E2E:

1. Compliance (ventana / opt-out)
2. Voz (opcional) — orquestación Flujo A
3. WhatsApp — flujo LIWA (`LIWA_DEFAULT_FLOW_ID` / Renovaciones)
4. Documento — PDF mínimo → filesystem/MinIO
5. Handoff — cola local + tag LIWA (`LIWA_HANDOFF_TAG`)
6. CRM — lead + avance a `contactado`

## Flujo manual (paso a paso)

1. Abre http://localhost:3000/laboratorio
2. **Import CSV** → Preview → Commit válidos (E.164)
3. Ve a http://localhost:3000/segmentacion → debe puntuar contactos importados
4. En Laboratorio → **Disparar llamada** (orquestación + compliance)
5. Opcional: **Batch contactos** sobre los importados
6. **Documentos** → upload real (`POST /ops/documents/upload`)
7. **Enviar WhatsApp** — preferir **Flujo / plantilla** si `LIWA_MODE=real`
8. **Crear handoff** (+ tag LIWA) → http://localhost:3000/handoff
9. **Nueva campaña** en http://localhost:3000/campanas
10. Opt-out de un número y verifica que el dispatch queda bloqueado
11. CRM http://localhost:3000/crm → **Avanzar** mueve el lead de columna
12. Conversaciones → **Tomar control** / enviar mensaje / **Devolver al bot** (persistido)
13. **Transferir a asesor** o Laboratorio → handoff → **Atender** abre la conversación claimed
14. **Reportes** → export CSV/JSON desde `/ops/reports/{id}`
15. **Configuración** → Dialer URL / agent IDs / ventana 8–20 / **Privacidad PII** / ver opt-outs → Guardar
16. CRM → **Avanzar** respeta transiciones; **No interés** exige tipificación; nombres/teléfonos enmascarados si PII on
17. Dashboard muestra contadores demo desde el store (`ops`)
18. Auth: `GET /ops/auth/status` (OIDC ready probe)

## Arranque rápido (Windows)

```powershell
# API (desde raíz del monorepo)
$env:APP_ENV="development"
$env:AUTH_DISABLED="true"
$env:EVENT_WORKERS_ENABLED="false"
$env:PYTHONPATH="packages/platform-kit/src;apps/pilot-core/src"
# Cargar secretos locales (gitignored)
Get-Content .local-secrets-tmp\pulso_live.env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k,$v = $_.Split('=',2); Set-Item -Path "Env:$k" -Value $v
}
# WhatsApp LIWA live (también en pulso_live.env)
# $env:LIWA_MODE="real"
# $env:LIWA_BASE_URL="https://chat.liwa.co/api"
# $env:LIWA_API_TOKEN="..."
uvicorn pilot_core.main:app --host 127.0.0.1 --port 8201 --reload

# UI
cd apps/web
# .env.local: NEXT_PUBLIC_API_MODE=live + NEXT_PUBLIC_PILOT_CORE_URL=http://127.0.0.1:8201
npm run dev
```

## WhatsApp LIWA

- Contrato: `POST /contacts` + `POST /contacts/{id}/send/text` o envío por **flujo** (`kind=flow` + `flow_id`).
- Auth: header `X-ACCESS-TOKEN`.
- Swagger: https://chat.liwa.co/api/swagger/
- Fuera de ventana 24h: usar flujo/plantilla (Renovaciones `1782399915832`).
- Handoff: tag LIWA (`LIWA_HANDOFF_TAG`, default `RENOVACION_VIP`) + nota en contacto.

## Qué sigue siendo mock / bloqueado

- Dialer Contabo OpenAPI productivo (hoy: ElevenLabs SIP directo con `ELEVENLABS_API_KEY`)
- OIDC productivo (probe en `/ops/auth/status`; falta IdP + `AUTH_DISABLED=false`)
- Antivirus real (documents: extension/size + storage filesystem|minio)
- Core financiero real sin `CORE_BASE_URL`
- Bases VIP-II masivas (usa CSV sintético)
- Adapter eventos Redis `wa.send.requested` / webhooks inbound LIWA
