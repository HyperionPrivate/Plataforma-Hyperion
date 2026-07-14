# Arquitectura

La arquitectura objetivo, los limites de contexto, la propiedad normativa de cada tabla y las decisiones
de migracion estan en [Microservicios autonomos](architecture/AUTONOMOUS-MICROSERVICES.md). El archivo
[`data-ownership.json`](architecture/data-ownership.json) es la fuente ejecutable usada por CI para controlar
SQL literal de runtimes, objetos declarados y claves foráneas entre propietarios. El scanner no interpreta cuerpos
PL/pgSQL; las excepciones de migración como los adaptadores v1 de 038 requieren revisión manual y retiro explícito.

La plataforma se construye como monorepo TypeScript con microservicios HTTP. El gateway es la unica entrada publica prevista; los servicios de dominio quedan en red interna.

## Servicios

| Puerto | Servicio                 | Responsabilidad                                                                       |
| ------ | ------------------------ | ------------------------------------------------------------------------------------- |
| 8080   | api-gateway              | Entrada publica, catalogo y health agregado.                                          |
| 8081   | identity-service         | Operadores, autenticacion, sesiones y permisos.                                       |
| 8082   | tenant-service           | Clientes, organizaciones y configuracion por tenant.                                  |
| 8083   | agent-service            | Automatizacion SOFIA, jobs, ejecuciones y ciclo conversacional.                       |
| 8084   | prompt-flow-service      | Prompts, versiones y flujos conversacionales.                                         |
| 8085   | knowledge-service        | Fuentes de conocimiento e ingesta.                                                    |
| 8086   | audit-service            | Eventos, bitacora y evidencia operacional.                                            |
| 8087   | integration-service      | Fachada del canal actual y readiness compuesto de SOFIA; otros conectores pendientes. |
| 8088   | pulso-iris-service       | Nucleo PULSO IRIS: agenda, conversaciones, handoff y operacion RPA.                   |
| 8089   | whatsapp-channel-service | Canal privado y durable de WhatsApp para SOFIA.                                       |
| 8090   | lumen-service            | Demo clinica LUMEN: preconsulta, dictado, HC y aprobacion.                            |

## Productos y contextos tecnicos

PULSO IRIS y LUMEN son los productos de software. SOFIA es una capacidad de PULSO IRIS, aunque su automatizacion
vive en un contexto tecnico separado para que prompts, jobs, ejecuciones y permisos puedan evolucionar sin
acoplarse al almacenamiento de agenda y conversaciones. La consultoria no es un microservicio. La decision y sus
criterios estan en
[`ADR-0001`](architecture/decisions/ADR-0001-product-service-boundaries.md); el alcance funcional y su cobertura
real se mantienen en [`docs/products`](products/README.md).

## Datos

PostgreSQL arranca con el esquema core `platform`, el esquema de producto `pulso_iris` y los esquemas privados de
runtime. Los datos de muestra solo deben cargarse en entornos de demostracion o prueba; un despliegue productivo
no debe ejecutar semillas sinteticas. El commit y la configuracion realmente desplegados se verifican mediante la
evidencia operativa descrita en [PRODUCTION.md](PRODUCTION.md), no por la sola presencia de codigo en el repositorio.

Durante la transicion, `packages/migrations` aplica primero los archivos SQL versionados, verifica sus checksums y
deja las ocho identidades PostgreSQL de servicio como `NOLOGIN` después de validar la matriz de privilegios.
`db-role-bootstrap` comprueba esa migración ya confirmada y activa o rota los ocho roles en una sola transacción.
Los runtimes con base de datos esperan el éxito del bootstrap (`service_completed_successfully`); solo los dos
one-shot reciben la conexión administrativa. En local las migraciones se ejecutan con `pnpm db:migrate`, seguidas
del bootstrap antes de iniciar runtimes. Los servicios no ejecutan DDL en el arranque y verifican su identidad de
base de datos antes de registrar rutas. Cada contexto migra hacia un historial local: LUMEN ya publica su versión
en `lumen.schema_version` y su readiness no consulta `platform.schema_migrations`.

Las llamadas HTTP internas no comparten una identidad global. Cada arista productor→consumidor recibe una
credencial distinta y el receptor la vincula con `x-hyperion-caller` y con las rutas autorizadas para ese
productor. Un servicio comprometido no obtiene por configuración credenciales de aristas ajenas. Estas
credenciales estáticas son una barrera transicional; un entorno empresarial debe añadir identidad de workload
gestionada, mTLS y rotación externa sin debilitar la autorización por contrato.

