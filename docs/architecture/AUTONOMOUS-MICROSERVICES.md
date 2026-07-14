# Microservicios autonomos

## Estado y objetivo

Hyperion conserva el monorepo, pero evoluciona desde servicios que comparten base de datos hacia contextos
capaces de desplegarse, autorizar, migrar, respaldar y restaurarse de forma independiente. Un directorio o un
puerto no constituye por si solo un microservicio: el propietario de un dato es el unico que puede consultarlo
o modificarlo directamente. Los demas contextos usan contratos HTTP o eventos versionados.

Un producto comercial tampoco equivale necesariamente a un unico runtime. PULSO IRIS incluye la capacidad
SOFIA, aunque `sofia-automation` mantiene un limite tecnico independiente; LUMEN si coincide con un contexto de
producto propio. La regla completa esta en
[`ADR-0001`](decisions/ADR-0001-product-service-boundaries.md) y el alcance verificable en
[`docs/products`](../products/README.md).

La migracion es incremental. La deuda actual queda registrada en
[`boundary-baseline.json`](boundary-baseline.json); no es una autorizacion para crear dependencias nuevas.
Cada dependencia retirada debe eliminar su entrada del baseline en el mismo cambio.

## Contextos delimitados

| Contexto              | Implementacion de transicion | Responsabilidad y datos propios                                                                      |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `edge-gateway`        | `apps/api-gateway`           | Entrada publica, autenticacion de borde, cuotas y enrutamiento; sin datos de dominio.                |
| `access`              | Identity + Tenant            | Tenants, operadores, sesiones, membresias, roles y productos habilitados.                            |
| `pulso-core`          | PULSO IRIS                   | Pacientes administrativos, agenda, citas, conversaciones, mensajes, handoffs y operacion RPA actual. |
| `sofia-automation`    | Agent + Prompt Flow          | Capacidad de PULSO IRIS: agentes, prompts, jobs, ejecuciones y estado privado de SOFIA.              |
| `channel`             | WhatsApp Channel             | Conexiones, eventos inbound, mensajes outbound, bindings y comprobantes de entrega.                  |
| `lumen`               | LUMEN                        | Encuentros, dictados, historias clinicas, resumenes y procesamiento de audio.                        |
| `knowledge`           | Knowledge                    | Fuentes, corpus, ingestas, versiones y retrieval.                                                    |
| `audit`               | Audit                        | Ledger append-only y evidencia durable recibida por contratos.                                       |
| `integration-adapter` | Integration                  | Adaptadores externos durante la transicion; RPA se separa cuando exista un worker real.              |
| `migration-control`   | Migrations                   | Historial tecnico de migraciones; no es una API de dominio.                                          |

No se divide `pulso-core` por tablas. Solo se extrae un subdominio cuando tenga contrato, datos, pruebas,
operacion y restauracion independientes. `integration-service` deja progresivamente de ser un agregador SQL.

## Propiedad de tablas

La fuente normativa y legible por herramientas es [`data-ownership.json`](data-ownership.json). Toda tabla
nueva de un esquema administrado debe agregarse alli en el mismo cambio que su migracion. Las funciones y
procedimientos invocables por SQL tambien tienen propietario para impedir que se usen como acceso lateral.

| Propietario           | Tablas                                                                               |
| --------------------- | ------------------------------------------------------------------------------------ |
| `access`              | `platform.tenants`, `operators`, `operator_sessions`, `operator_tenants`, `products` |
| `sofia-automation`    | `platform.agents`, `prompt_flows`; `agent_runtime.jobs`, `executions`                |
| `knowledge`           | `platform.knowledge_sources`                                                         |
| `audit`               | `platform.audit_events`                                                              |
| `integration-adapter` | `platform.integrations`                                                              |
| `pulso-core`          | Todas las tablas `pulso_iris.*` declaradas en el inventario JSON                     |
| `channel`             | Todas las tablas `channel_runtime.*` declaradas en el inventario JSON                |
| `lumen`               | Todas las tablas `lumen.*` declaradas en el inventario JSON                          |
| `migration-control`   | `platform.schema_migrations`                                                         |

Reglas objetivo para código nuevo. La deuda heredada que todavía las incumple
permanece inventariada explícitamente en el baseline y no se presenta como
aislamiento ya completado:

