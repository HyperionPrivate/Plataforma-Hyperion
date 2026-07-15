# Demo local PULSO — qué probar ya

Stack esperado:

- UI: http://localhost:3000
- API: http://127.0.0.1:8201 (`NEXT_PUBLIC_API_MODE=live`)

## Flujo E2E renovación (sin llamada real a proveedor)

1. Abre http://localhost:3000/laboratorio
2. **Import CSV** → Preview → Commit válidos (E.164)
3. Ve a http://localhost:3000/segmentacion → debe puntuar contactos importados
4. En Laboratorio → **Disparar llamada** (orquestación mock + compliance)
5. Opcional: **Batch contactos** sobre los importados
6. **Documentos** → subir PDF/JPG (validación mock; nombre con `virus` rechaza)
7. **Enviar WhatsApp mock** (no LIWA real)
8. **Crear handoff** → aparece en http://localhost:3000/handoff
9. **Nueva campaña** en http://localhost:3000/campanas
10. Opt-out de un número y verifica que el dispatch queda bloqueado
11. CRM http://localhost:3000/crm → **Avanzar** mueve el lead de columna
12. Conversaciones → **Tomar control** persiste claim en API
13. **Reportes** → export CSV/JSON desde `/ops/reports/{id}`
14. **Configuración** → Dialer URL / agent IDs / ventana 8–20 → Guardar (SQLite)
15. Dashboard muestra contadores demo desde el store (`ops`)

## Arranque rápido (Windows)

```powershell
# API (desde raíz del monorepo)
$env:APP_ENV="development"
$env:AUTH_DISABLED="true"
$env:EVENT_WORKERS_ENABLED="false"
$env:PYTHONPATH="packages/platform-kit/src;apps/pilot-core/src"
# Opcional: dialer live
# $env:DIALER_BASE_URL="http://127.0.0.1:8080"
uvicorn pilot_core.main:app --host 127.0.0.1 --port 8201 --reload

# UI
cd apps/web
# .env.local: NEXT_PUBLIC_API_MODE=live + NEXT_PUBLIC_PILOT_CORE_URL=http://127.0.0.1:8201
npm run dev
```

## Qué sigue siendo mock / bloqueado

- Dialer ElevenLabs live (configura Dialer URL en Configuración o `DIALER_BASE_URL`)
- LIWA / WABA real (`EXTERNAL_BLOCKERS.md`)
- OIDC productivo
- MinIO / antivirus real (documents = metadata + validación stub)
- Core financiero real (lookup stub en Laboratorio)
- Bases VIP-II masivas (usa CSV sintético)
