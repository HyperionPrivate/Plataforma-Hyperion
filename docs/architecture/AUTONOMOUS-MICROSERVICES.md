# Microservicios autonomos

## Estado y objetivo

Hyperion conserva el monorepo, pero evoluciona desde servicios que comparten base de datos hacia contextos
capaces de desplegarse, autorizar, migrar, respaldar y restaurarse de forma independiente. Un directorio o un
puerto no constituye por si solo un microservicio: el propietario de un dato es el unico que puede consultarlo
o modificarlo directamente. Los demas contextos usan contratos HTTP o eventos versionados.

La migracion es incremental. La deuda actual queda registrada en
[`boundary-baseline.json`](boundary-baseline.json); no es una autorizacion para crear dependencias nuevas.
Cada dependencia retirada debe eliminar su entrada del baseline en el mismo cambio.

## Contextos delimitados

| Contexto              | Implementacion de transicion | Responsabilidad y datos propios                                                                      |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `edge-gateway`        | `apps/api-gateway`           | Entrada publica, autenticacion de borde, cuotas y enrutamiento; sin datos de dominio.                |
| `access`              | Identity + Tenant            | Tenants, operadores, sesiones, membresias, roles y productos habilitados.                            |
| `pulso-core`          | PULSO IRIS                   | Pacientes administrativos, agenda, citas, conversaciones, mensajes, handoffs y operacion RPA actual. |
| `sofia-automation`    | Agent + Prompt Flow          | Agentes, prompts, jobs, ejecuciones y estado privado de SOFIA.                                       |
| `channel`             | WhatsApp Channel             | Conexiones, eventos inbound, mensajes outbound, bindings y comprobantes de entrega.                  |
| `lumen`               | LUMEN                        | Encuentros, dictados, historias clinicas, resumenes y procesamiento de audio.                        |
| `knowledge`           | Knowledge                    | Fuentes, corpus, ingestas, versiones y retrieval; Graphify solo como motor interno evaluado.         |
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

Reglas invariantes:

- Solo el propietario ejecuta SQL sobre una tabla de dominio.
- No se crean FKs, vistas ni triggers entre propietarios. Se conservan identificadores externos sin FK.
- Cada contexto termina con base logica, usuario y migraciones propios; inicialmente pueden compartir cluster.
- Los paquetes compartidos contienen contratos y runtime tecnico, nunca repositorios ni modelos de persistencia.
- Un cambio incompatible usa contratos N/N-1 y una migracion expandir/migrar/contraer.

La primera barrera de ejecucion ya existe aunque el cluster siga compartido: Compose crea una identidad
PostgreSQL restringida por contexto, y cada runtime verifica tanto `current_user` como `session_user` antes de
registrar rutas o workers. Solo `db-role-bootstrap` y `migrations` conservan la conexion administrativa. La
matriz vigente y su deuda transicional estan en
[`POSTGRESQL-SERVICE-ROLES.md`](POSTGRESQL-SERVICE-ROLES.md).
El ledger Audit conserva `tenant_id` como identificador externo sin FK a Access; borrar un tenant no reescribe
la evidencia historica.

## HTTP y eventos durables

El primer flujo autonomo es Channel -> PULSO -> SOFIA -> Audit. HTTP se conserva para consultas o comandos
que necesitan respuesta inmediata. Los efectos asincronos usan outbox/inbox:

1. El propietario cambia su estado y agrega un evento al outbox en la misma transaccion.
2. Un dispatcher reintenta la entrega; no se hace dual-write desde la logica de dominio.
3. El consumidor registra `id` en su inbox y aplica el efecto idempotentemente.
4. Un fallo posterior al commit puede duplicar entregas; outbox/inbox evita perder el handoff y duplicar el
   efecto mientras sus almacenes y ventanas de retencion sigan disponibles. No cubre perdida catastrofica del
   unico nodo ni expiracion fuera de retencion.
5. NATS JetStream es un transporte opt-in; HTTP sigue siendo el valor predeterminado y reversible durante la
   migracion.

Sobre de evento minimo y versionado:

```json
{
  "id": "uuid",
  "type": "pulso.conversation.message-recorded.v1",
  "version": 1,
  "tenantId": "uuid",
  "occurredAt": "RFC3339",
  "payload": {}
}
```

El payload contiene solo los datos necesarios para que el consumidor sea autonomo. Un cuerpo de mensaje puede
viajar de Channel a PULSO porque PULSO es su propietario de negocio; no se transportan transcripts ni historias
clinicas, y se prefiere un identificador cuando existe una consulta autorizada y durable. Cada consumidor valida
version, tenant, audiencia, tamano e idempotencia. Al alcanzar el umbral de reintentos, el consumidor persiste
primero una copia minima en DLQ y solo entonces termina el original. La alerta operativa y el redrive auditado
siguen pendientes antes de considerar este transporte apto para produccion.

### JetStream opt-in

El overlay [`infra/docker-compose.jetstream.yml`](../../infra/docker-compose.jetstream.yml) fija NATS Server
`2.14.3`, activa almacenamiento JetStream y exige seis passwords distintos: administracion de topologia,
Channel, PULSO, SOFIA, Audit y LUMEN. Las credenciales no viajan en `NATS_URL` y token/password son mecanismos
mutuamente excluyentes. No publica puertos al host.

`jetstream-topology-bootstrap` usa una imagen minima, crea el stream, siete durables activos y uno temporal de
drenaje legado, valida drift y sale.
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
# Provisionar primero los seis NATS_*_PASSWORD distintos en .env; crean ocho durables, uno de drenaje legado.
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

## Decision sobre Graphify

Graphify no forma parte del request path ni es autoridad arquitectonica. El piloto usa exclusivamente el
repositorio oficial fijado a `v0.9.14` y commit `94d3099540550d58dd121ec3e67cf93e80364079`, instalado de forma
aislada. No se usa una copia modificada, una rama flotante ni `latest`.

Controles del piloto:

- Salida fuera del repositorio mediante `--out <directorio-externo>`; no se compromete `graphify-out/`.
- Indexacion `--code-only --no-cluster`, seguida de clustering sobre una copia marcada como grafo dirigido y
  `--no-viz --no-label`; sin documentos, PDF, imagenes, PHI ni proveedores LLM.
- `GRAPHIFY_QUERY_LOG_DISABLE=1`; sin HTTP compartido, OAuth pendiente, hooks Git o instaladores que editen instrucciones.
- Todo hallazgo importante se confirma en la fuente. Se compara contra `rg` y lectura selectiva con preguntas oro.
- Adopcion habitual solo con al menos 25% menos tokens medianos, calidad no inferior en mas de un punto,
  cero omisiones P0/P1 y costo de indexacion amortizado en no mas de 30 consultas.

Si el piloto administrativo supera esos gates, `knowledge-service` envolvera indexacion asincrona y snapshots
inmutables por tenant/corpus/version. No expondra MCP, rutas locales ni URLs arbitrarias, y Graphify no se usara
para disponibilidad, confirmacion de citas, transcripts o historias clinicas.

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