- Solo el propietario ejecuta SQL sobre una tabla de dominio.
- No se crean FKs, vistas ni triggers entre propietarios. Se conservan identificadores externos sin FK.
- Cada contexto termina con base logica, usuario y migraciones propios; inicialmente pueden compartir cluster.
- Los paquetes compartidos contienen contratos y runtime tecnico, nunca repositorios ni modelos de persistencia.
- Un cambio incompatible usa contratos N/N-1 y una migracion expandir/migrar/contraer.

La primera barrera de ejecucion ya existe aunque el cluster siga compartido: las migraciones crean o desactivan
como `NOLOGIN` las identidades PostgreSQL por contexto y validan toda la matriz; sólo después un bootstrap
transaccional activa los ocho roles juntos. Cada runtime verifica tanto `current_user` como `session_user` antes
de registrar rutas o workers y depende del éxito de ese bootstrap. Solo `db-role-bootstrap` y `migrations`
conservan la conexion administrativa. La matriz vigente y su deuda transicional estan en
[`POSTGRESQL-SERVICE-ROLES.md`](POSTGRESQL-SERVICE-ROLES.md).
El ledger Audit conserva `tenant_id` como identificador externo sin FK a Access; borrar un tenant no reescribe
la evidencia historica.

El runner fija por defecto `lock_timeout=10000ms` y `statement_timeout=300000ms`; ambos presupuestos se ajustan
con `MIGRATION_LOCK_TIMEOUT_MS` y `MIGRATION_STATEMENT_TIMEOUT_MS`. Las migraciones que requieren operaciones
fuera de transacción se marcan explícitamente y deben ser idempotentes; el índice de procedencia Audit se crea de
forma concurrente después de separar expansión, backfill y contrato. El fence de la migración 022 cubre
writers Channel N-1 durante el backfill histórico 023. La migración 021 también se ejecuta en fases autocommit
recuperables y crea sus índices de forma concurrente. CI resuelve de forma fail-closed las capacidades del SHA base
mediante `infra/compatibility-policy.json`: usa el descriptor de la propia base cuando existe y sólo admite una
excepción bootstrap asociada al SHA histórico exacto. Una base `legacy` deja un inbound pre-outbox pendiente, lo
drena tras el upgrade con compatibilidad temporal y después prueba el flujo v2 actual; una base `current` preserva
directamente su escritor y sus contratos v2. Al volver a las imágenes base, una revisión pre-durable valida su
polling original y no se presenta como productora de inbox/outbox inexistentes; una base `current` sí debe completar
un flujo durable nuevo Channel -> PULSO -> SOFIA. El ensayo verifica ledger, identidades restringidas, liveness,
readiness, ejecución SOFÍA y outbound según las capacidades declaradas.

La migración 038 protege además escritores v1 durables de la transición: sus adaptadores reconstruyen siempre las
posiciones desde los ledgers propietarios, comparan cualquier valor suministrado y fallan ante ausencia, versión o
correlación incoherente. Son una excepción temporal explícita: funciones de trigger acotadas leen el ledger Channel
desde PULSO y el ledger PULSO desde SOFÍA, sin conceder `SELECT` cruzado a los roles. Deben retirarse cuando ninguna
revisión soportada emita v1. La barrera automática inventaría las rutinas y el SQL literal de runtime/FK, pero no
interpreta sus cuerpos PL/pgSQL; por eso esta excepción requiere revisión manual mientras exista.

Este recorrido N-1 cubre sólo el transporte HTTP; no demuestra mensajes JetStream pendientes entre binarios ni
cambia su condición de piloto. Tampoco demuestra compatibilidad general de cada operación: exige además un ensayo
con cardinalidad y tráfico representativos antes de cualquier corte productivo. Sólo una política base
`legacy_ephemeral_v1` abre la ventana administrativa global para audio LUMEN N-1, con scope efímero exacto igual a
`PGAPPNAME`, grants transitorios mínimos y fence `NOLOGIN`; el runtime no puede autoatestiguar su destrucción. Una
base `deterministic_v2` conserva el protocolo actual y CI prueba recuperación tras caída y limpieza determinista.
Ambos caminos usan datos sintéticos y bloquean la frontera del proveedor; no equivalen a probar el proveedor real
ni autorizan datos clínicos.

## HTTP y eventos durables

El primer flujo end-to-end con handoffs durables es Channel -> PULSO -> SOFIA -> Audit. HTTP se conserva para consultas o comandos
que necesitan respuesta inmediata. Los efectos asincronos usan outbox/inbox:

