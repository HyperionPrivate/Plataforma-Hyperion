# PULSO IRIS

## 1. Identidad y propósito

PULSO IRIS es el producto de Hyperion para atención administrativa multicanal y gestión de agenda. Su objetivo es
recibir solicitudes, conservar el contexto operativo, consultar disponibilidad, reservar, cancelar o reagendar citas,
derivar excepciones a una persona y ofrecer trazabilidad de la operación sin incorporar funciones clínicas.

SOFÍA es la capacidad conversacional de PULSO IRIS: interpreta solicitudes administrativas y usa contratos del
producto para consultar o ejecutar acciones. No es un producto comercial independiente. Técnicamente, su runtime,
prompts, trabajos y ejecuciones pertenecen al contexto `sofia-automation`, mientras los datos y reglas de agenda
pertenecen a `pulso-core`. Esta separación permite desplegar y evolucionar la automatización sin transferirle la
propiedad de los datos de PULSO IRIS.

La separación vigente entre contextos está definida en [Microservicios autónomos](../architecture/AUTONOMOUS-MICROSERVICES.md)
y su propiedad ejecutable en [data-ownership.json](../architecture/data-ownership.json).

## 2. Alcance y límites

PULSO IRIS es responsable de:

- catálogos administrativos de sedes, profesionales, pagadores y tipos de cita;
- reglas de disponibilidad, bloqueos, festivos, asociaciones y exclusiones de agenda;
- pacientes administrativos, conversaciones y mensajes proyectados al dominio;
- reservas temporales, citas, transiciones de estado y verificación;
- handoffs, lista de espera, campañas y representación de acciones RPA;
- vistas operativas y métricas derivadas de sus datos;
- inbox, outbox y contratos necesarios para colaborar con otros contextos.

PULSO IRIS no es propietario de:

- autenticación, operadores, tenants o membresías, que pertenecen a `access`;
- sesiones y comprobantes de entrega del canal, que pertenecen a `channel`;
- prompts, jobs y ejecuciones de SOFÍA, que pertenecen a `sofia-automation`;
- el ledger de auditoría, que pertenece a `audit`;
- historias clínicas, diagnósticos, resultados o decisiones asistenciales, que quedan fuera del producto;
- credenciales ni estado interno de sistemas externos.

La frontera funcional es administrativa. SOFÍA puede informar sobre catálogos y preparación administrativa,
pero no debe diagnosticar, interpretar síntomas ni recomendar tratamientos. Una señal de síntomas o urgencia debe
interrumpir la automatización normal y generar una derivación humana segura.

## 3. Actores

| Actor                       | Responsabilidad                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| Paciente o acudiente        | Solicita información administrativa y gestiona citas después de identificarse.                |
| SOFÍA                       | Interpreta el mensaje y usa exclusivamente herramientas autorizadas de PULSO IRIS.            |
| Asesor                      | Atiende excepciones, revisa conversaciones y ejecuta operaciones permitidas.                  |
| Coordinador                 | Supervisa colas, agenda, configuración operativa y handoffs.                                  |
| Administrador               | Gestiona configuración, integraciones habilitadas y acceso operativo.                         |
| Auditor                     | Consulta evidencia y trazabilidad sin modificar el dominio.                                   |
| Adaptador de canal          | Recibe o entrega mensajes sin apropiarse de la conversación de negocio.                       |
| Adaptador de agenda externa | Traduce operaciones de PULSO IRIS al sistema externo sin exponer sus credenciales al dominio. |

Los roles de operador admitidos están versionados en
[007-operator-roles.sql](../../packages/migrations/sql/007-operator-roles.sql) y en los
[contratos compartidos](../../packages/contracts/src/index.ts).

## 4. Convenciones de estado

Esta especificación distingue el objetivo funcional del estado demostrable en el repositorio:

| Estado       | Significado                                                                                |
| ------------ | ------------------------------------------------------------------------------------------ |
| Implementado | Existe runtime funcional, persistencia y pruebas automatizadas para el alcance indicado.   |
| Parcial      | Existe una porción verificable, pero falta parte del flujo, canal, gobierno o integración. |
| Simulado     | La interfaz o el modelo existen, pero el efecto externo usa datos o ejecución simulados.   |
| Pendiente    | No existe todavía una implementación funcional demostrable.                                |

Los estados describen la rama que contiene este documento. No constituyen una declaración de disponibilidad en un
entorno externo.

## 5. Requisitos funcionales

### 5.1 Producto, tenant y configuración

