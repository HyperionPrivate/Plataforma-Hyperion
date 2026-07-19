# Arquitectura

La arquitectura objetivo, los limites de contexto, la propiedad normativa de cada tabla y las decisiones
de migracion estan en [Microservicios autonomos](architecture/AUTONOMOUS-MICROSERVICES.md). El archivo
[`data-ownership.json`](architecture/data-ownership.json) es la fuente ejecutable usada por CI para controlar
SQL literal de runtimes (incl. `packages/`), objetos declarados, claves foráneas entre propietarios, cuerpos
PL/pgSQL, triggers y `SECURITY DEFINER` con acceso cruzado. Las únicas excepciones temporales permitidas son las
documentadas en `temporaryExceptions` (hoy: adaptadores v1 de la migración 038); deben retirarse con la deuda.

El repositorio TypeScript actual es una etapa de transición. El destino es una federación con un repositorio y
un ciclo de entrega por producto, más un plano neutral mínimo de Access/SSO, aprovisionamiento, Audit asíncrono y
administración. El gateway existente funciona como fachada temporal de compatibilidad; el borde objetivo enruta
por hostname hacia un BFF por producto, sin lógica de dominio común. `api-gateway` queda fuera del modelo Compose
activo por defecto, sólo publica loopback y se materializa al activar explícitamente el perfil `legacy-gateway`.
La decisión normativa está en
[`ADR-0006`](architecture/decisions/ADR-0006-federated-product-cells.md).

## Servicios de la transición

| Puerto | Servicio                 | Responsabilidad                                                        |
| ------ | ------------------------ | ---------------------------------------------------------------------- |
| 8080   | api-gateway              | Fachada temporal opt-in (`legacy-gateway`); no es el borde objetivo.   |
| 8081   | identity-service         | Plataforma: operadores, autenticación, sesiones y permisos.            |
| 8082   | tenant-service           | Plataforma: tenants, aprovisionamiento, grants y catálogo.             |
| 8083   | agent-service            | PULSO: automatización SOFÍA, jobs, ejecuciones y ciclo conversacional. |
| 8084   | prompt-flow-service      | PULSO: prompts, versiones y flujos conversacionales.                   |
| 8085   | knowledge-service        | PULSO: fuentes de conocimiento, ingesta y retrieval.                   |
| 8086   | audit-service            | Plataforma: consumo asíncrono y evidencia operacional.                 |
| 8087   | integration-service      | PULSO: adaptadores externos durante la transición.                     |
| 8088   | pulso-iris-service       | PULSO: agenda, conversaciones, handoff y operación RPA.                |
| 8089   | whatsapp-channel-service | PULSO: canal privado y durable de WhatsApp para SOFÍA.                 |
| 8090   | lumen-service            | LUMEN: preconsulta, dictado, historia clínica y aprobación.            |
| 8091   | nova-core-service        | NOVA: campañas, contactos, compliance, handoffs y analytics.           |
| 8092   | voice-channel-service    | NOVA: voz y adaptación exclusiva hacia Neutral Dialer v3.              |
| 8093   | liwa-channel-service     | NOVA: canal WhatsApp mediante LIWA.                                    |
| 8094   | documents-service        | NOVA: metadatos y almacenamiento de documentos.                        |

## Productos y contextos tecnicos

NOVA, LUMEN y PULSO IRIS son productos de software. SOFÍA, Prompt Flow, Knowledge, Integration y WhatsApp forman
parte de PULSO aunque conserven límites técnicos separados. Voice, LIWA y Documents forman parte de NOVA hasta
que exista un segundo consumidor real y una decisión posterior cambie su propietario. Coopfuturo es el primer
tenant y `coopfuturo-console` es su aplicación específica, no la consola genérica de NOVA. Neutral Dialer v3
permanece como sistema externo y Voice es su único cliente dentro de Hyperion.

El plano neutral se limita a Access/SSO, aprovisionamiento, Audit asíncrono y una consola administrativa para
usuarios, tenants, grants y catálogo. Puede enlazar a los orígenes de producto, pero no representar sus flujos.
La separación entre producto y contexto técnico de
[`ADR-0001`](architecture/decisions/ADR-0001-product-service-boundaries.md) sigue vigente con los reemplazos
explícitos de [`ADR-0006`](architecture/decisions/ADR-0006-federated-product-cells.md). El alcance funcional y su
cobertura real se mantienen en [`docs/products`](products/README.md).

## Datos

PostgreSQL convive temporalmente en un clúster, pero no en una única unidad de migración: la base global legacy
permanece para compatibilidad y Access, Audit, NOVA, LUMEN y PULSO usan bases lógicas, owners, ledgers, roles y
secuencias de bootstrap independientes. Los datos de muestra solo deben cargarse en demostración o prueba; un
despliegue productivo no debe ejecutar semillas sintéticas. El commit y la configuración realmente desplegados se
verifican mediante la evidencia operativa de [PRODUCTION.md](PRODUCTION.md), no por la sola presencia de código.

