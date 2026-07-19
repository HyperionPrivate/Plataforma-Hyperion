# Auditoría: independencia NOVA y riesgos del WIP federado

Fecha: 2026-07-19  
Rama auditada: `feat/federated-separation` @ `1d77f38`  
Fuentes: [ADR-0006](../architecture/decisions/ADR-0006-federated-product-cells.md), [FEDERATION-ACCEPTANCE.md](../FEDERATION-ACCEPTANCE.md), [debt.v1.json](../catalogs/debt.v1.json), [NOVA-REPOSITORY-EXTRACTION.md](../operations/NOVA-REPOSITORY-EXTRACTION.md), estado git local.

Este documento completa los dos entregables de la auditoría: (1) checklist verificable de independencia NOVA frente a deuda restante, y (2) riesgos del working tree sin commit.

---

## 1. Checklist de independencia NOVA

Criterios tomados de ADR-0006 §“Criterios de verificación” y de la matriz en `FEDERATION-ACCEPTANCE.md`.

Leyenda de estado:

- `listo local` — demostrado en este working tree / recibos locales
- `parcial` — código o ensayo existe, pero falta entorno objetivo, registry o telemetría
- `bloqueado` — no se puede cerrar con el estado actual (sucio / externo / deuda abierta)

### 1.1 Criterios ADR-0006

| #   | Criterio                                                                           | Estado        | Evidencia / cómo verificar                                                                                                                                                                       | Deuda o límite                                                         |
| --- | ---------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| A1  | Build desde contexto sin fuentes LUMEN/PULSO; bundle sin rutas/chunks ajenos       | `listo local` | Cierre NOVA 179 fuentes, digest `c5195e1c…`; `pnpm frontend:check`; contamination tests; recibo [nova-standalone-acceptance-20260718.json](../evidence/nova-standalone-acceptance-20260718.json) | Digests locales ≠ registry                                             |
| A2  | Cambio exclusivo NOVA no ejecuta CI/publica imágenes de otras células              | `listo local` | Workflows `nova.yml` + `resolve-cell-impact.mjs` + `_cell-ci.yml`                                                                                                                                | Checks requeridos en GitHub siguen sin ruleset remoto                  |
| A3  | Arranca, migra y opera con LUMEN/PULSO apagados                                    | `listo local` | `infra/docker-compose.nova.yml` + acceptance; 7 migraciones, 48 tablas, 4 roles runtime                                                                                                          | Repetir contra copia del entorno objetivo                              |
| A4  | Ruta ajena → 404; grant insuficiente → 403                                         | `listo local` | Ensayo Platform↔NOVA autenticado (ruta LUMEN 404, otro tenant 403)                                                                                                                               | Falta smoke en hostname/TLS reales                                     |
| A5  | Despliega, revierte, respalda y restaura sin tocar otras células                   | `parcial`     | Drills PostgreSQL NOVA + scripts `nova-postgres-*` / `verify-nova-rollback`                                                                                                                      | Falta Documents/MinIO completo, offsite, RTO/RPO, imágenes desplegadas |
| A6  | Imports/contratos/Dockerfiles/migraciones rechazan deps globales o cruzadas nuevas | `listo local` | `pnpm federation:check`, `release:check --cell nova`, `cell-install-plan`                                                                                                                        | Contratos aún no publicados en npm                                     |

### 1.2 Criterios de aceptación federada (recorte NOVA)

