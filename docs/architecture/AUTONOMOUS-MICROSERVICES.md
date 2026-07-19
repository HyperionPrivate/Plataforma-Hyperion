# Microservicios autonomos

## Estado y objetivo

Hyperion usa el monorepo como etapa de transición mientras evoluciona desde servicios que comparten base de datos
hacia células capaces de construir, desplegar, autorizar, migrar, respaldar y restaurarse de forma independiente.
El destino es un repositorio por producto más un plano neutral mínimo de plataforma. Un directorio o un puerto no
constituye por sí solo un microservicio: el propietario de un dato es el único que puede consultarlo o modificarlo
directamente. Los demás contextos usan contratos HTTP o eventos versionados.

Un producto comercial tampoco equivale necesariamente a un único runtime. NOVA contiene core, Voice, LIWA y
Documents. PULSO IRIS incluye SOFÍA, Prompt Flow, Knowledge, Integration y WhatsApp, aunque esas capacidades
mantengan límites técnicos separados. LUMEN coincide por ahora con un contexto de producto propio. Access/SSO,
aprovisionamiento y Audit asíncrono forman el plano neutral. Las reglas completas están en
[`ADR-0001`](decisions/ADR-0001-product-service-boundaries.md) y
[`ADR-0006`](decisions/ADR-0006-federated-product-cells.md); el alcance verificable está en
[`docs/products`](../products/README.md).

La migracion es incremental. La deuda actual queda registrada en
[`boundary-baseline.json`](boundary-baseline.json); no es una autorizacion para crear dependencias nuevas.
Cada dependencia retirada debe eliminar su entrada del baseline en el mismo cambio.

## Contextos delimitados

| Contexto              | Célula objetivo | Implementación de transición | Responsabilidad y datos propios                                                               |
| --------------------- | --------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `edge-gateway`        | Compatibilidad  | `apps/api-gateway`           | Fachada temporal; el destino es routing por hostname sin lógica de dominio.                   |
| `access`              | Plataforma      | Identity + Tenant            | Tenants, operadores, sesiones, membresías, grants y productos habilitados.                    |
| `audit`               | Plataforma      | Audit                        | Ledger append-only y evidencia durable consumida de forma asíncrona.                          |
| `pulso-core`          | PULSO IRIS      | PULSO IRIS                   | Pacientes administrativos, agenda, citas, conversaciones, mensajes, handoffs y operación RPA. |
| `sofia-automation`    | PULSO IRIS      | Agent + Prompt Flow          | Agentes, prompts, jobs, ejecuciones y estado privado de SOFÍA.                                |
| `channel`             | PULSO IRIS      | WhatsApp Channel             | Conexiones, eventos inbound, mensajes outbound, bindings y comprobantes de entrega.           |
| `knowledge`           | PULSO IRIS      | Knowledge                    | Fuentes, corpus, ingestas, versiones y retrieval.                                             |
| `integration-adapter` | PULSO IRIS      | Integration                  | Adaptadores externos durante la transición.                                                   |
| `lumen`               | LUMEN           | LUMEN                        | Encuentros, dictados, historias clínicas, resúmenes y procesamiento de audio.                 |
| `nova-core`           | NOVA            | NOVA Core                    | Contactos, campañas, compliance, segmentación, handoffs y analytics.                          |
| `voice`               | NOVA            | Voice Channel                | Estado de llamadas y adaptación exclusiva hacia Neutral Dialer v3.                            |
| `liwa`                | NOVA            | LIWA Channel                 | Mensajería, bindings y webhooks del proveedor LIWA.                                           |
| `documents`           | NOVA            | Documents                    | Metadatos, referencias y almacenamiento de documentos.                                        |
| `migration-control`   | Compatibilidad  | Migrations                   | Cadena global `001–046`, congelada para binarios y ventanas N/N−1.                            |
| `pulso-migration`     | PULSO IRIS      | PULSO Migrations             | Base lógica, catálogo estructural, ledger, versión y roles provider-owned.                    |

No se divide `pulso-core` por tablas. Solo se extrae un subdominio cuando tenga contrato, datos, pruebas,
operación y restauración independientes. `integration-service` consume la readiness de agenda mediante la API
propietaria de PULSO y la de workers/prompts mediante la API de SOFÍA, sin SQL cruzado ni fallback. SOFÍA también
dejó de leer y escribir por SQL los pacientes, conversaciones y mensajes de PULSO: el runtime current usa rutas
internas autenticadas del propietario.
Voice, LIWA y Documents permanecen en NOVA mientras no exista un segundo consumidor real; Knowledge,
Integration y WhatsApp permanecen en PULSO bajo la misma regla. Neutral Dialer v3 es externo y solo Voice lo
consume. Las consolas y BFF se separan por célula según ADR-0006; la administración neutral no incluye flujos de
producto.