| ID      | Requisito                                                                                                                      | Estado actual                                                                                                              | Evidencia versionada                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUL-001 | Registrar PULSO IRIS como producto y mantener a SOFÍA como su agente/capacidad, con propiedad técnica separada.                | Implementado                                                                                                               | [002-pulso-iris.sql](../../packages/migrations/sql/002-pulso-iris.sql), [data-ownership.json](../architecture/data-ownership.json)                                                                        |
| PUL-002 | Aislar toda operación de dominio por `tenant_id` y denegar accesos cruzados.                                                   | Implementado                                                                                                               | [006-tenant-isolation.sql](../../packages/migrations/sql/006-tenant-isolation.sql), [tenant-isolation.integration.test.ts](../../services/pulso-iris-service/src/tenant-isolation.integration.test.ts)    |
| PUL-003 | Habilitar y configurar el producto por tenant sin depender de un cliente sembrado ni seleccionar uno por nombre en la consola. | Parcial: el dominio está aislado, pero el bootstrap y la selección inicial conservan acoplamiento al tenant de referencia. | [002-pulso-iris.sql](../../packages/migrations/sql/002-pulso-iris.sql), [006-tenant-isolation.sql](../../packages/migrations/sql/006-tenant-isolation.sql), [app.tsx](../../apps/web-console/src/app.tsx) |
| PUL-010 | Administrar sedes, profesionales, pagadores y tipos de cita sin depender de valores codificados en la UI.                      | Implementado                                                                                                               | [config-routes.ts](../../services/pulso-iris-service/src/config-routes.ts), [011-configurable-agenda.sql](../../packages/migrations/sql/011-configurable-agenda.sql)                                      |
| PUL-011 | Configurar horarios, bloqueos, festivos, asociaciones profesional-sede, tipos atendidos y exclusiones por pagador.             | Implementado                                                                                                               | [config-routes.ts](../../services/pulso-iris-service/src/config-routes.ts), [availability-engine.ts](../../services/pulso-iris-service/src/availability-engine.ts)                                        |
| PUL-012 | Importar configuración con vista previa, validación y aplicación explícita, y permitir exportarla.                             | Implementado                                                                                                               | [agenda-config-csv.ts](../../services/pulso-iris-service/src/agenda-config-csv.ts), [config-routes.ts](../../services/pulso-iris-service/src/config-routes.ts)                                            |

### 5.2 Canales, identidad y conversación

| ID      | Requisito                                                                                                                                  | Estado actual                                                                                                                            | Evidencia versionada                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUL-020 | Recibir mensajes de WhatsApp mediante un adaptador privado, persistirlos de forma durable y proyectarlos a una conversación de PULSO IRIS. | Parcial: existe un canal controlado de prueba; falta un adaptador oficial para operación general.                                        | [whatsapp-channel-service/README.md](../../services/whatsapp-channel-service/README.md), [channel-inbound-events.ts](../../services/pulso-iris-service/src/channel-inbound-events.ts)                                        |
| PUL-021 | Recibir llamadas de voz, mantener una conversación y ejecutar transferencia en caliente.                                                   | Pendiente                                                                                                                                | [ARCHITECTURE.md](../ARCHITECTURE.md)                                                                                                                                                                                        |
| PUL-022 | Conservar una conversación administrativa unificada con mensajes, estado, intención y relación opcional con paciente.                      | Parcial: implementado para el flujo actual de WhatsApp; falta continuidad multicanal completa.                                           | [002-pulso-iris.sql](../../packages/migrations/sql/002-pulso-iris.sql), [analytics-routes.ts](../../services/pulso-iris-service/src/analytics-routes.ts)                                                                     |
| PUL-023 | Identificar al paciente o acudiente antes de exponer o modificar datos administrativos.                                                    | Parcial: existe vinculación controlada por canal y datos administrativos mínimos; falta un protocolo completo de identidad y acudientes. | [sofia-tools-routes.ts](../../services/pulso-iris-service/src/sofia-tools-routes.ts), [012-whatsapp-sofia-runtime.sql](../../packages/migrations/sql/012-whatsapp-sofia-runtime.sql)                                         |
| PUL-024 | Evitar que datos de sesión, identificadores crudos del canal o credenciales pasen a mensajes, logs o eventos de negocio sin necesidad.     | Parcial                                                                                                                                  | [whatsapp-channel-service/README.md](../../services/whatsapp-channel-service/README.md), [channel-inbound-events.ts](../../services/pulso-iris-service/src/channel-inbound-events.ts)                                        |
| PUL-025 | Proyectar de forma durable e idempotente cada mensaje entrante aceptado por el canal vigente en la conversación propietaria de PULSO IRIS. | Implementado para el contrato de canal vigente.                                                                                          | [channel-inbound-events.ts](../../services/pulso-iris-service/src/channel-inbound-events.ts), [channel-inbound-events.integration.test.ts](../../services/pulso-iris-service/src/channel-inbound-events.integration.test.ts) |

