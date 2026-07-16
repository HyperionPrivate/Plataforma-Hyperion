# Ops UI PULSO — módulos y fuentes de datos

App: `apps/web` (Next.js).  
- `NEXT_PUBLIC_API_MODE=mock` → JSON en `src/data/`.  
- `NEXT_PUBLIC_API_MODE=live` → `src/services/live/` + `ops-client.ts` contra `pilot-core` `/ops` (Traefik o URL directa).

## Mapa rápido

| Ruta | Módulo | Archivo mock | Backend esperado (live) |
|---|---|---|---|
| `/dashboard` | Dashboard BI | `dashboard.json` | Analytics / pilot-core métricas piloto |
| `/campanas` | Campañas | `campaigns.json` | Campañas + A/B + heatmap conversión |
| `/conversaciones` | Inbox | `conversation.json` | Conversaciones voz/WA + expediente |
| `/crm` | Funnel kanban | `crm.json` | Pipeline por segmento |
| `/handoff` | Cola asesores | `handoff.json` | Handoffs LIWA / cola |
| `/segmentacion` | Priorización IA | (inline + heatmap) | Scores propensión/urgencia |
| `/reportes` | Reportes | (inline) | Exports agregados |
| `/configuracion` | Config white-label | (inline) | Preferencias ops / OIDC roles |

---

## 1. Dashboard (`/dashboard`)

**Qué muestra:** KPIs del piloto, contactos por día, embudo renovación, estados de base, ops, feed en vivo.

| Widget | Qué debe alimentar | Campos mock / contrato sugerido |
|---|---|---|
| KPIs (Contactabilidad, Conversación, Intención, Órdenes, CSAT) | Agregados del periodo filtrado | `kpis[]`: `id`, `label`, `value`, `unit`, `delta`, `deltaUnit`, `sparkline[]` |
| Contactos por día | Serie diaria voz vs WhatsApp | `contactsByDay[]`: `date`, `voz`, `whatsapp` |
| Embudo Renovación | Conteos por etapa del funnel | `funnelRenovacion[]`: `key`, `label`, `count`, `pct` |
| Estados de la base | Distribución de tipificación / estado | `baseStatus[]`: `key`, `label`, `count`, `pct` |
| Indicadores operacionales | Contadores operativos del día | `ops[]`: `id`, `label`, `value` |
| Actividad en tiempo real | Eventos stream (SSE/WS) | `liveEvents[]` + push: `channel`, `personName`, `kind`, `at` |

**Filtros UI (mock):** canal (voz/WA) y segmento (renovación/reactivación) reescalan series; en live deben ser query params al API de analytics.

---

## 2. Campañas (`/campanas`)

| Widget | Qué debe alimentar | Campos |
|---|---|---|
| Chips del día | Totales outbound hoy | `dayChips`: `llamadasHoy`, `whatsappHoy`, `reintentos`, `ventana` |
| Tabla campañas | Catálogo + progreso | `campaigns[]`: `name`, `segment`, `channels`, `contacted`, `total`, `conversion`, `status`, `ab?` |
| A/B guiones | Variantes del guion activo | `ab`: `a`, `b`, `winner` |
| Mejor franja horaria | Matriz conversión por día×hora | `heatmap.days`, `heatmap.hours`, `heatmap.values[][]` (0–1) |
| Reintentos inteligentes | Flag modelo + reglas | Flag booleano + timestamp entrenamiento |

**Leyenda heatmap:** verde oscuro = conversión baja; verde brillante = alta.

---

## 3. Conversaciones (`/conversaciones`)

| Zona | Qué debe alimentar | Campos |
|---|---|---|
| Lista inbox | Conversaciones activas | `conversations[]`: `id`, `name`, `topic`, `snippet`, `channel`, `sentiment`, `tags`, `messages[]`, `expediente`, `aiSummary` |
| Hilo | Mensajes del hilo seleccionado | `messages[]`: `role` (`bot`/`user`/`agent`), `text`, `attachment?` |
| Expediente | CRM del asociado (PII mask en live) | `cedula`, `universidad`, `programa`, `semestre`, `cuotas*`, `estadoCrm`, `score` |
| Resumen IA | Resumen + intención | `aiSummary`: `text`, `intencion`, `etapa`, `sentimiento` |