Durante la transición, `packages/migrations` conserva la cadena global `001–046` sólo para binarios y ventanas de
compatibilidad que aún no han cortado. Los despliegues provider-owned usan secuencias propias de base lógica →
migrador → bootstrap de roles: Access sobre `hyperion_access`, Audit sobre `hyperion_audit`, NOVA sobre
`hyperion_nova`, LUMEN sobre `hyperion_lumen` y PULSO sobre `hyperion_pulso`. Audit conserva los nombres físicos
`platform.audit_events` y `audit_runtime.inbox_events` dentro de su base lógica, pero no tiene claves foráneas ni
readiness hacia la base global; su ledger es `audit_runtime.migration_ledger`. En PULSO,
`@hyperion/pulso-migrations` controla checksums en `pulso_iris.migration_ledger`, publica la versión actual en
`pulso_iris.schema_version`, publica además el marcador owner-owned de SOFÍA en
`agent_runtime.schema_version` y sólo activa `hyperion_pulso`, `hyperion_sofia`, `hyperion_knowledge`,
`hyperion_integration` y `hyperion_channel` después de verificar estructura y ACL. Ese baseline autónomo aún
contiene 37 FKs hacia sus copias locales de `platform.tenants`/`platform.products`, seis lecturas PL/pgSQL entre
owners y tres funciones `SECURITY DEFINER` N-1; el detector las conserva como deuda efectiva, no como autonomía.

La selección operativa de tenant usa UUID opacos. `pnpm federation:check` inspecciona SQL embebido en runtimes,
archivos SQL provider-owned y scripts operativos, y rechaza predicados sobre `slug` aun cuando usen aliases,
comillas, casts, normalización de texto o comparadores alternativos. La única excepción es el seed CEDCO aún vivo
en la migración global sellada `004`: `DEBT-022` fija sus cuatro ocurrencias a checksum, owner, issue y vencimiento;
una ocurrencia adicional, bytes distintos, metadata divergente o fecha vencida hacen fallar el gate.

Los runtimes con base de datos esperan el éxito del bootstrap (`service_completed_successfully`); sólo los
one-shots de aprovisionamiento reciben una URL administrativa y el runner migra como el owner restringido de su
célula. Los servicios no ejecutan DDL en el arranque y verifican identidad y versión antes de registrar rutas.
Identity y Tenant importan `ACCESS_RUNTIME_MIGRATION_REQUIREMENT`, Audit importa
`AUDIT_RUNTIME_MIGRATION_REQUIREMENT`; Agent y Prompt Flow importan el requisito SOFÍA y consultan
`agent_runtime.schema_version`, mientras los otros cuatro runtimes PULSO con base de datos validan el requisito
global en `pulso_iris.schema_version`. El `SELECT` de `hyperion_sofia` sobre este último marcador se conserva sólo
para que imágenes N−1 sigan arrancando durante la transición registrada en DEBT-027; el runtime current no lo usa.
Ningún runtime actual necesita
`platform.schema_migrations` para estar ready.

Las llamadas HTTP internas no comparten una identidad global. Cada arista productor→consumidor recibe una
credencial distinta y el receptor la vincula con `x-hyperion-caller` y con las rutas autorizadas para ese
productor. Un servicio comprometido no obtiene por configuración credenciales de aristas ajenas. Estas
credenciales estáticas son una barrera transicional; un entorno empresarial debe añadir identidad de workload
gestionada, mTLS y rotación externa sin debilitar la autorización por contrato.

## Despliegue

Cada imagen objetivo contiene únicamente el artefacto y la clausura de dependencias del componente. Se prohíben
los Dockerfiles basados en `pnpm -r build` y los contextos de una célula que incluyan fuentes de otro producto.
PULSO materializa una clausura allowlisted y la construye con `infra/docker/cells/pulso.Dockerfile`; su Compose
standalone contiene PostgreSQL, tres one-shots, seis runtimes de datos, BFF y consola, sin servicios NOVA o LUMEN.
Migradores, bootstrap, consolas e imágenes pertenecen a su célula y se versionan por componente. El filtrado histórico de
una consola compartida mediante `VITE_PRODUCT`, incluido el modo `all`, no constituye aislamiento y debe
retirarse al extraer `nova-console`, `lumen-console`, `pulso-console` y `platform-admin-console`.