### 5.3 Agenda y citas

| ID      | Requisito                                                                                                                                 | Estado actual                                                                                                                                                 | Evidencia versionada                                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUL-030 | Consultar disponibilidad aplicando tenant, fecha, zona horaria, sede, profesional, pagador, tipo de cita, capacidad, bloqueos y festivos. | Implementado para la agenda interna/configurada.                                                                                                              | [availability-engine.ts](../../services/pulso-iris-service/src/availability-engine.ts), [availability-routes.ts](../../services/pulso-iris-service/src/availability-routes.ts)               |
| PUL-031 | Crear un hold temporal e idempotente antes de reservar, y liberar su capacidad al cancelar o expirar.                                     | Implementado                                                                                                                                                  | [appointment-routes.ts](../../services/pulso-iris-service/src/appointment-routes.ts), [appointment-hold-expiration.ts](../../services/pulso-iris-service/src/appointment-hold-expiration.ts) |
| PUL-032 | Crear una cita únicamente desde un hold válido y no comunicar éxito hasta obtener un estado verificable.                                  | Implementado para agenda interna; la verificación externa real está pendiente.                                                                                | [internal-agenda-provider.ts](../../services/pulso-iris-service/src/internal-agenda-provider.ts), [appointment-routes.ts](../../services/pulso-iris-service/src/appointment-routes.ts)       |
| PUL-033 | Cancelar una cita futura mediante una transición explícita, idempotente y auditada.                                                       | Parcial: la herramienta SOFÍA conserva idempotencia y la auditoría es atómica/durable, pero repetir la ruta pública todavía devuelve una transición inválida. | [appointment-routes.ts](../../services/pulso-iris-service/src/appointment-routes.ts), [sofia-tools-routes.ts](../../services/pulso-iris-service/src/sofia-tools-routes.ts)                   |
| PUL-034 | Reagendar sin perder trazabilidad, respetando disponibilidad, límites configurados e idempotencia.                                        | Implementado para agenda interna o flujo híbrido.                                                                                                             | [appointment-routes.ts](../../services/pulso-iris-service/src/appointment-routes.ts), [internal-agenda-provider.ts](../../services/pulso-iris-service/src/internal-agenda-provider.ts)       |
| PUL-035 | Programar y entregar recordatorios multicanal según una política configurable.                                                            | Pendiente: existen modelos y superficies relacionadas, no un ejecutor completo.                                                                               | [005-pulso-iris-operations.sql](../../packages/migrations/sql/005-pulso-iris-operations.sql)                                                                                                 |
| PUL-036 | Gestionar lista de espera y ofrecer automáticamente un cupo liberado al siguiente candidato compatible.                                   | Parcial: alta y consulta disponibles; autorrelleno pendiente.                                                                                                 | [operations-routes.ts](../../services/pulso-iris-service/src/operations-routes.ts), [analytics-routes.ts](../../services/pulso-iris-service/src/analytics-routes.ts)                         |
| PUL-037 | Registrar no-show, medirlo y ejecutar un flujo de recuperación configurable.                                                              | Parcial: estado y analítica disponibles; recuperación automática pendiente.                                                                                   | [011-configurable-agenda.sql](../../packages/migrations/sql/011-configurable-agenda.sql), [analytics-routes.ts](../../services/pulso-iris-service/src/analytics-routes.ts)                   |
| PUL-038 | Admitir un modo híbrido donde una persona verifica la operación externa antes de marcar la cita como verificada.                          | Implementado                                                                                                                                                  | [appointment-routes.ts](../../services/pulso-iris-service/src/appointment-routes.ts), [011-configurable-agenda.sql](../../packages/migrations/sql/011-configurable-agenda.sql)               |

### 5.4 SOFÍA y seguridad de acciones