**Interacción mock:** cambiar de hilo, tomar control y escribir mensajes locales. Live: POST mensaje + claim ownership del bot.

---

## 4. CRM (`/crm`)

| Widget | Qué debe alimentar | Campos |
|---|---|---|
| Tabs segmento | Un funnel por: Renovación, Reactivación, Nuevos, Microcrédito | `funnels.{Segmento}` |
| Columnas kanban | Estados del pipeline | `columns[]`: `id`, `label`, `count`, `cards[]` |
| Cards | Lead resumido | `name`, `universidad`, `score`, `channel`, `urgency` |
| Tipificaciones | Contadores laterales | `tipificaciones[]`: `key`, `label`, `count` |

---

## 5. Handoff (`/handoff`)

| Widget | Qué debe alimentar | Campos |
|---|---|---|
| KPIs cola | Cola, SLA, expediente, cerrados | `kpis[]` |
| Cola | Leads transferidos (mismos IDs/nombres que Conversaciones) | `queue[]`: `conversationId`, `priority`, `name`, `segment`, `motivo`, `expedientePct`, `aiSummary`, `info` |
| Por asesor | Carga del día | `byAdvisor[]`: `name`, `count` |
| Calidad | Score calidad handoff | `quality.score`, `breakdown[]` |

---

## 6. Segmentación (`/segmentacion`)

| Widget | Qué debe alimentar | Campos |
|---|---|---|
| Propensión vs Urgencia | Puntos contacto (0–100) + segmento | `x`=propensión, `y`=urgencia, `segment` (`renovacion`/`reactivacion`) |
| Cuadrantes | Reglas fijas en UI (corte 50/50) | Contactar primero / Programar / Nutrir / Baja prioridad |
| Olas | Priorización de olas | `ola`, `registros`, `score`, `cierre`, `canal` |
| Mejor horario por perfil | Heatmap respuesta | misma forma que campañas |
| Reintentos | Reglas de retry | lista de reglas + editor |

---

## 7. Reportes (`/reportes`)

Agregados exportables (Excel mock). Live: job de export + URL firmada (documents service).

## 8. Configuración (`/configuracion`)

Preferencias white-label, ventanas, canales. Live: settings service + roles OIDC (backlog #13).

---

Live: `src/services/live/` → `pilot-core` `GET/POST /ops/*` (`NEXT_PUBLIC_API_MODE=live`, `NEXT_PUBLIC_PILOT_CORE_URL`).

## Arranque

```powershell
cd apps/web
npm install
npm run dev
```

http://localhost:3000 → `/dashboard`

API producto (misma forma de datos):

```powershell
# terminal 2 — desde raíz del monorepo
$env:APP_ENV="development"; $env:AUTH_DISABLED="true"; $env:EVENT_WORKERS_ENABLED="false"
$env:DATABASE_URL="sqlite+aiosqlite:///./tmp-pilot.db"
$env:REDIS_URL="redis://127.0.0.1:6379/15"
$env:PYTHONPATH="packages/platform-kit/src;apps/pilot-core/src"
.\.venv\Scripts\python.exe -m uvicorn pilot_core.main:app --host 127.0.0.1 --port 8201
```

- `GET /ops/dashboard|campaigns|conversations|crm|handoff`
- `POST /ops/campaigns`
- `POST /ops/calls/dispatch` (mock si no hay `DIALER_BASE_URL`)

Docker/Traefik: servicio `web` en `docker-compose.dev.yml` (path `/` excluyendo APIs).

## Qué falta para producto completo

- Auth OIDC / masking PII en API
- Persistencia real (no solo fixtures + memoria)
- Cableado Dialer/WhatsApp/LIWA productivos
- Importer VIP-II, compliance, scoring, CRM state machines