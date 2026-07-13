# Arquitectura

La arquitectura objetivo, los limites de contexto, la propiedad normativa de cada tabla y las decisiones
de migracion estan en [Microservicios autonomos](architecture/AUTONOMOUS-MICROSERVICES.md). El archivo
[`data-ownership.json`](architecture/data-ownership.json) es la fuente ejecutable usada por CI para impedir
que aumenten los accesos SQL y las claves foraneas entre propietarios.

La plataforma se construye como monorepo TypeScript con microservicios HTTP. El gateway es la unica entrada publica prevista; los servicios de dominio quedan en red interna.

## Servicios

| Puerto | Servicio                 | Responsabilidad                                               |
| ------ | ------------------------ | ------------------------------------------------------------- |
| 8080   | api-gateway              | Entrada publica, catalogo y health agregado.                  |
| 8081   | identity-service         | Operadores, autenticacion, sesiones y permisos.               |
| 8082   | tenant-service           | Clientes, organizaciones y configuracion por tenant.          |
| 8083   | agent-service            | Agentes IA, productos, canales y ciclo operacional.           |
| 8084   | prompt-flow-service      | Prompts, versiones y flujos conversacionales.                 |
| 8085   | knowledge-service        | Fuentes de conocimiento e ingesta.                            |
| 8086   | audit-service            | Eventos, bitacora y evidencia operacional.                    |
| 8087   | integration-service      | Voz, WhatsApp, GLPI, ERP, activos y conectores.               |
| 8088   | pulso-iris-service       | Producto PULSO IRIS: Sofia, agenda, handoff y RPA para CEDCO. |
| 8089   | whatsapp-channel-service | Canal privado y durable de WhatsApp para SOFIA.               |
| 8090   | lumen-service            | Demo clinica LUMEN: preconsulta, dictado, HC y aprobacion.    |

## Datos

PostgreSQL arranca con el esquema core `platform`, el esquema de producto `pulso_iris` y los esquemas privados de runtime. No hay datos de muestra en produccion. Los productos reales se cargan cuando exista la informacion operativa real de cada cliente.

Durante la transicion, `db-role-bootstrap` crea o rota ocho identidades PostgreSQL restringidas y
`packages/migrations` aplica despues los archivos SQL versionados y verifica su checksum. Ambos corren como
servicios one-shot antes de los runtimes (`service_completed_successfully`); solo ellos reciben la conexion
administrativa. En local las migraciones se ejecutan con `pnpm db:migrate`. Los servicios no ejecutan DDL en el
arranque y verifican su identidad de base de datos antes de registrar rutas. Cada contexto migra hacia un
historial local: LUMEN ya publica su version en `lumen.schema_version` y su readiness no consulta
`platform.schema_migrations`.

## Despliegue

Un Dockerfile multi-stage produce una imagen runtime distinta por servicio Node: cada destino contiene solo el
artefacto del servicio y su cierre de dependencias de produccion, y ejecuta como usuario `node`. Migraciones y el
bootstrap de topologia JetStream tienen imagenes one-shot separadas sin artefactos de aplicaciones; la consola
usa nginx sin privilegios. Cada servicio expone `/health` y `/ready`; los servicios con base de datos validan la
version de esquema que les corresponde antes de quedar sanos. El gateway no declara dependencias de arranque
sobre los productos: conserva `/health` como liveness propio y reporta disponibilidad agregada por separado en
`/v1/platform/health`, por lo que un producto degradado no bloquea el resto de la plataforma.

## Producto inicial

El producto inicial operativo es PULSO IRIS para CEDCO. La plataforma conserva el nucleo de identidad, tenants, agentes, integraciones y auditoria, y PULSO IRIS vive en `pulso-iris-service` con esquema propio `pulso_iris`.

LUMEN conserva su limite de microservicio y esquema `lumen`. Su runtime consulta proyecciones locales de tenant,
permisos y referencias de encuentros; recibe sus cambios por contratos versionados y registra auditoria mediante
outbox, sin SQL directo sobre `platform` o `pulso_iris`. El corte de demo clinica usa exclusivamente registros
sinteticos identificados y no modifica la logica funcional de `pulso-iris-service`. La consola web y el shell son
compartidos, por lo que cada despliegue de LUMEN incluye una comprobacion de no regresion de las rutas PULSO IRIS.

## Regla para agregar productos

1. Registrar el producto en `platform.products`.
2. Crear tenants y operadores reales.
3. Crear agentes por tenant en `platform.agents`.
4. Versionar flujos en `platform.prompt_flows`.
5. Conectar fuentes reales mediante `platform.knowledge_sources` e `platform.integrations`.
6. Registrar cambios y operaciones en `platform.audit_events`.