| ID      | Requisito                                                                                                                            | Estado actual                                  | Evidencia versionada                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PUL-050 | SOFÍA debe limitarse a catálogos, disponibilidad y operaciones administrativas ofrecidas por herramientas tipadas.                   | Implementado para el flujo actual de WhatsApp. | [sofia-tools.ts](../../services/agent-service/src/sofia-tools.ts), [sofia-runtime.ts](../../services/agent-service/src/sofia-runtime.ts)                                                                                                                                                                     |
| PUL-051 | Reservar, cancelar o reagendar requiere una confirmación explícita posterior y vinculada a la acción exacta.                         | Implementado                                   | [013-sofia-confirmation-protocol.sql](../../packages/migrations/sql/013-sofia-confirmation-protocol.sql), [sofia-tools.ts](../../services/agent-service/src/sofia-tools.ts)                                                                                                                                  |
| PUL-052 | Una afirmación sobre disponibilidad debe basarse en una consulta fresca del mismo job y conservar fecha, hora y filtros solicitados. | Implementado                                   | [014-sofia-local-time-protocol.sql](../../packages/migrations/sql/014-sofia-local-time-protocol.sql), [015-sofia-fresh-availability.sql](../../packages/migrations/sql/015-sofia-fresh-availability.sql), [016-sofia-search-constraints.sql](../../packages/migrations/sql/016-sofia-search-constraints.sql) |
| PUL-053 | Una señal de síntomas o urgencia debe detener las herramientas de agenda, emitir un mensaje prudente y crear un handoff prioritario. | Implementado para el canal actual.             | [sofia-runtime.ts](../../services/agent-service/src/sofia-runtime.ts), [sofia-tools-routes.ts](../../services/pulso-iris-service/src/sofia-tools-routes.ts)                                                                                                                                                  |
| PUL-054 | Conservar memoria administrativa estructurada entre sesiones y canales sin convertir el historial narrativo en fuente de verdad.     | Pendiente                                      | [AUTONOMOUS-MICROSERVICES.md](../architecture/AUTONOMOUS-MICROSERVICES.md)                                                                                                                                                                                                                                   |

### 5.5 Handoff, automatización externa y campañas

| ID      | Requisito                                                                                                                                        | Estado actual                                                                                      | Evidencia versionada                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUL-060 | Crear y actualizar handoffs con trigger, prioridad, estado, resumen y SLA.                                                                       | Parcial: persistencia y cola operativa disponibles; faltan todas las modalidades de transferencia. | [operations-routes.ts](../../services/pulso-iris-service/src/operations-routes.ts), [002-pulso-iris.sql](../../packages/migrations/sql/002-pulso-iris.sql)                       |
| PUL-061 | Transferir una conversación de voz en caliente y entregar al asesor el contexto administrativo necesario.                                        | Pendiente                                                                                          | [ARCHITECTURE.md](../ARCHITECTURE.md)                                                                                                                                            |
| PUL-070 | Representar acciones RPA con prioridad, idempotencia, estado, worker y telemetría.                                                               | Simulado                                                                                           | [005-pulso-iris-operations.sql](../../packages/migrations/sql/005-pulso-iris-operations.sql), [operations-routes.ts](../../services/pulso-iris-service/src/operations-routes.ts) |
| PUL-071 | Ejecutar y verificar acciones contra una agenda externa mediante un adaptador real, aislado y reemplazable.                                      | Pendiente                                                                                          | [agenda-provider.ts](../../services/pulso-iris-service/src/agenda-provider.ts), [appointment-routes.ts](../../services/pulso-iris-service/src/appointment-routes.ts)             |
| PUL-072 | Degradar a verificación manual o diferida cuando no exista integración externa disponible, sin declarar una cita como verificada prematuramente. | Implementado                                                                                       | [appointment-routes.ts](../../services/pulso-iris-service/src/appointment-routes.ts), [011-configurable-agenda.sql](../../packages/migrations/sql/011-configurable-agenda.sql)   |
| PUL-080 | Crear, pausar y consultar campañas con segmento, canales, cadencia y presupuesto lógico.                                                         | Simulado: CRUD y visualización disponibles, sin motor externo de contacto.                         | [operations-routes.ts](../../services/pulso-iris-service/src/operations-routes.ts), [CampaignsPage.tsx](../../apps/web-console/src/pages/CampaignsPage.tsx)                      |

### 5.6 Consola, métricas y auditoría