1. El propietario cambia su estado y agrega un evento al outbox en la misma transaccion; SOFÍA hace lo mismo con
   sus auditorías de ejecución y respuesta al completar un job.
2. Un dispatcher reintenta la entrega; no se hace dual-write desde la logica de dominio.
3. El consumidor registra `id` en su inbox y aplica el efecto idempotentemente.
4. Un fallo posterior al commit puede duplicar entregas; outbox/inbox evita perder el handoff y duplicar el
   efecto mientras sus almacenes y ventanas de retencion sigan disponibles. No cubre perdida catastrofica del
   unico nodo ni expiracion fuera de retencion.
5. NATS JetStream es un transporte opt-in; HTTP sigue siendo el valor predeterminado y reversible durante la
   migracion.

Esta garantía describe los handoffs durables enumerados. Las auditorías CRUD emitidas directamente por PULSO y la
notificación `channel.message.sent` emitida directamente por Channel aún usan HTTP best-effort fuera de la
transacción de negocio: no tienen retry/outbox ni confirmación durable. Por eso `PUL-033` y `PUL-092` permanecen
parciales y ninguna de esas emisiones se incluye en la garantía anterior. Antes de habilitar ese alcance en
producción deben escribirse en el outbox del propietario dentro de la misma transacción y consumirse con inbox
idempotente en Audit.

Cada arista HTTP interna usa una credencial `PRODUCTOR_TO_CONSUMIDOR_TOKEN` distinta. El productor envía además
`x-hyperion-caller`; el consumidor valida en tiempo constante que identidad, secreto y ruta formen una
combinación autorizada y deriva de esa identidad cualquier procedencia auditable. Las credenciales se entregan
sólo a los dos extremos de la arista y CI rechaza el token global legado, reutilización de valores o filtración a
un tercer servicio. Esto limita la suplantación entre servicios, pero no sustituye identidad de workload
gestionada, mTLS ni rotación externa de secretos en un entorno empresarial.

Sobre de evento minimo y versionado:

```json
{
  "id": "uuid",
  "type": "pulso.message.received.v2",
  "version": 2,
  "tenantId": "uuid",
  "occurredAt": "RFC3339",
  "streamId": "conversation-uuid",
  "streamSequence": 1,
  "payload": {
    "inboundEventId": "channel-inbound-event-uuid",
    "threadBindingId": "channel-thread-uuid",
    "patientId": "patient-uuid",
    "conversationId": "conversation-uuid",
    "messageId": "message-uuid",
    "occurredAt": "RFC3339",
    "sourceStreamId": "channel-thread-uuid",
    "sourceStreamSequence": 1
  }
}
```

El payload contiene el mínimo necesario para el handoff; eso no implica autonomía completa mientras persistan las
consultas SQL transicionales inventariadas en `PUL-211`. Un cuerpo de mensaje puede viajar de Channel a PULSO porque
PULSO es su propietario de negocio; no se transportan transcripts ni historias clínicas, y se prefiere un
identificador cuando existe una consulta autorizada y durable. Cada consumidor valida tipo, versión, tenant,
caller/destino autorizados, tamaño e idempotencia. Al alcanzar el umbral de reintentos, el consumidor persiste
primero una copia minima en DLQ y solo entonces termina el original. La alerta operativa y el redrive auditado
siguen pendientes antes de considerar este transporte apto para produccion.

### JetStream opt-in

El overlay [`infra/docker-compose.jetstream.yml`](../../infra/docker-compose.jetstream.yml) fija NATS Server
`2.14.3`, activa almacenamiento JetStream y exige seis passwords distintos: administracion de topologia,
Channel, PULSO, SOFIA, Audit y LUMEN. Las credenciales no viajan en `NATS_URL` y token/password son mecanismos
mutuamente excluyentes. No publica puertos al host.

`jetstream-topology-bootstrap` usa una imagen minima, crea el stream y diez durables administrados: siete
primarios, dos temporales de compatibilidad v1 para Channel/PULSO y uno de drenaje legado de Audit. Luego valida
drift y sale.
Las aplicaciones esperan su exito, se enlazan con `provisionTopology=false` y no reciben permisos CREATE/UPDATE.
Cada usuario puede publicar exclusivamente sus eventos, consultar/pedir/confirmar sus durables y escribir su
DLQ. La matriz exacta esta en [`infra/nats/README.md`](../../infra/nats/README.md).