| #   | Criterio                                                        | Estado        | Notas                                                                                                        |
| --- | --------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| B1  | Consola + BFF + Coopfuturo como cliente NOVA                    | `listo local` | `apps/nova-console`, `apps/nova-bff`, `apps/coopfuturo-console`; cookies `__Host-*`; CSRF                    |
| B2  | Sesión verificable con Identity caído (JWKS stale-if-error)     | `listo local` | Ensayo Docker real en aceptación Platform↔NOVA                                                               |
| B3  | Audit `nova.audit.event.record.v1` con outbox/inbox idempotente | `listo local` | Caída Audit + retry; E2E `nova-audit-http`                                                                   |
| B4  | Operator assertion en Voice/LIWA/Documents                      | `listo local` | `packages/nova-service-runtime`                                                                              |
| B5  | Migraciones provider-owned fuera de la cadena global            | `listo local` | SQL 047–052 eliminados de `packages/migrations`; viven en `packages/nova-migrations`                         |
| B6  | Contratos N/N−1 (`1.0.0` → `1.1.0`)                             | `parcial`     | Snapshots en repo; npm E404 para externos requeridos                                                         |
| B7  | Extracción a repo `nova` con historial                          | `bloqueado`   | Rehearsal 16/16; gate exige árbol limpio + publish/readback de 4 paquetes                                    |
| B8  | Retiro de gateway/redirects legacy                              | `parcial`     | Snapshot N−1 en `legacy-product-policy.ts`; [DEBT-032](../catalogs/debt.v1.json) `retiring` hasta 2026-12-31 |

### 1.3 Veredicto NOVA

| Pregunta                                                          | Respuesta                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ¿NOVA es célula autónoma _dentro del monorepo_?                   | **Sí, a nivel local verificable** (build, Compose, DB, BFF, consola, CI afectada, aceptación Platform↔NOVA).                                                                                                                                                                                                                                       |
| ¿NOVA está lista para extracción física / producción federada?    | **No.** Bloqueada por working tree sucio, paquetes externos sin publicar, gobernanza GitHub (Organization + `main` protegida) y recovery/cutover sobre entorno objetivo.                                                                                                                                                                           |
| ¿Qué falta para declarar “independiente” en sentido ADR completo? | (1) Commit limpio del corte federado en `main`; (2) publish+readback de `@hyperion/platform-contracts`, `audit-contracts`, `database`, `logger`; (3) extracción según [NOVA-REPOSITORY-EXTRACTION.md](../operations/NOVA-REPOSITORY-EXTRACTION.md); (4) cutover/restore/TLS en entorno objetivo; (5) retiro planificado de DEBT-032 / edge legacy. |

### 1.4 Deuda que NO bloquea el aislamiento local de NOVA (pero sí la federación global)

Estas entradas siguen abiertas y afectan a Platform/PULSO o al monorepo, no al arranque standalone NOVA:

| Deuda                                     | Impacto                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| DEBT-005 / FKs Channel→`platform.tenants` | Frontera Access↔PULSO; NOVA no la ejecuta en standalone                      |
| DEBT-022                                  | Slugs en migrador global `004` (CEDCO); NOVA standalone no lo usa            |
| DEBT-027 / DEBT-029–031                   | Baseline PULSO (grants, PL/pgSQL, SECURITY DEFINER) — 46 hallazgos efectivos |
| DEBT-032                                  | Gateway legacy N−1 — convivencia hasta telemetría/cutover                    |

---

## 2. Riesgos del working tree sin commit

### 2.1 Hechos medidos (2026-07-19)

| Métrica                           | Valor                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Rama                              | `feat/federated-separation`                                                                                                            |
| Upstream                          | **Ninguno** (`git push -u` nunca configurado en esta rama)                                                                             |
| Commits vs `main`                 | 3 ahead / 0 behind (polish CoopFuturo/voz/CI; **no** el corte federado)                                                                |
| Entradas `git status --porcelain` | **534** (≈314 modified/deleted + ≈220 untracked)                                                                                       |
| Diff tracked vs `main`            | 329 files, +13 518 / −28 279 líneas                                                                                                    |
| Apps/paquetes federados           | Presentes en disco pero **untracked** (`nova-*`, `lumen-*`, `pulso-*`, `platform-admin-*`, `releases/`, migradores, workflows cell-CI) |
| PR #27                            | **MERGED** (demo CoopFuturo/voz); no incluye este WIP federado                                                                         |
| Extracción NOVA                   | Gate **fail-closed** mientras el árbol esté sucio                                                                                      |