| ID      | Requisito                                                                                                                                 | Estado actual                                                                                                                          | Evidencia versionada                                                                                                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUL-090 | Mostrar operación, conversaciones, agenda, configuración, RPA, campañas y BI con permisos por rol.                                        | Parcial: superficies principales disponibles; algunas dependen de datos simulados.                                                     | [web-console](../../apps/web-console/src), [analytics-routes.ts](../../services/pulso-iris-service/src/analytics-routes.ts)                                                                                                                             |
| PUL-091 | Calcular métricas desde datos del dominio y distinguir valores medidos de líneas base configurables.                                      | Parcial: existen consultas; algunas líneas base siguen codificadas y no representan costos observados.                                 | [analytics-routes.ts](../../services/pulso-iris-service/src/analytics-routes.ts), [BiPage.tsx](../../apps/web-console/src/pages/BiPage.tsx)                                                                                                             |
| PUL-092 | Registrar eventos de mutación relevantes en el contexto de auditoría sin permitir que PULSO IRIS escriba su ledger directamente.          | Implementado para las mutaciones relevantes versionadas: PULSO encola dentro de la misma transacción y Audit consume idempotentemente. | [audit-client.ts](../../services/pulso-iris-service/src/audit-client.ts), [audit-client.integration.test.ts](../../services/pulso-iris-service/src/audit-client.integration.test.ts), [event-inbox.ts](../../services/audit-service/src/event-inbox.ts) |
| PUL-093 | Auditar cada lectura de datos administrativos sensibles, aplicar retención y atender solicitudes de titulares mediante flujos explícitos. | Pendiente                                                                                                                              | [data-ownership.json](../architecture/data-ownership.json)                                                                                                                                                                                              |

## 6. Requisitos no funcionales

| ID      | Requisito                                                                                                                                              | Estado actual                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUL-200 | Cada contexto debe acceder por SQL únicamente a sus tablas; las dependencias nuevas usan HTTP o eventos versionados.                                   | Parcial: CI controla SQL literal/FK y el baseline histórico; 038 conserva adaptadores v1 y el rollback pre-durable abre una allow-list SQL columnar temporal.          |
| PUL-201 | Toda entrada HTTP, mensaje y evento debe validarse contra contratos tipados, con tenant, versión y límites de tamaño.                                  | Parcial: los handoffs durables y rutas principales validan esquemas; quedan consultas analíticas y CRUD por migrar desde parsing manual a contratos tipados estrictos. |
| PUL-202 | Las mutaciones deben ser idempotentes y las entregas asíncronas deben usar inbox/outbox, sin dual-write de dominio.                                    | Parcial: las entregas y auditorías asíncronas cubiertas usan inbox/outbox; varias mutaciones CRUD aún no exigen idempotencia.                                          |
| PUL-203 | La identidad de base de datos y los permisos de runtime deben aplicar mínimo privilegio.                                                               | Parcial: roles aislados y matriz fail-closed; la ventana N-1 pre-durable concede y revoca permisos columnarmente acotados bajo supervisión.                            |
| PUL-204 | Los eventos deben transportar solo los datos mínimos; no deben incluir historia clínica ni credenciales.                                               | Implementado como regla arquitectónica; requiere revisión continua.                                                                                                    |
| PUL-205 | Los servicios deben exponer liveness y readiness sin convertir la indisponibilidad de PULSO IRIS en caída de toda la plataforma.                       | Implementado.                                                                                                                                                          |
| PUL-206 | Toda transición externa debe ser observable mediante estado, timestamps, intentos y resultado sanitizado.                                              | Parcial; completa para flujos internos, simulada para RPA y campañas.                                                                                                  |
| PUL-207 | Los fallos posteriores a commit deben tolerar reentrega sin duplicar el efecto de negocio.                                                             | Implementado para el flujo durable actual; el E2E exige ACK confirmado, primera entrega, consumidor sin pendientes y binding propietario.                              |
| PUL-208 | Latencia, capacidad y disponibilidad deben medirse con percentiles y carga representativa antes de fijar un SLO.                                       | Pendiente: el repositorio no demuestra todavía SLO operativos generales.                                                                                               |
| PUL-209 | Backups, restauración y migraciones deben poder separarse por contexto antes de declarar autonomía completa.                                           | Parcial: roles y límites existen; clúster e historial principal siguen en transición.                                                                                  |
| PUL-210 | Logs, errores y telemetría deben evitar cuerpos de conversación, identificadores crudos, secretos y datos innecesarios.                                | Parcial; existen salvaguardas específicas y debe mantenerse como criterio de revisión.                                                                                 |
| PUL-211 | SOFÍA debe operar como contexto técnico autónomo con readiness, trabajos, inbox/outbox y acceso a otros dominios solo mediante contratos propietarios. | Parcial: el runtime y el flujo durable existen, pero permanecen accesos SQL transicionales inventariados.                                                              |