## Propiedad de tablas

La fuente normativa y legible por herramientas es [`data-ownership.json`](data-ownership.json). Toda tabla
nueva de un esquema administrado debe agregarse alli en el mismo cambio que su migracion. Las funciones y
procedimientos invocables por SQL tambien tienen propietario para impedir que se usen como acceso lateral.

| Propietario           | Tablas                                                                                |
| --------------------- | ------------------------------------------------------------------------------------- |
| `access`              | `platform.tenants`, `operators`, `operator_sessions`, `operator_tenants`, `products`  |
| `sofia-automation`    | `platform.agents`, `prompt_flows`; tablas `agent_runtime.*`, incluido su marker local |
| `knowledge`           | `platform.knowledge_sources`                                                          |
| `audit`               | `platform.audit_events`                                                               |
| `integration-adapter` | `platform.integrations`                                                               |
| `pulso-core`          | Dominio y control provider-owned (`pulso_iris.*`) declarados en el inventario JSON    |
| `channel`             | Todas las tablas `channel_runtime.*` declaradas en el inventario JSON                 |
| `lumen`               | Todas las tablas `lumen.*` declaradas en el inventario JSON                           |
| `nova-core`           | Todas las tablas `nova.*` declaradas en el inventario JSON                            |
| `voice`               | Todas las tablas `voice.*` declaradas en el inventario JSON                           |
| `liwa`                | Todas las tablas `liwa.*` declaradas en el inventario JSON                            |
| `documents`           | Todas las tablas `documents.*` declaradas en el inventario JSON                       |
| `migration-control`   | `platform.schema_migrations` (sólo compatibilidad heredada)                           |

Reglas objetivo para código nuevo. La deuda heredada que todavía las incumple
permanece inventariada explícitamente en el baseline y no se presenta como
aislamiento ya completado:

- Solo el propietario ejecuta SQL sobre una tabla de dominio.
- No se crean FKs, vistas ni triggers entre propietarios. Se conservan identificadores externos sin FK.
- Cada contexto termina con base logica, usuario y migraciones propios; inicialmente pueden compartir cluster.
- Los contratos son propiedad del proveedor y se publican por plataforma, Audit o producto con SemVer y soporte
  N/N-1; ningún paquete obliga a conocer el catálogo completo.
- Cada build e imagen contiene solo la clausura del componente. No se admite `pnpm -r build` en Docker ni un
  contexto de NOVA con fuentes de PULSO o LUMEN.
- Un cambio incompatible usa contratos N/N-1 y una migracion expandir/migrar/contraer.

La primera barrera de ejecución ya existe aunque el clúster físico pueda seguir compartido: las migraciones crean
o desactivan como `NOLOGIN` las identidades PostgreSQL por célula y validan toda la matriz; sólo después un
bootstrap transaccional activa las identidades declaradas juntas. Cada runtime verifica tanto `current_user` como
`session_user` antes de registrar rutas o workers y depende del éxito de ese bootstrap. La URL administrativa se
limita a los one-shots de base y roles; cada runner provider-owned migra con su owner restringido.

PULSO define `hyperion_pulso` como base lógica, `hyperion_pulso_migrator` como owner y cinco roles runtime. Agent y
Prompt Flow validan el marcador owner-owned `agent_runtime.schema_version`; los otros cuatro servicios con base de
datos continúan sobre `pulso_iris.schema_version`. El grant de lectura del marcador global para `hyperion_sofia`
permanece de forma explícita y temporal para imágenes N−1, no como dependencia del runtime current. La matriz
vigente y la distinción frente al stack de
compatibilidad están en [`POSTGRESQL-SERVICE-ROLES.md`](POSTGRESQL-SERVICE-ROLES.md).
El ledger Audit conserva `tenant_id` como identificador externo sin FK a Access; borrar un tenant no reescribe
la evidencia historica.

Access tampoco inicializa datos de producto al crear tenants. La migración provider-owned de plataforma retira
`trg_initialize_agenda_settings`; PULSO materializa sus defaults de agenda de forma idempotente en el primer uso
autorizado. Así, la escritura Access ya no ejecuta un trigger ni una función que conozca `pulso_iris`.