### 2.2 Riesgos priorizados

| Severidad | Riesgo                                 | Por qué importa                                                                                                                         | Mitigación recomendada                                                                                                |
| --------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Crítico   | Pérdida del WIP                        | ~534 paths sin commit ni remoto en esta rama; un reset/clean o fallo de disco borra el corte federado                                   | Commits atómicos por capa (apps → packages → infra/CI → docs) y push a origin                                         |
| Crítico   | Extracción/publicación bloqueada       | El runbook exige árbol limpio; FEDERATION-ACCEPTANCE confirma que el rehearsal falla cerrado con dirty tree                             | Congelar un SHA candidato limpio antes de cualquier publish                                                           |
| Alto      | Diff irrevisable en un solo PR         | Mezcla vaciado de `web-console`, 4 células nuevas, migraciones, Compose, CI, seguridad, ops                                             | Partir en PRs/series: (1) contracts+migrations, (2) BFFs/consolas, (3) Compose/releases, (4) workflows, (5) docs/debt |
| Alto      | Colisión con `main`                    | `main` ya avanzó con CoopFuturo (#25–#27); el WIP toca los mismos paths (`coopfuturo-console`, servicios NOVA, gateway)                 | Rebase frecuente; CI local `pnpm check` / `federation:check` por célula antes de push                                 |
| Medio     | Falsa sensación de “ya está en GitHub” | Workflows cell-CI y SECURITY.md existen solo locales; `main` remota no tiene checks requeridos ni branch protection (cuenta User / 403) | No tratar evidencia local como release; secuenciar Organization + rulesets                                            |
| Medio     | Secretos / `.env`                      | El corte toca `.env.example` y muchos `*.env.example` de célula                                                                         | Revisar staging para no incluir `.env` reales; gitleaks en CI tras el primer push                                     |
| Medio     | CI full-stack vs cell-CI               | `check.yml` pasa a `main`+cron; PRs dependen de workflows untracked                                                                     | Hasta mergear workflows, los PRs no ejercerán isolation por célula en remoto                                          |
| Bajo      | Ramas huérfanas documentadas           | `feat/ordered-event-contracts-v2` divergida; `interfaz-coopfuturo` sin ancestro común                                                   | Limpieza post-merge; no bloquea el corte si no se reutilizan                                                          |

### 2.3 Orden de commit sugerido (sin ejecutarlo aquí)

1. **Política y scripts**: `cell-policy`, `federation:*`, `frontend:*`, `scripts/ci/*`
2. **Contratos y migraciones provider-owned** + borrado 047–052 globales
3. **Apps**: BFFs + consolas + redirector `web-console` + Coopfuturo→NOVA
4. **Infra Compose/releases** + Docker cell contexts
5. **Workflows GitHub / SECURITY / CODEOWNERS**
6. **Docs + debt/evidence** (incluyendo este archivo)

Cada paso debería dejar `pnpm federation:check` (y el cell check correspondiente) en verde.

### 2.4 Veredicto WIP

El trabajo federado **ya demostró aceptación local** según `FEDERATION-ACCEPTANCE.md`, pero **no está salvaguardado en git**: vive casi por completo fuera de commits y sin upstream. El riesgo operativo dominante no es de diseño, sino de **durabilidad y revisabilidad** del working tree.

---

## 3. Resumen ejecutivo

Hyperion está logrando el primer corte federado (Platform + NOVA + LUMEN + PULSO) dentro del monorepo. NOVA cumple el aislamiento local verificable; no cumple aún independencia de extracción/producción. El bloqueo inmediato es confirmar y empujar el WIP, publicar dependencias externas y endurecer gobernanza GitHub — no reescribir la arquitectura.