Las limitaciones de autonomía y del transporte durable se describen en
[Microservicios autónomos](../architecture/AUTONOMOUS-MICROSERVICES.md), y la operación segura disponible en
[PRODUCTION.md](../PRODUCTION.md).

## 7. Contratos, eventos y datos

### 7.1 Contratos HTTP

La entrada pública prevista es el gateway. PULSO IRIS publica:

- salud y catálogo del producto;
- rutas bajo `/v1/tenants/{tenantId}/pulso-iris/` para agenda, citas, conversaciones, handoffs, RPA, campañas,
  configuración, dashboard y BI;
- un contrato interno de herramientas de SOFÍA bajo
  `/internal/v1/tenants/{tenantId}/pulso-iris/sofia/tools/{toolName}`;
- contratos internos para recibir eventos inbound y de delivery del canal cuando el transporte durable activo sea HTTP;
- una ruta directa autenticada de actualización de delivery conservada sólo para la ventana de compatibilidad
  N-1; el Channel actual proyecta esos cambios mediante `channel.delivery.updated.v1`.

Las definiciones y validaciones están en [packages/contracts](../../packages/contracts/src/index.ts), las rutas de
dominio en [pulso-iris-service](../../services/pulso-iris-service/src) y el enrutamiento de borde en
[api-gateway](../../apps/api-gateway/src/app.ts). Un consumidor no debe consultar tablas de PULSO IRIS para
reemplazar estos contratos.

### 7.2 Eventos durables

El flujo durable vigente usa sobres versionados e idempotentes:

| Evento                          | Productor          | Consumidor         | Propósito y estado                                                                                                                     |
| ------------------------------- | ------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `channel.inbound.received.v1`   | `channel`          | `pulso-core`       | Compatibilidad temporal; PULSO obtiene la posición desde el ledger propietario de Channel antes de persistir.                          |
| `channel.inbound.received.v2`   | `channel`          | `pulso-core`       | Entregar un mensaje inbound con `streamId` y `streamSequence` asignados por Channel.                                                   |
| `channel.delivery.updated.v1`   | `channel`          | `pulso-core`       | Proyectar resultados de delivery en un stream ordenado por mensaje, con inbox y control de huecos en PULSO.                            |
| `pulso.message.received.v1`     | `pulso-core`       | `sofia-automation` | Compatibilidad temporal; SOFÍA resuelve en PULSO la posición de conversación y la posición de origen.                                  |
| `pulso.message.received.v2`     | `pulso-core`       | `sofia-automation` | Solicitar procesamiento con secuencia de conversación y referencia ordenada al stream de Channel; es el contrato objetivo del runtime. |
| `channel.audit.event.record.v1` | `channel`          | `audit`            | Registrar `channel.message.sent` desde el outbox atómico de Channel.                                                                   |
| `pulso.audit.event.record.v1`   | `pulso-core`       | `audit`            | Registrar mutaciones relevantes desde el outbox de la misma transacción PULSO.                                                         |
| `sofia.audit.event.record.v1`   | `sofia-automation` | `audit`            | Registrar evidencia de la ejecución de SOFÍA con procedencia explícita.                                                                |

La topología está declarada en
[jetstream-bootstrap.ts](../../packages/durable-events/src/jetstream-bootstrap.ts). HTTP continúa siendo el
transporte predeterminado y el overlay de broker es opt-in; ambos deben conservar la misma semántica de contrato.

En v2, la posición la asigna el productor y el consumidor sólo acepta el siguiente número contiguo. La proyección
de delivery usa el mismo principio con una secuencia independiente por mensaje. El outbox de PULSO y la cola de
jobs de SOFÍA aplican head-of-line por conversación: un reintento del elemento N mantiene N+1 diferido. Inbox,
job, checkpoint y el evento de auditoría de encolado de SOFÍA se confirman en una sola
transacción. Al completar el job, su estado, ejecución, conversación y auditorías de ejecución/respuesta también
se confirman atómicamente. Las pruebas
versionadas cubren huecos, replays v1/v2 y competencia entre workers con PostgreSQL; esto demuestra el comportamiento
del código bajo esos escenarios controlados, no un SLO ni alta disponibilidad del broker.

