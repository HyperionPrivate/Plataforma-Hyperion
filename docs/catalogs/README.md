# Catálogos operativos versionados

Los archivos de esta carpeta son fuentes de verdad legibles por herramientas durante la transición federada. Su
`catalogVersion` sigue SemVer y cada entrada conserva propietario, estado, identificador de seguimiento y fecha
de revisión o vencimiento.

Estadísticas normativas: `products=4`, `services=32`, `debtItems=20`, `findingGroups=84`, `instances=84`,
`workstreams=9`, `temporaryExceptions=3` y `transitionInventory=8`.

- [`products.v1.json`](products.v1.json): productos comerciales y plano neutral de plataforma.
- [`services.v1.json`](services.v1.json): aplicaciones, servicios y one-shots desplegables actuales, junto con sus
  destinos planificados. El inventario incluye los migradores provider-owned bajo `packages/`; el migrador global
  figura una sola vez aunque sus comandos se ejecuten mediante dos alias Compose, está marcado `retiring` y no
  acredita autonomía de datos.
- [`debt.v1.json`](debt.v1.json): agrupación exhaustiva del estado efectivo por tipo y arista. Incluye tanto la
  cadena global congelada como los migradores provider-owned independientes; las dos excepciones de la migración
  global 038 y la excepción trazada del control-plane de markers no ocultan los mismos adaptadores cuando siguen
  presentes en el baseline autónomo de PULSO. `DEBT-022` es además la única excepción del gate de tenant: fija las
  cuatro selecciones CEDCO por slug a bytes, cantidad de ocurrencias, owner, issue y vencimiento exactos.

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