La clausura de build PULSO se materializa desde una allowlist que incluye únicamente sus apps, seis servicios y
paquetes transitivos autorizados. `infra/docker-compose.pulso.yml` ordena PostgreSQL → tres one-shots → runtimes →
BFF → consola, usa URLs externas para Access/Audit y no declara servicios NOVA o LUMEN. Esta topología es evidencia
versionada de separación dentro del monorepo; no sustituye el cutover, un drill de backup/restore ni la extracción
con historial a otro repositorio.

El runner fija por defecto `lock_timeout=10000ms` y `statement_timeout=300000ms`; ambos presupuestos se ajustan
con `MIGRATION_LOCK_TIMEOUT_MS` y `MIGRATION_STATEMENT_TIMEOUT_MS`. Las migraciones que requieren operaciones
fuera de transacción se marcan explícitamente y deben ser idempotentes; el índice de procedencia Audit se crea de
forma concurrente después de separar expansión, backfill y contrato. El fence de la migración 022 cubre
writers Channel N-1 durante el backfill histórico 023. La migración 021 también se ejecuta en fases autocommit
recuperables y crea sus índices de forma concurrente. CI resuelve de forma fail-closed las capacidades del SHA base
mediante `infra/compatibility-policy.json`: usa el descriptor de la propia base cuando existe y sólo admite una
excepción bootstrap asociada al SHA histórico exacto. Channel/outbox, limpieza LUMEN, propiedad SOFÍA → PULSO y
validación de delivery Channel → PULSO son capacidades independientes; `owner_api_v2` no se infiere de la presencia
del outbox. Una base `legacy` deja un
inbound pre-outbox pendiente, lo drena tras el upgrade con compatibilidad temporal y después prueba el flujo v2
actual; una base `current` preserva directamente su escritor y sus contratos v2. Al volver a las imágenes base, una
revisión pre-durable valida su polling original y no se presenta como productora de inbox/outbox inexistentes; una
base `current` sí debe completar un flujo durable nuevo Channel -> PULSO -> SOFIA. El ensayo verifica ledger,
identidades restringidas, liveness, readiness, ejecución SOFÍA y outbound según las capacidades declaradas.

Antes de iniciar cualquier workload N-1, CI detiene los runtimes actuales, arranca únicamente PostgreSQL y exige
que todo `channel.delivery.updated.v1` existente esté `published`; además conserva un fingerprint de sus filas y
comprueba al cierre que N-1 no las haya modificado. La revisión histórica pre-durable necesita, sólo mientras se
ejecuta su polling, una excepción SQL directa PULSO → Channel: `USAGE` en `channel_runtime`; `SELECT` sobre
`thread_bindings(id, patient_id, conversation_id, tenant_id)` e
`inbound_events(tenant_id, external_message_id, provider)`; y `UPDATE` sobre
`thread_bindings(patient_id, conversation_id, last_inbound_at, updated_at)` e
`inbound_events(thread_binding_id, message_id, updated_at)`. La allow-list se verifica por privilegio efectivo,
rechaza cualquier otro permiso efectivo de tabla o columna, se revoca en un paso `always()` idempotente y el
cierre falla si queda algún acceso de esquema o DML efectivo. Por tanto, este camino demuestra un rollback acotado
y supervisado; no convierte
el binario pre-durable en un servicio autónomo ni autoriza mantenerlo operando después de cerrar la ventana.

La misma base histórica declara por separado `legacy_direct_sql_v1` para SOFÍA. Antes de arrancar workloads, CI
restaura su baseline de `USAGE` y `SELECT` PULSO y añade sólo `UPDATE(metadata, primary_intent, updated_at)` en
`conversations`, `INSERT(tenant_id, conversation_id, sender, body, provider, external_message_id, delivery_status,
metadata)` y `UPDATE(body)` en `messages`. Un control positivo autoriza formas representativas del camino ejercitado
por el binario exacto y los probes de deriva rechazan propiedad, membresías, escrituras de tabla, columnas DML o
tablas de lectura adicionales, secuencias, rutinas y grant options.

El Channel histórico declara de forma independiente `legacy_direct_sql_v1`: su repositorio valida el mensaje y
proyecta delivery directamente en `pulso_iris.messages`. CI abre sólo `USAGE` del esquema, `SELECT` sobre
`id, tenant_id, conversation_id, sender, body, provider, delivery_status, delivered_at, metadata` y `UPDATE` sobre
`provider, provider_message_id, delivery_status, delivered_at, metadata`. Los controles
positivos ejercitan las formas de enqueue y transición sin filas; los probes de deriva rechazan cualquier objeto,
columna o facultad adicional. El Channel actual usa la API/evento del propietario y declara `owner_api_v2`.