Los durables v1 y v2 son distintos. `CHANNEL_INBOUND_V1_COMPATIBILITY` y
`PULSO_MESSAGE_V1_COMPATIBILITY` permanecen `disabled` salvo durante una transición supervisada. El orden operativo
es consumidores compatibles, productores v2, drenaje v1 y cierre de la ventana; el rollback se ejecuta en sentido
inverso, retirando primero el productor v2. No se asume compatibilidad arbitraria de un binario N-1 con una fase de
contrato de base de datos que no haya sido ensayada.

El rehearsal de CI resuelve de forma fail-closed las capacidades declaradas por la revisión base. Para la frontera
histórica pre-durable deja un inbound pendiente, lo drena tras el upgrade y luego prueba v2; al volver a esa base
valida su polling original, sin atribuirle contratos que no implementaba. Una base que ya declara `current_v2`
preserva su evento v2 y, tras el rollback de imágenes, debe completar otro recorrido durable con su escritor exacto.
Este ensayo cubre el transporte HTTP predeterminado; no certifica mensajes JetStream pendientes entre binarios
N-1/current. Los adaptadores v1 de la migración 038 son una excepción DB transicional revisada por separado y se
retiran cuando ninguna revisión soportada emita esos contratos.

Antes de cualquier workload N-1 se exige que todos los `channel.delivery.updated.v1` estén publicados y se
registra un fingerprint que debe permanecer idéntico al cierre. La base histórica pre-durable necesita para su
polling una ventana distinta de los adaptadores 038: `USAGE` en `channel_runtime`; `SELECT` sobre
`thread_bindings(id, patient_id, conversation_id, tenant_id)` e
`inbound_events(tenant_id, external_message_id, provider)`; y `UPDATE` sobre
`thread_bindings(patient_id, conversation_id, last_inbound_at, updated_at)` e
`inbound_events(thread_binding_id, message_id, updated_at)`. CI rechaza columnas adicionales y un cleanup
`always()` revoca y verifica el cierre. Esto prueba una operación de rollback supervisada, no una topología
autónoma permanente para ese binario histórico.

Las mutaciones relevantes propias de PULSO llaman `audit-client.ts` con la misma `DatabaseTransaction` que cambia
el dominio. El cliente sólo encola `pulso.audit.event.record.v1`; no dispone de fallback HTTP ni puede escribir el
ledger de Audit. El dispatcher reintenta por HTTP o JetStream con la misma semántica, y Audit deduplica por
`event_id` en su inbox antes de agregar el ledger. Las pruebas de integración cubren commit conjunto, rollback
conjunto y replay idempotente. Esta garantía respalda PUL-092 para las mutaciones relevantes versionadas; PUL-033
permanece parcial exclusivamente por la idempotencia pendiente de la ruta pública repetida, y PUL-093 sigue fuera
de alcance porque exige auditoría de lecturas sensibles y políticas de retención.

El E2E aporta evidencia de transporte al encolar dos auditorías PULSO sintéticas dentro de una transacción real,
despacharlas y comprobar inbox y ledger. La evidencia de que cada mutación de negocio se confirma o revierte junto
con su auditoría proviene de las pruebas de integración de las rutas correspondientes; el E2E no sustituye esas
pruebas de acoplamiento transaccional.

### 7.3 Datos propios

`pulso-core` es propietario de las tablas `pulso_iris.*` registradas en
[data-ownership.json](../architecture/data-ownership.json). Se agrupan así:

- **Catálogo y reglas:** `sites`, `professionals`, `payers`, `appointment_types`, `agenda_settings`,
  `availability_rules`, `agenda_blocks`, `holidays`, asociaciones y exclusiones.
- **Agenda:** `appointment_holds`, `appointments`, `appointment_status_history`.
- **Atención administrativa:** `administrative_patients`, `conversations`, `messages`, `handoffs`, `waitlist`.
- **Automatización y operación:** `rpa_actions`, `rpa_workers`, `rpa_events`, `campaigns`, `campaign_contacts`,
  `operational_kpi_snapshots`.
- **Integración durable:** `inbox_events`, `outbox_events`, `channel_threads`.

Los identificadores de tenant, operador o recursos externos se conservan como referencias de contrato. El objetivo
es no crear nuevas claves foráneas, vistas, funciones o consultas SQL entre propietarios.

## 8. Criterios de aceptación

Los criterios siguientes definen cuándo una capacidad puede considerarse implementada. Deben ejecutarse con datos
sintéticos o controlados.