## Despliegue

Un Dockerfile multi-stage produce una imagen runtime distinta por servicio Node: cada destino contiene solo el
artefacto del servicio y su cierre de dependencias de produccion, y ejecuta como usuario `node`. Migraciones y el
bootstrap de topologia JetStream tienen imagenes one-shot separadas sin artefactos de aplicaciones; la consola
usa nginx sin privilegios. Cada servicio expone `/health` y `/ready`; los servicios con base de datos validan la
version de esquema que les corresponde antes de quedar sanos y `/ready` responde HTTP 503 cuando alguna
dependencia está caída. El cierre concede 65 segundos por defecto para drenar dispatchers y consumidores antes de
forzar la salida; SOFÍA los detiene en paralelo con su runtime y limita cada consumidor JetStream a 15 segundos,
con cierre forzado de transporte si NATS no completa el drenaje. `SHUTDOWN_TIMEOUT_MS` permite ajustarlo dentro
del rango admitido. `TRUST_PROXY` está desactivado por
defecto y sólo acepta una lista explícita de IP/CIDR, nunca el modo global `true` ni una red `/0`. El gateway no
declara dependencias de arranque sobre los productos: conserva `/health` como liveness propio y reporta
disponibilidad agregada por separado en `/v1/platform/health`, por lo que un producto degradado no bloquea el
resto de la plataforma.

Cada petición autenticada del gateway revalida la sesión con Identity; no conserva una caché positiva local entre
peticiones. Así, logout y revocación no dejan una ventana TTL distinta por réplica, a cambio de que Identity sea
una dependencia síncrona y deba dimensionarse como parte del plano de acceso.

CI construye las imágenes desplegables declaradas por Compose y levanta dos smoke tests reales: el stack base
HTTP y el stack con el overlay JetStream. Esto comprueba build, one-shots, healthchecks y arranque integrado; no
convierte el piloto JetStream de un nodo en una configuración productiva ni sustituye un ensayo de upgrade y
rollback con datos representativos. Un job separado resuelve fail-closed las capacidades del SHA base y ensaya el
upgrade HTTP exacto N-1→current: sólo una base pre-durable abre compatibilidad temporal y, al volver, valida su
polling original; una base current permanece en v2 y debe completar tráfico durable nuevo con su escritor exacto
sobre el esquema actualizado. No atribuye inbox/outbox a binarios que nunca los tuvieron ni prueba mensajes
JetStream pendientes entre versiones.

## Producto inicial

El producto inicial en construccion es PULSO IRIS. La plataforma conserva el nucleo de identidad, tenants,
agentes, integraciones y auditoria, y PULSO IRIS vive en `pulso-iris-service` con esquema propio `pulso_iris`.
La automatizacion de agenda tiene componentes funcionales, pero las integraciones externas simuladas o pendientes
se identifican en la [matriz de trazabilidad](products/REQUIREMENTS-TRACEABILITY.md); no se consideran operacion
productiva por existir en la interfaz.

LUMEN conserva su limite de microservicio y esquema `lumen`. Su runtime consulta proyecciones locales de tenant,
permisos y referencias de encuentros y está preparado para recibir cambios mediante contratos versionados; los
productores, backfill y reconciliación completos siguen pendientes. Registra auditoría mediante outbox, sin SQL
directo sobre `platform` o `pulso_iris`. El corte de demo clínica usa exclusivamente registros
sinteticos identificados y no modifica la logica funcional de `pulso-iris-service`. La consola web y el shell son
compartidos, por lo que cada despliegue de LUMEN incluye una comprobacion de no regresion de las rutas PULSO IRIS.

## Regla para agregar productos

1. Crear una especificacion con propietario, limites, requisitos estables y estado verificable.
2. Definir contexto, datos propios, contratos, SLO, despliegue, respaldo y restauracion independientes.
3. Registrar el producto en `platform.products` y habilitarlo por tenant.
4. Crear operadores, permisos y, cuando aplique, agentes y flujos versionados.
5. Conectar fuentes e integraciones reales sin reutilizar simuladores como evidencia productiva.
6. Registrar cambios y operaciones en el contexto de auditoria.
7. Actualizar la matriz de trazabilidad y las pruebas de limites en el mismo cambio.
