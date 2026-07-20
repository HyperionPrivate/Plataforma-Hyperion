# Reauditoría y endurecimiento federado

Fecha de trabajo: 2026-07-19
Rama: `fix/federation-ci-hardening`
Base: `main@562f90a9dc9ad5730238ce0bb63fc70f2985dea2`

## Propósito

Esta intervención revalida el corte federado sobre los archivos y CI actuales, corrige los defectos reproducibles
y deja evidencia de regresión antes de publicar la rama. No convierte en completadas tareas externas como transferir
el repositorio a la Organization, habilitar GitHub Code Security de pago, proteger `main`, publicar paquetes en un
registry o ejecutar un cutover productivo.

## Correcciones implementadas

- El runtime acepta la representación numérica `Infinity` que `pg` devuelve para PostgreSQL `VALID UNTIL
'infinity'`, pero sigue rechazando fechas finitas y `-Infinity`.
- Audit sale del bootstrap de roles compartido. La CI full-stack crea su base lógica, ejecuta su migrador y activa
  su runtime mediante los tres one-shots provider-owned; el E2E usa `TEST_AUDIT_DATABASE_URL` separado.
- Un cambio en `@hyperion/migrations` activa todas las celdas mientras ese paquete conserve esquemas heredados.
- Los outboxes NOVA, Voice, LIWA y Documents reclaman leases `dispatching` vencidas tras la caída de un worker.
- El webhook LIWA deriva tenant sólo de `LIWA_ACCOUNT_ID × liwa.tenant_bindings`, rechaza cuentas conflictivas e
  inserta receipt y efectos en una transacción idempotente.
- El aprovisionamiento y `nova-core` dejan de usar la cuenta Coopfuturo hardcodeada: la cuenta LIWA se exige como
  configuración explícita y se comparte con `liwa-channel` sin fallback de cliente dentro del producto genérico.
- El inbox NOVA inserta, aplica efectos y marca `processed_at` en una transacción. Reintenta receipts históricos sin
  procesar, deduplica los completados y devuelve conflicto ante reutilización incompatible de identidad.
- El restore NOVA reaplica y valida ACL de base: PUBLIC sin CONNECT, migrador con CONNECT/CREATE/TEMPORARY y cuatro
  runtimes con CONNECT únicamente.
- PULSO codifica identificadores usados en rutas/query y ya no silencia un 401 durante la carga de contexto.
  Un fallo transitorio del catálogo de sitios conserva el grant válido y permite renderizar la consola sin sitios.
- El smoke legacy comprueba la política real 307 y conserva únicamente `encounter=<UUID>` para LUMEN.
- Las consolas del Compose de convivencia se enlazan a loopback por defecto y Coopfuturo deja de publicar
  `/dev/kit` en el artefacto productivo.
- CodeQL deja de ocultar fallos con `continue-on-error`: genera SARIF sin el upload de Code Scanning que no admite el
  plan actual y lo conserva como artifact. Dependabot vuelve a tener límites de PR mayores que cero y Gitleaks deja
  de excluir todos los tests y scripts de recovery.

## Evidencia mínima añadida

Las pruebas nuevas cubren `Infinity` real, cálculo global del migrador, URL de Audit aislada, leases vencidas en
cuatro outboxes, tenant forgery y deduplicación LIWA, estados accepted/duplicate/recovery/conflict del inbox NOVA,
ACL exacta de restore y codificación de segmentos PULSO.

Evidencia local final sobre el working tree corregido:

- `pnpm check`: código 0 en 248,6 segundos (arquitectura, federación, docs, releases, Compose, lint/Prettier,
  backup/restore, builds y suites del workspace).
- `pnpm typecheck`: código 0 en 46 proyectos compilables.
- `pnpm coopfuturo:check`: 46 pruebas, lint, typecheck, build Next y procedencia del bundle en verde.
- `pnpm docker:contexts`: cinco contextos provider-owned generados desde sus allowlists.
- Gitleaks 8.30.1 verificado por checksum: 199 commits escaneados con `--all`, sin filtraciones.

La aceptación final exige además que los workflows por celda, Gitleaks, CodeQL y container scan terminen
correctamente en el SHA publicado. El full-stack quedó temporalmente restringido a `workflow_dispatch` (sin
`push`/`schedule`) por límite de minutos de Actions; la política versionada se restaurará cuando haya cupo.

## Pendientes externos y posteriores

1. Transferir el repositorio a la Organization y aplicar rulesets/branch protection con un administrador de la org.
2. Publicar y leer desde registry los contratos/librerías compartidos antes de la extracción física de NOVA.
3. Ejecutar backup/restore, TLS, telemetría de redirects y cutover en el ambiente objetivo.
4. Resolver o aceptar explícitamente los hallazgos vigentes de imágenes; el workflow de Trivy sigue siendo advisory
   mientras la Organization no tenga el control de seguridad y una política de remediación aprobada.
5. ~~Retirar gateway/edge de compatibilidad~~ — cerrado en código (DEBT-020/023/032, 2026-07-20). Pendiente ops:
   cutover CEDCO/global migrator (DEBT-022), registry SemVer (DEBT-024), HA/offsite LUMEN (DEBT-026).

## Wave F — canary restoration (2026-07-20)

Estado: **hold desbloqueado y restauración gradual validada**. El repositorio es público, GitHub Actions está
habilitado con acciones fijadas por SHA y `main` está protegida con checks obligatorios, historial lineal,
administradores incluidos y force-push/eliminación bloqueados. `pulso-cell` cerró en verde sobre el evento `push`
del SHA `3af2b60fe6275127bda78b438896402d34fef053` (run `29780031326`), incluyendo las 93 integraciones PostgreSQL,
la clausura de código, recovery gates, smoke de imagen y el gate requerido. Con ese canario acreditado se restauran
los triggers históricos de `push` y `schedule` para el resto de CI.

| Ítem                                                       | Estado                          |
| ---------------------------------------------------------- | ------------------------------- |
| Local-first (`pnpm check` / Compose) como fuente de verdad | vigente                         |
| Workflows solo `workflow_dispatch` + `pull_request`        | verificado                      |
| Restaurar `on.push` / `schedule`                           | canario verde; ampliación lista |
| Org rulesets / branch protection                           | branch protection aplicada      |

### Criterios de avance

1. ~~Cupo GitHub Actions recuperado (org billing / minutes).~~ Resuelto al hacer público el repositorio; los runners
   estándar alojados por GitHub no consumen cuota de minutos.
2. ~~Transferencia a Organization con rulesets en `main` (require status checks, block force-push).~~ Resuelto con
   branch protection y checks requeridos.
3. ~~Reintroducir `push`/`schedule` de forma gradual.~~ Canario `pulso-cell` observado en verde; triggers históricos
   restaurados para Access, NOVA, LUMEN, Platform y seguridad.
4. ~~Validar la primera ejecución full-stack.~~ Las ejecuciones `29781495766` y `29783686422` demostraron que el
   ensayo monolítico había quedado obsoleto: mezclaba binarios federados actuales con el esquema global histórico.
   La puerta automática ahora compone `_cell-ci.yml` para Platform, NOVA, LUMEN y PULSO y mantiene una validación
   global del workspace. El ensayo anterior queda como `legacy-monolith-diagnostic.yml`, manual, congelado y no
   soportado; requiere confirmación explícita y no cuenta como señal de merge readiness. La primera ejecución de la
   composición federada, `29785646807` sobre `9b664214c0cc244f4c4fe776fa81fbffdb8a8a46`, terminó en verde,
   incluido su agregador `full-stack / required`.