| ID         | Criterio                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA-PUL-001 | Las barreras arquitectónicas pasan y no aparece acceso SQL ni FK cruzada nueva fuera del baseline.                                                                                                                    |
| CA-PUL-002 | Una identidad de un tenant no puede leer ni mutar recursos de otro tenant por API o SQL de runtime.                                                                                                                   |
| CA-PUL-003 | La reentrega del mismo evento inbound produce una sola conversación/mensaje de negocio y un solo efecto posterior.                                                                                                    |
| CA-PUL-004 | Una reserva, cancelación o reagenda no se ejecuta en el mensaje que la prepara, exige confirmación posterior exacta y es idempotente ante reintentos.                                                                 |
| CA-PUL-005 | Una consulta de disponibilidad respeta fecha, hora local y filtros actuales; SOFÍA no reutiliza como verdad una respuesta anterior.                                                                                   |
| CA-PUL-006 | Dos solicitudes concurrentes no consumen por encima de la capacidad del mismo slot.                                                                                                                                   |
| CA-PUL-007 | Cancelar o reagendar conserva historial, autor, motivo y vínculo entre cita original y reemplazo.                                                                                                                     |
| CA-PUL-008 | En modo híbrido, ninguna cita queda verificada sin evidencia externa introducida por un rol autorizado.                                                                                                               |
| CA-PUL-009 | Una señal controlada de síntomas detiene la agenda y crea como máximo un handoff prioritario; una solicitud administrativa ordinaria no lo hace.                                                                      |
| CA-PUL-010 | Los eventos inválidos, sobredimensionados, de caller/destino no autorizado o versión no admitida se rechazan sin mutar el dominio.                                                                                    |
| CA-PUL-011 | Logs y telemetría de las pruebas no contienen secretos, identificadores crudos del canal ni cuerpos completos innecesarios.                                                                                           |
| CA-PUL-012 | La caída de PULSO IRIS aparece en salud agregada, pero no convierte el liveness del gateway ni el de otros productos en fallo.                                                                                        |
| CA-PUL-013 | Un adaptador externo de agenda solo cambia PUL-071 a Implementado después de demostrar reserva, verificación, cancelación, reagenda, idempotencia y recuperación ante resultado incierto.                             |
| CA-PUL-014 | El canal WhatsApp solo cambia PUL-020 a Implementado después de sustituir el modo de prueba y superar pruebas de entrega, reentrega, conciliación y revocación controlada.                                            |
| CA-PUL-015 | Voz y transferencia solo cambian PUL-021/PUL-061 a Implementado después de pruebas E2E de llamada, contexto, fallback y auditoría.                                                                                    |
| CA-PUL-016 | Recordatorios, lista de espera, no-show y campañas requieren un scheduler/worker durable, políticas configurables y pruebas con reloj controlado antes de considerarse implementados.                                 |
| CA-PUL-017 | PUL-093 requiere autorización por rol, auditoría de lecturas, retención verificable y pruebas de borrado/solicitudes antes de tratar datos reales.                                                                    |
| CA-PUL-018 | Una instalación vacía puede registrar y habilitar PULSO IRIS para cualquier tenant autorizado sin sembrar un cliente concreto, reasignar administradores globalmente ni seleccionar el tenant por un slug codificado. |

La validación general del repositorio se ejecuta con `pnpm check`. Las pruebas de agenda y SOFÍA están junto a sus
runtimes en [pulso-iris-service](../../services/pulso-iris-service/src) y
[agent-service](../../services/agent-service/src).

## 9. Fuera de alcance

Quedan fuera de PULSO IRIS:

- diagnóstico, triage clínico, interpretación de resultados, prescripción o recomendación terapéutica;
- creación o custodia de historia clínica;
- aprobación automática de decisiones clínicas;
- facturación clínica y documentación asistencial, que corresponden a otros productos o sistemas;
- gestión de identidad y permisos de plataforma;
- custodia de sesiones y credenciales de canales o agendas externas;
- compromisos comerciales, precios, cronogramas contractuales o métricas de negocio no medidas;
- declarar como real una integración, campaña, canal o dato que el repositorio identifica como simulado o de prueba.

## 10. Evidencia normativa del repositorio

En caso de contradicción, el orden técnico de precedencia es:

1. contratos y validaciones versionados;
2. propiedad de datos y barreras arquitectónicas ejecutables;
3. migraciones y runtime del servicio propietario;
4. pruebas automatizadas;
5. esta especificación y el resto de la documentación narrativa.

Cambiar un requisito funcional exige actualizar su implementación, contratos, pruebas, estado en este documento y,
cuando corresponda, el inventario de propiedad de datos en el mismo cambio.
