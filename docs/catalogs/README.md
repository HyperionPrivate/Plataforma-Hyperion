# Catálogos operativos versionados

Los archivos de esta carpeta son fuentes de verdad legibles por herramientas durante la transición federada. Su
`catalogVersion` sigue SemVer y cada entrada conserva propietario, estado, identificador de seguimiento y fecha
de revisión o vencimiento.

Estadísticas normativas: `products=4`, `services=32`, `debtItems=5`, `findingGroups=0`, `instances=0`,
`workstreams=0`, `temporaryExceptions=0` y `transitionInventory=5`.

- [`products.v1.json`](products.v1.json): productos comerciales y plano neutral de plataforma.
- [`services.v1.json`](services.v1.json): aplicaciones, servicios y one-shots desplegables actuales, junto con sus
  destinos planificados. El inventario incluye los migradores provider-owned bajo `packages/`; el migrador global
  figura una sola vez aunque sus comandos se ejecuten mediante dos alias Compose, está marcado `retiring` y no
  acredita autonomía de datos.
- [`debt.v1.json`](debt.v1.json): agrupación exhaustiva del estado efectivo por tipo y arista. Incluye tanto la
  cadena global congelada como los migradores provider-owned independientes. DEBT-010/020/021/025/027/032
  cerrados (baseline vacío; edge legacy y bridge LUMEN N-1 retirados en código; gateway sin `@hyperion/contracts`).
  Reabiertos: `DEBT-005` (contratos FK 009–013 en tip antes de paridad multi-consumer atestada; gate en
  pulso-migrations) y `DEBT-023` (redirects retirados en código; ops debe confirmar ausencia en access logs).
  Quedan además `DEBT-022` (cutover ops + CEDCO), `DEBT-024` (registry SemVer) y `DEBT-026` (HA/offsite en
  entorno objetivo). `DEBT-022` es la única excepción del gate de tenant: fija las cuatro selecciones CEDCO por
  slug a bytes, cantidad, owner, issue y vencimiento.

Mientras el proyecto no esté en una GitHub Organization, los valores `issue` son identificadores locales estables
del backlog `HYP-*`. Al migrarlos a issues externos se mantiene el identificador en el título o cuerpo para no
romper trazabilidad.

Los estados son operativos, no afirmaciones de despliegue: `active` indica que el componente versionado existe y se
mantiene; `transitioning`, que su frontera aún está en separación; `retiring`, que solo permanece por
compatibilidad; `planned`, que todavía no existe como paquete; y `accepted`, que una deuda tiene retiro trazado.
`dueDate` es la próxima fecha obligatoria de revisión o retiro, según el estado.

`pnpm docs:check` rechaza catálogos incompletos, fechas vencidas, inventarios divergentes, estadísticas obsoletas,
deuda sin clasificar y excepciones temporales sin owner, issue o expiración. `pnpm federation:check` escanea SQL
operativo y provider-owned, y solo tolera las ocurrencias históricas selladas que coinciden con este catálogo.

Las entradas con `source: transition-inventory` no incrementan `baselineStats`: documentan trabajo de transición
fuera del baseline de ownership y conservan su propio owner, issue, estado y vencimiento. Algunas, como `DEBT-022`,
sí son consumidas por gates especializados y por ello no pueden divergir de su evidencia ejecutable.