El cleanup detiene Agent y Prompt Flow —ambos consumen la identidad SOFÍA— además de Channel y PULSO, cierra y
atestigua cada ventana aplicable, y conserva los contenedores para diagnóstico antes del teardown. La matriz durable
continúa sin escrituras cruzadas: el acceso actual usa las rutas autenticadas del propietario PULSO.

Los contratos nuevos de auditoría PULSO/Channel y de entrega Channel → PULSO siguen la misma disciplina. Las
migraciones 041 y 044 son fases de expansión con checks `NOT VALID`; 042 y 045 construyen los índices únicos de
forma concurrente y verifican su catálogo antes de avanzar el ledger; 043 y 046 validan los contratos históricos
con los presupuestos finitos del runner. Esta secuencia reduce el bloqueo, pero no sustituye medirla con la
cardinalidad y el tráfico del ambiente de destino.

La migración 038 protege además escritores v1 durables de la transición: sus adaptadores reconstruyen siempre las
posiciones desde los ledgers propietarios, comparan cualquier valor suministrado y fallan ante ausencia, versión o
correlación incoherente. Son una excepción temporal explícita: funciones de trigger acotadas leen el ledger Channel
desde PULSO y el ledger PULSO desde SOFÍA, sin conceder `SELECT` cruzado a los roles. Deben retirarse cuando ninguna
revisión soportada emita v1. La barrera automática interpreta los cuerpos PL/pgSQL literales, triggers y
`SECURITY DEFINER`: las excepciones de la cadena global 038 son temporales y los mismos adaptadores del baseline
provider-owned PULSO permanecen visibles como DEBT-029–DEBT-031. El SQL dinámico requiere además política
fail-closed y revisión manual. Esta excepción de adaptadores v1 durables es distinta de las ventanas SQL directas y columnares que necesita exclusivamente la base
histórica pre-durable durante su polling y delivery N-1.

Este recorrido N-1 cubre sólo el transporte HTTP; no demuestra mensajes JetStream pendientes entre binarios ni
cambia su condición de piloto. Tampoco demuestra compatibilidad general de cada operación: exige además un ensayo
con cardinalidad y tráfico representativos antes de cualquier corte productivo. Sólo una política base
`legacy_ephemeral_v1` abre la ventana administrativa global para audio LUMEN N-1, con scope efímero exacto igual a
`PGAPPNAME`, grants transitorios mínimos y fence `NOLOGIN`; el runtime no puede autoatestiguar su destrucción. Una
base `deterministic_v2` conserva el protocolo actual y CI prueba recuperación tras caída y limpieza determinista.
Ambos caminos usan datos sintéticos y bloquean la frontera del proveedor; no equivalen a probar el proveedor real
ni autorizan datos clínicos.

## HTTP y eventos durables

El primer flujo end-to-end con handoffs durables es Channel -> PULSO -> SOFIA -> Audit. Incluye tanto el mensaje
entrante como la proyección del resultado de entrega Channel → PULSO y los eventos de auditoría. HTTP se conserva
para consultas o comandos que necesitan respuesta inmediata. Los efectos asincronos usan outbox/inbox:

1. El propietario cambia su estado y agrega un evento al outbox en la misma transaccion; SOFÍA hace lo mismo con
   sus auditorías de ejecución y respuesta al completar un job.
2. Un dispatcher reintenta la entrega; no se hace dual-write desde la logica de dominio.
3. El consumidor registra `id` en su inbox y aplica el efecto idempotentemente.
4. Un fallo posterior al commit puede duplicar entregas; outbox/inbox evita perder el handoff y duplicar el
   efecto mientras sus almacenes y ventanas de retencion sigan disponibles. No cubre perdida catastrofica del
   unico nodo ni expiracion fuera de retencion.
5. NATS JetStream es un transporte opt-in; HTTP sigue siendo el valor predeterminado y reversible durante la
   migracion.

El cliente runtime de PULSO exige una `DatabaseTransaction` activa para encolar
`pulso.audit.event.record.v1`: la mutación relevante y su registro de outbox se confirman o revierten juntas.
Channel ya inserta
`channel.audit.event.record.v1` en la transacción que marca `channel.message.sent`. Audit recibe ambos contratos,
registra el `event_id` en su inbox y agrega el ledger idempotentemente, sin que PULSO ni Channel escriban tablas de
Audit. Esta cobertura permite considerar `PUL-092` implementado para las mutaciones relevantes versionadas; no
incluye auditoría de lecturas sensibles (`PUL-093`).