Cada servicio expone `/health` y `/ready`; los servicios con base de datos validan la
version de esquema que les corresponde antes de quedar sanos y `/ready` responde HTTP 503 cuando alguna
dependencia está caída. El cierre concede 65 segundos por defecto para drenar dispatchers y consumidores antes de
forzar la salida; SOFÍA los detiene en paralelo con su runtime y limita cada consumidor JetStream a 15 segundos,
con cierre forzado de transporte si NATS no completa el drenaje. `SHUTDOWN_TIMEOUT_MS` permite ajustarlo dentro
del rango admitido. `TRUST_PROXY` está desactivado por
defecto y sólo acepta una lista explícita de IP/CIDR, nunca el modo global `true` ni una red `/0`. La fachada
legacy no declara dependencias de arranque sobre los productos: conserva `/health` como liveness propio y reporta
disponibilidad agregada por separado en `/v1/platform/health`. Esa observabilidad multiproducto sigue siendo
deuda transicional; no participa en el readiness de las células ni se inicia sin `legacy-gateway`.

La revalidación síncrona de cada petición del gateway con Identity es transitoria. Access emitirá JWT breves que
cada BFF validará localmente mediante JWKS; una caída temporal de Identity no debe invalidar tokens ya emitidos.
El grant normativo es `tenantId × productId × roles/capabilities`. Las sesiones de navegador se aíslan por origen
con cookies `HttpOnly`, `Secure` y `SameSite`, sin bearer común en `localStorage`.

El modelo Compose normal no construye ni inicia `api-gateway`. El workflow full-stack se conserva para pushes a
`main` y ejecuciones programadas; activa `legacy-gateway` explícitamente y levanta dos smoke tests reales: el stack base
HTTP y el stack con el overlay JetStream. Esto comprueba build, one-shots, healthchecks y convivencia legacy; no
convierte el piloto JetStream de un nodo en una configuración productiva ni sustituye un ensayo de upgrade y
rollback con datos representativos. Un job separado resuelve fail-closed las capacidades del SHA base y ensaya el
upgrade HTTP exacto N-1→current: sólo una base pre-durable abre compatibilidad temporal y, al volver, valida su
polling original; una base current permanece en v2 y debe completar tráfico durable nuevo con su escritor exacto
sobre el esquema actualizado. No atribuye inbox/outbox a binarios que nunca los tuvieron ni prueba mensajes
JetStream pendientes entre versiones.

## Secuencia de separación

NOVA es la primera célula del corte: su consola genérica `nova-console`, la aplicación específica
`coopfuturo-console`, BFF, servicios, contratos,
migraciones, CI, imágenes y manifiesto de release ya están separados dentro del monorepo. Sólo después de demostrar
build, arranque, migración, rollback, backup y restore sin PULSO o LUMEN se extraerá con historial a un repositorio
independiente.

LUMEN repite el patrón con su consola, BFF, servicio, datos y entrega. El corte técnico PULSO ya incluye SOFÍA,
Prompt Flow, Knowledge, Integration y WhatsApp, además de migrador, contratos, readiness, contexto Docker y
Compose propios. El runtime current de SOFÍA dejó de consultar `administrative_patients`, `conversations` y
`messages` directamente y usa rutas internas del propietario PULSO; la inicialización de agenda también dejó de
ser un trigger de Access y se materializa idempotentemente en el primer uso autorizado de PULSO.

PULSO aún no se declara extraído ni operativamente autónomo: el stack global conserva migraciones y grants para
N/N−1, y su propio baseline provider-owned conserva 46 hallazgos efectivos registrados en DEBT-001–DEBT-005 y
DEBT-029–DEBT-031. También faltan cutover, backup, restore y rollback con evidencia del ambiente objetivo. Los
redirects y la fachada de gateway pueden convivir durante ese corte bajo el perfil `legacy-gateway`, pero se
retiran con telemetría y no reciben lógica de dominio nueva. Este aislamiento de ejecución no resuelve
`DEBT-032`: el snapshot y los proxies directos siguen vivos mientras exista compatibilidad bearer N-1.

## Regla para agregar productos

1. Crear una especificacion con propietario, limites, requisitos estables y estado verificable.
2. Definir consola, BFF, contextos, datos, contratos, migraciones, SLO, CI, despliegue, respaldo y restauracion
   independientes.
3. Registrar el producto en `platform.products` y habilitarlo por tenant.
4. Crear operadores, permisos y, cuando aplique, agentes y flujos versionados.
5. Conectar fuentes e integraciones reales sin reutilizar simuladores como evidencia productiva.
6. Registrar cambios y operaciones mediante Audit asíncrono, fuera del camino crítico.
7. Actualizar la matriz de trazabilidad y las pruebas de límites en el mismo cambio.
8. Demostrar que el artefacto y su contexto de build no contienen rutas, fuentes ni endpoints de otros productos.