La procedencia de Audit se separa en `sofia.audit.event.record.v1` y `lumen.audit.event.record.v1`, con un
durable independiente para cada origen. Las ACL impiden que SOFIA publique como LUMEN y viceversa. El durable
anterior `audit_event_record_v1` permanece sólo para drenar eventos previos a la migración como
`legacy-unknown`; ninguna identidad runtime puede publicar eventos genéricos nuevos. Los endpoints HTTP de
entrega durable sólo se registran cuando `DURABLE_EVENT_TRANSPORT=http`, por lo que no permiten eludir las ACL
cuando el overlay está activo.

El stream `HYPERION_EVENTS` conserva `hyperion.events.>` y `hyperion.dlq.>`; cada consumidor pull durable filtra
un unico tipo, usa ACK explicito y procesa un mensaje a la vez. Los productores publican con
`msgID = event.id` y solo completan su outbox despues del ACK de persistencia del servidor.

```powershell
# Provisionar primero los seis NATS_*_PASSWORD distintos en .env; crean diez durables administrados.
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.jetstream.yml up --build
```

La entrega sigue siendo al-menos-una-vez: la garantia de efecto unico proviene del inbox transaccional del
consumidor. Un evento invalido o que agota entregas se publica primero en DLQ y luego se termina; si la escritura
de DLQ falla, no se descarta el original. El overlay es reversible: retirar el segundo archivo devuelve el flujo
al dispatcher HTTP sin cambiar contratos ni tablas.

Este overlay sigue siendo un piloto de un solo nodo: el stream usa una replica, la DLQ comparte su retencion de
siete dias y aun no existen monitor, alerta ni procedimiento de redrive. No representa alta disponibilidad ni
una configuracion productiva; produccion requiere al menos cluster/replicas, TLS interno, capacidad acotada,
observabilidad y recuperacion probada.

LUMEN aplica el mismo patron para auditoria y mantiene proyecciones privadas de acceso y referencias clinicas.
Acepta `access.lumen.tenant-snapshot.v1`, `access.lumen.operator-grant.v1` y
`pulso.lumen.encounter-reference.v1`; valida tenant, version monotona, hash canonico e idempotencia antes de
actualizar sus tablas. La migracion inicial hace un backfill controlado, pero el runtime no consulta tablas de
`access`, PULSO o Audit. Los productores propietarios de esas proyecciones forman parte de la siguiente fase de
extraccion; hasta entonces los datos de demostracion se cargan exclusivamente con tooling de migracion.

El corte actual de LUMEN procesa audio en un directorio temporal determinista por intento. Sólo confirma un
estado terminal después de borrar el directorio; un fallo queda en `cleanup_pending` y un reconciliador con lease
exclusiva por instancia reintenta la eliminación. Una lease duplicada impide el arranque y la pérdida de heartbeat
degrada readiness. Esta política limita residuos y carreras entre réplicas, pero
no resuelve por sí sola los requisitos de retención de una operación clínica real. La barrera y la decisión
pendiente están registradas en
[`ADR-0002`](decisions/ADR-0002-lumen-audio-retention.md).

## Barrera de CI y retiro de deuda

Ejecutar localmente:

```powershell
pnpm architecture:test
pnpm architecture:check
```

El detector analiza literales SQL en `apps/` y `services/`, omite pruebas y examina `REFERENCES` en migraciones.
Agrupa cada violacion por archivo, propietarios, operacion y tabla. El check falla cuando:

- aparece una tabla administrada sin propietario o SQL de dominio en una ruta sin contexto;
- aparece un acceso SQL o una FK cruzada que no existe en el baseline;
- aumenta el conteo de una violacion existente;
- una violacion disminuye o desaparece pero su entrada obsoleta permanece en el baseline.

El ultimo caso hace visible el progreso y obliga a retirar la excepcion. `--print-baseline` existe solo para
revisar el inventario; no debe utilizarse para aprobar deuda nueva sin una decision arquitectonica explicita.

El workflow de CI también construye todas las imágenes desplegables declaradas por Compose y levanta, con
healthchecks reales, tanto el stack HTTP base como el overlay JetStream. Este smoke detecta targets Docker rotos y
errores de arranque integrado; no sustituye las pruebas de upgrade N-1, rollback, carga o recuperación y no cambia
el estado de JetStream como piloto de un nodo.