El E2E ejecuta el cambio real `channel.message.sent`, despacha su auditoría y comprueba inbox y ledger. Para PULSO,
el mismo E2E encola dos eventos sintéticos dentro de una transacción real, los despacha y verifica sus efectos en
Audit; las pruebas de integración de cada ruta son las que demuestran que la mutación de dominio y ese enqueue se
confirman o revierten juntas. La combinación aporta evidencia del contrato completo sin atribuir al E2E una ruta
de negocio PULSO que no ejecuta.

Los resultados `sent`, `failed`, `uncertain`, `reconcile` y `cancel_source` tampoco se escriben de forma remota
dentro de una transacción Channel. Channel agrega `channel.delivery.updated.v1` a su outbox en la misma transacción
que cambia el outbound, con un stream monotónico por mensaje; PULSO exige la siguiente secuencia y aplica el cambio
junto con su inbox. El `POST` directo de delivery permanece como superficie autenticada de compatibilidad N-1,
pero el runtime Channel actual no lo usa para proyectar estados. `PUL-033` sigue parcial solamente porque repetir
la cancelación por la ruta pública aún devuelve una transición inválida; `PUL-202` sigue parcial por las mutaciones
CRUD que todavía no exigen una clave idempotente, no por la auditoría ni por un dual-write de delivery.

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

El payload contiene el mínimo necesario para el handoff. El runtime current ya cerró el SQL SOFÍA → PULSO, pero
eso no implica autonomía operativa completa mientras el stack global, los adaptadores N/N−1 y el cutover de datos
sigan pendientes. Un cuerpo de mensaje puede viajar de Channel a PULSO porque PULSO es su propietario de negocio;
no se transportan transcripts ni historias clínicas, y se prefiere un
identificador cuando existe una consulta autorizada y durable. Cada consumidor valida tipo, versión, tenant,
caller/destino autorizados, tamaño e idempotencia. Al alcanzar el umbral de reintentos, el consumidor persiste
primero una copia minima en DLQ y solo entonces termina el original. La alerta operativa y el redrive auditado
siguen pendientes antes de considerar este transporte apto para produccion.

### JetStream opt-in

El overlay [`infra/docker-compose.jetstream.yml`](../../infra/docker-compose.jetstream.yml) fija NATS Server
`2.14.3`, activa almacenamiento JetStream y exige siete passwords distintos: administracion de topologia,
Access, Channel, PULSO, SOFIA, Audit y LUMEN. Las credenciales no viajan en `NATS_URL` y token/password son mecanismos
mutuamente excluyentes. No publica puertos al host.

`jetstream-topology-bootstrap` usa una imagen minima, crea el stream y catorce durables administrados: once
activos, dos temporales de compatibilidad v1 para Channel/PULSO y uno de drenaje legado de Audit. Luego valida
drift y sale.
Las aplicaciones esperan su exito, se enlazan con `provisionTopology=false` y no reciben permisos CREATE/UPDATE.
Cada usuario puede publicar exclusivamente sus eventos, consultar/pedir/confirmar sus durables y escribir su
DLQ. La matriz exacta esta en [`infra/nats/README.md`](../../infra/nats/README.md).

La procedencia de Audit se separa en `sofia.audit.event.record.v1`, `lumen.audit.event.record.v1`,
`pulso.audit.event.record.v1` y `channel.audit.event.record.v1`, con un durable independiente para cada origen.
Las ACL impiden que una identidad publique con la procedencia de otra. El durable
anterior `audit_event_record_v1` permanece sólo para drenar eventos previos a la migración como
`legacy-unknown`; ninguna identidad runtime puede publicar eventos genéricos nuevos. Los endpoints HTTP de
sobres durables sólo se registran cuando `DURABLE_EVENT_TRANSPORT=http`, por lo que no quedan como dispatchers
paralelos cuando el overlay está activo. El `POST` directo de delivery Channel → PULSO permanece autenticado como
compatibilidad N-1, no es usado por el Channel actual y debe retirarse al cerrar esa ventana.

El stream `HYPERION_EVENTS` conserva `hyperion.events.>` y `hyperion.dlq.>`; cada consumidor pull durable filtra
un unico tipo, usa ACK explicito y procesa un mensaje a la vez. Los productores publican con
`msgID = event.id` y solo completan su outbox despues del ACK de persistencia del servidor.

```powershell
# Provisionar primero los siete NATS_*_PASSWORD distintos en .env; crean catorce durables administrados.
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
