# Catálogos operativos versionados

Los archivos de esta carpeta son fuentes de verdad legibles por herramientas durante la transición federada. Su
`catalogVersion` sigue SemVer y cada entrada conserva propietario, estado, identificador de seguimiento y fecha
de revisión o vencimiento.

Estadísticas normativas: `products=4`, `services=32`, `debtItems=5`, `executionItems=14`,
`executionWaves=5`, `findingGroups=0`, `instances=0`, `workstreams=0`, `temporaryExceptions=0` y
`transitionInventory=5`.

- [`products.v1.json`](products.v1.json): productos comerciales y plano neutral de plataforma.
- [`services.v1.json`](services.v1.json): aplicaciones, servicios y one-shots desplegables actuales, junto con sus
  destinos planificados. El inventario incluye los migradores provider-owned bajo `packages/`; el migrador global
  figura una sola vez aunque sus comandos se ejecuten mediante dos alias Compose, está marcado `retiring` y no
  acredita autonomía de datos.
- [`debt.v1.json`](debt.v1.json): agrupación exhaustiva del estado efectivo por tipo y arista. Incluye tanto la
  cadena global congelada como los migradores provider-owned independientes. DEBT-010/020/021/025/027/032
  cerrados (baseline vacío; edge legacy y bridge LUMEN N-1 retirados en código; gateway sin `@hyperion/contracts`).
  Reabiertos: `DEBT-005` (flujo 008→016 y recibo v2 implementados/ensayados localmente; falta paridad
  multi-consumer y cutover de producción) y `DEBT-023` (redirects retirados en código; ops debe confirmar ausencia
  en access logs).
  Quedan además `DEBT-022` (cutover ops + CEDCO), `DEBT-024` (registry SemVer) y `DEBT-026` (HA/offsite en
  entorno objetivo). `DEBT-022` es la única excepción del gate de tenant: fija las cuatro selecciones CEDCO por
  slug a bytes, cantidad, owner, issue y vencimiento.
- [`execution-plan.v1.json`](execution-plan.v1.json): plan maestro de orquestación por waves, dependencias y gates.
  Solo asigna IDs canónicos; no copia descripciones, estados, brechas ni evidencia de la trazabilidad de producto.
  El estado se deriva de las especificaciones NOVA, LUMEN y PULSO, usando la matriz únicamente para
  `LUM-001`–`LUM-006`, que todavía se expresan en prosa en la especificación LUMEN. Cada `issue` reutiliza el
  ticket canónico del producto o de una de las `debtRefs` del item; el plan no inventa un segundo backlog y el
  validador rechaza tanto IDs inexistentes como tickets canónicos de otro alcance. El `owner` del item y de cada
  deuda referenciada debe pertenecer a la misma cell del producto, lo que impide legitimar un ticket cruzado con
  solo mover su `debtRef`.

En las tablas canónicas de requisitos, el primer token controlado de `Estado actual` es la decisión normativa; el
texto posterior documenta alcance o matices. Reabrir un requisito exige cambiar ese token a `Parcial`, `Pendiente`,
`Simulado`, `Demo sintética` o `Bloqueado por decisión`, no añadir una salvedad contradictoria después de
`Implementado`.

Los valores `issue` son identificadores estables del backlog `HYP-*` definidos exclusivamente en
`products.v1.json` y `debt.v1.json`. Varias unidades de ejecución pueden reutilizar el mismo ticket canónico; la
descomposición por waves vive en `EXEC-*`, no en tickets `HYP-EXEC-*` paralelos.

Los estados son operativos, no afirmaciones de despliegue: `active` indica que el componente versionado existe y se
mantiene; `transitioning`, que su frontera aún está en separación; `retiring`, que solo permanece por
compatibilidad; `planned`, que todavía no existe como paquete; y `accepted`, que una deuda tiene retiro trazado.
`dueDate` es la próxima fecha obligatoria de revisión o retiro, según el estado.
En el plan maestro, `accepted` significa que dependencias, requisitos, deudas y gates quedaron acreditados por el
validador; no equivale por sí solo a una afirmación de despliegue fuera del entorno evidenciado.

`pnpm docs:check` rechaza catálogos incompletos, fechas vencidas, inventarios divergentes, estadísticas obsoletas,
deuda sin clasificar y excepciones temporales sin owner, issue o expiración. `pnpm federation:check` escanea SQL
operativo y provider-owned, y solo tolera las ocurrencias históricas selladas que coinciden con este catálogo.

`pnpm execution:check` exige cobertura exacta y exclusiva de todos los requisitos no implementados y todas las
deudas abiertas. También valida el DAG, fechas, productos, waves, catálogos de release y los gates `code`,
`artifact`, `isolation`, `recovery`, `staging` y `operations`. Un item `accepted` falla cerrado si conserva una
deuda o requisito abierto, si alguna dependencia no está aceptada, si falta el release publicado o si no existe la
evidencia versionada de sus gates. `pnpm execution:status` muestra el estado derivado sin modificar las fuentes.

`gateEvidence` no referencia directamente capturas o logs sueltos. Cada entrada debe ser un manifest JSON regular
ubicado directamente bajo `docs/evidence/execution-gates/`, con `schemaVersion: 1`, `itemId`, `productId`, `gate`,
`timestamp` RFC 3339 UTC y al menos una `revision` Git completa o un `snapshot`. Los gates `recovery`, `staging` y
`operations` exigen `snapshot`; los items con `releaseGate` también deben fijar exactamente su `cell` y
`catalogVersion`, además de una única pareja `releaseVersion`/`sourceRevision` de un manifest `published` válido;
todos los gates del item deben coincidir con esa pareja. Las revisiones deben identificar commits existentes y
alcanzables desde `HEAD`, la `revision` del gate debe coincidir con el source del release y un release futuro o
posterior a `acceptedAt` no acredita aceptación. El recibo declara un `verifier` con `status: "passed"`; su comando
debe coincidir por producto y gate con la allowlist explícita de verificadores leaf del validador. Cada entrada fija
nombre, comando y fuente versionada; para tests de workspace también fija el nombre del paquete y el cuerpo exacto
del script. Las únicas plantillas con argumento admitidas sustituyen `<sidecar>` por una ruta segura incluida y
hasheada en el mismo manifest. Los agregados `pnpm check`, `docs:*` y `release:check` no pueden acreditar gates. El
recibo señala además un `resultSidecar` JSON que repite exactamente item, producto, gate,
timestamp, revisión/snapshot/release y resultado del verificador. Todos los recibos incluyen uno o más `sidecars`
no vacíos bajo
`docs/evidence/execution-gates/sidecars/<ITEM>/<GATE>/`; el validador vuelve a calcular cada SHA-256 desde los bytes
del archivo y rechaza enlaces simbólicos o junctions en cualquier componente, rutas externas y logs libres usados
como supuesto resultado. Mientras un item siga `planned` o `transitioning`, su `gateEvidence` permanece vacío: la
evidencia se incorpora únicamente tras ejecutar el gate. Este control acredita vínculos e integridad de evidencia
versionada; por sí solo no prueba una ejecución externa ni sustituye attestations firmadas o readback del entorno
objetivo.

Las entradas con `source: transition-inventory` no incrementan `baselineStats`: documentan trabajo de transición
fuera del baseline de ownership y conservan su propio owner, issue, estado y vencimiento. Algunas, como `DEBT-022`,
sí son consumidas por gates especializados y por ello no pueden divergir de su evidencia ejecutable.
