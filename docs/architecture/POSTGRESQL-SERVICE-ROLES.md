# Roles PostgreSQL por contexto de servicio

## Secuencia de despliegue

Hay circuitos independientes de despliegue durante la convivencia. El migrador heredado conserva temporalmente las
migraciones `001–046`: el SQL histórico conoce ocho identidades, pero el bootstrap legacy ejecutable rota siete y
excluye expresamente `hyperion_audit`. Access, Audit, NOVA, LUMEN y PULSO tienen base lógica, migrador, ledger y
bootstrap de roles provider-owned; ninguno de esos circuitos forma parte de la unidad de rotación global. Los siete
roles legacy permanecen sólo para binarios y cutovers de compatibilidad, no describen las identidades de las bases
autónomas.

Access ejecuta, en este orden, tres one-shots propios:

1. `access-database-bootstrap` crea `hyperion_access`, el owner `hyperion_access_migrator` y deja
   `hyperion_identity` y `hyperion_tenant` como `NOLOGIN`;
2. `access-migrations` aplica exactamente `001-access-fresh-baseline.sql` y
   `002-access-runtime-role-boundary.sql`, con nombres y checksums estrictos en
   `access_runtime.migration_ledger`; y
3. `access-role-bootstrap` cerca primero ambas identidades, exige el ledger exacto, ownership y ACL esperados,
   rota dos contraseñas distintas y sólo entonces habilita `LOGIN`.

Identity y Tenant validan el ledger Access local; no adoptan una base global ni reciben autoridad de migración.

Audit ejecuta, en este orden, tres one-shots propios:

1. `audit-database-bootstrap` crea `hyperion_audit`, el owner `hyperion_audit_migrator` y deja
   `hyperion_audit` como `NOLOGIN`;
2. `audit-migrations` aplica únicamente `001-audit-autonomous-baseline.sql`, crea
   `platform.audit_events`, `audit_runtime.inbox_events` y registra su checksum en
   `audit_runtime.migration_ledger`; y
3. `audit-role-bootstrap` exige el ledger terminal, cero sesiones antiguas y ACL append-only antes de rotar y
   activar `hyperion_audit`.

El baseline acepta los contratos de SOFÍA, LUMEN, PULSO, Channel y NOVA; el par
`nova-core-service` × `nova.audit.event.record.v1` forma parte de una restricción validada. Los UUID de tenant son
referencias externas sin FK a Access. Una base con objetos Audit pero sin ledger provider-owned se rechaza en vez
de adoptarse implícitamente.

La célula NOVA ejecuta, en este orden, tres one-shots propios:

1. `nova-database-bootstrap` crea la base lógica `hyperion_nova`, el owner `hyperion_nova_migrator` y los cuatro
   roles runtime en estado `NOLOGIN`;
2. `nova-migrations` se conecta como `hyperion_nova_migrator`, aplica `047–053` y registra checksums en
   `nova.migration_ledger`; si `047–052` ya existen en los ledgers históricos de proveedor, los adopta sin volver
   a ejecutar DDL; y
3. `nova-role-bootstrap` verifica privilegios, ownership y membresías, rota cuatro credenciales distintas y activa
   sólo `hyperion_nova`, `hyperion_voice`, `hyperion_liwa` y `hyperion_documents`.

Ningún paso NOVA recibe contraseñas, migraciones ni variables de LUMEN o PULSO. El administrador del clúster sólo
se usa en `nova-database-bootstrap` y `nova-role-bootstrap`; los runtimes y el runner nunca lo reciben.

La célula PULSO ejecuta, en este orden, tres one-shots propios:

1. `pulso-database-bootstrap` crea la base lógica `hyperion_pulso`, el owner `hyperion_pulso_migrator` y cinco
   roles runtime en estado `NOLOGIN`;
2. `pulso-migrations` se conecta como `hyperion_pulso_migrator`, acepta únicamente una clausura fresh, legacy o
   managed cuyo catálogo estructural coincida, crea o adopta `001-pulso-autonomous-baseline.sql`, aplica
   `002-pulso-runtime-roles.sql`, `003-sofia-readiness-marker.sql` y
   `004-access-channel-tenant-projection.sql`, y registra los cuatro checksums en
   `pulso_iris.migration_ledger`; y
3. `pulso-role-bootstrap` verifica versión, catálogo, ownership, privilegios y membresías, rota cinco credenciales
   distintas y activa sólo `hyperion_pulso`, `hyperion_sofia`, `hyperion_knowledge`, `hyperion_integration` y
   `hyperion_channel`.

El administrador del clúster sólo llega al primer y tercer one-shot. El runner recibe únicamente
`PULSO_MIGRATOR_DATABASE_URL`; ningún paso PULSO recibe contraseñas, migraciones ni variables de NOVA o LUMEN.
LUMEN aplica el mismo patrón con sus propios nombres y base lógica, documentados en su runbook standalone.

Antes de ejecutar una migración se detienen y drenan los runtimes de la célula afectada. En la unidad heredada,
`db-role-bootstrap` toma un lock de sesión con espera acotada y
una primera transacción confirma como `NOLOGIN` cada identidad fija que ya
exista, antes de validar presencia o drift. Por eso un rol faltante, una
membresía o una capacidad insegura no deja a las demás identidades aceptando
sesiones nuevas. Tras el fence comprueba los tres contratos, que existen los
siete roles y que su matriz efectiva es segura. En una segunda transacción
vuelve a aplicar la allow-list heredada y los grants mínimos de objetos
posteriores, valida que no haya sesiones antiguas y sólo entonces rota las siete
contraseñas y activa los roles como `LOGIN`, forzando
`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION` y
`NOBYPASSRLS`. Si falla la reparación, la validación o cualquier activación, la
rotación completa se revierte y todos los roles permanecen `NOLOGIN`: no puede
quedar una rotación parcial ni sobrevivir un privilegio agregado fuera de la
matriz. Se drenan las sesiones y se corrige la causa antes de reintentar; nunca se
activa un rol manualmente para eludir el fence.

Compose codifica por separado `migrations` → `db-role-bootstrap` para la unidad heredada, tres one-shots Access,
tres Audit, tres NOVA, tres LUMEN y `pulso-database-bootstrap` → `pulso-migrations` → `pulso-role-bootstrap` para
PULSO. Ejecutar el
bootstrap de credenciales antes de la migración es un error deliberado y no una ruta alternativa de
aprovisionamiento. `db-role-bootstrap` recibe exclusivamente las siete contraseñas legacy; las contraseñas de
cada célula se entregan sólo a su bootstrap provider-owned.

Cada runtime recibe una URL restringida y una identidad esperada, obligatoria al
conectar a PostgreSQL en producción. Los binarios legacy se distribuyen entre siete roles; en el circuito actual
Identity usa `hyperion_identity`, Tenant usa `hyperion_tenant` y Agent/Prompt comparten `hyperion_sofia`. NOVA usa cuatro roles y
PULSO cinco roles para seis runtimes en sus bases lógicas respectivas. Todas las familias de runtime exigen que `current_user` y
`session_user` coincidan, comprueban capacidades y membresías antes de registrar
rutas o arrancar workers y liga el rol a un mapa normativo `serviceName -> rol`;
una identidad incorrecta cierra el pool y aborta el arranque.

## Matriz vigente

| Rol                    | Contexto       | Propiedad DML                                                   | Deuda transicional exacta                                                                                 |
| ---------------------- | -------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `hyperion_access`      | Access legacy  | tablas Access del stack global                                  | sin consumidor current; se retira con el bootstrap global                                                 |
| `hyperion_identity`    | Identity       | operadores y sesiones Access en `hyperion_access`               | ninguna consulta directa a otra propiedad                                                                 |
| `hyperion_tenant`      | Tenant         | tenants, grants y aprovisionamiento Access en `hyperion_access` | ninguna consulta directa a otra propiedad                                                                 |
| `hyperion_sofia`       | Agent + Prompt | `platform.agents`, `platform.prompt_flows`, `agent_runtime.*`   | el runtime current usa el marker local; conserva `SELECT` del marker PULSO sólo para N−1 hasta el cutover |
| `hyperion_knowledge`   | Knowledge      | `platform.knowledge_sources`                                    | ninguna                                                                                                   |
| `hyperion_audit`       | Audit          | append-only (`SELECT`/`INSERT`) en ledger e inbox               | ninguna                                                                                                   |
| `hyperion_integration` | Integration    | `platform.integrations`                                         | el provider-owned no concede SQL de readiness; quedan grants sólo en el stack global pendiente de cutover |
| `hyperion_pulso`       | PULSO          | tablas y funciones `pulso_iris`                                 | el provider-owned no concede Audit; el grant histórico subsiste sólo en el stack global                   |
| `hyperion_channel`     | Channel        | tablas y funciones `channel_runtime`                            | ninguna; delivery PULSO mediante outbox/evento autenticado                                                |
| `hyperion_lumen`       | LUMEN          | sólo tablas y funciones `lumen`                                 | ninguna; sin `USAGE` en `platform` ni `pulso_iris`                                                        |
| `hyperion_nova`        | NOVA core      | tablas de `nova` en `hyperion_nova`                             | mismo clúster físico; base, migrador, ledger, backup y restore independientes                             |
| `hyperion_voice`       | NOVA Voice     | tablas de `voice` en `hyperion_nova`                            | Neutral Dialer permanece externo                                                                          |
| `hyperion_liwa`        | NOVA LIWA      | tablas de `liwa` en `hyperion_nova`                             | proveedor LIWA permanece externo                                                                          |
| `hyperion_documents`   | NOVA Documents | tablas de `documents` en `hyperion_nova`                        | el object storage se respalda por separado; MinIO local no acredita el transporte productivo              |

Audit y Access validan sus ledgers provider-owned en `audit_runtime` y `access_runtime`; LUMEN valida
`lumen.schema_version`; y los cuatro componentes NOVA consultan
`nova.schema_version`, `voice.schema_version`, `liwa.schema_version` o `documents.schema_version`. En PULSO, Agent
y Prompt Flow validan la fila `sofia` de `agent_runtime.schema_version`; Core, Knowledge, Integration y Channel
validan la fila `pulso` de `pulso_iris.schema_version`. Tip `015` revoca la lectura del marcador global para
`hyperion_sofia`; DEBT-027 residual cubre la lectura de bootstrap en `roles.ts` del marker owner-owned. Ninguno
usa el catálogo cerrado `requiredMigrations` ni `platform.schema_migrations` como readiness actual.

Integration obtiene la readiness de agenda por el contrato propietario HTTP de PULSO y la readiness de prompt y
worker por la API owner-owned de SOFÍA. Su readiness de dominio no ejecuta SQL contra `agenda_settings`,
`availability_rules`, `professionals`, `agents`, `prompt_flows` ni el ledger global. SOFÍA tampoco ata su readiness
a una migración histórica ni consulta por SQL `administrative_patients`, `conversations` o `messages`: el runtime
current usa rutas internas autenticadas del propietario PULSO.

La matriz provider-owned revoca y verifica los grants de dominio cruzado, incluido el contract tip `015` que
retira `USAGE`/`SELECT` de `hyperion_sofia` sobre `pulso_iris`. La matriz global congelada conserva grants
históricos hasta cutover. Esa distinción está registrada en
[`pulso-integration-readiness-policy.v1.json`](pulso-integration-readiness-policy.v1.json): demuestra el límite del
artefacto nuevo, no un despliegue ni una migración ya ejecutados sobre el ambiente objetivo.

Channel no recibe permisos sobre `pulso_iris`: persiste cada cambio de delivery y
`channel.delivery.updated.v1` en su propia transacción, y PULSO aplica la proyección con su rol y un inbox
idempotente. El `POST` directo de delivery permanece autenticado sólo para compatibilidad N-1 y no autoriza SQL
cruzado al runtime Channel. De forma análoga, PULSO y Channel escriben sus auditorías en outboxes propios; sólo
`hyperion_audit` agrega el ledger y su inbox.

El rehearsal del SHA pre-autonomía es la única excepción: su Channel todavía valida y actualiza
`pulso_iris.messages` por SQL. Antes de arrancar ese binario, CI abre una allow-list temporal por columna para
`hyperion_channel`; después de detener y cercar Channel la revoca y atestigua que no quede `USAGE`, lectura,
escritura, ownership, membresía, secuencia ni rutina. Esta ventana no pertenece a la matriz durable.

La matriz durable tampoco concede escrituras PULSO a `hyperion_sofia`. El rehearsal del SHA histórico que aún
escribía SQL abre antes de iniciar workloads una allow-list temporal por columna en `conversations` y `messages`;
después detiene Agent y Prompt Flow, reconstruye este baseline de lectura y atestigua que no quede escritura,
propiedad, membresía, secuencia ni rutina cruzada. Ese procedimiento de rollback está detallado en
[`../PRODUCTION.md`](../PRODUCTION.md) y no forma parte de los grants permanentes.

El trigger histórico que inicializaba `pulso_iris.agenda_settings` al crear un tenant fue retirado por
`005-remove-pulso-agenda-trigger.sql`. Access ya no ejecuta callbacks ni SQL PULSO; el propietario materializa de
forma idempotente sus defaults en el primer uso autorizado mediante `ensureAgendaSettingsExist`.

## Defaults y `PUBLIC`

Se revocan de `PUBLIC` los permisos sobre tablas, secuencias y funciones en los
esquemas administrados. Los esquemas de propietario único tienen default
privileges para futuras tablas, secuencias y funciones. `platform` es compartido
durante la transición, por lo que todo objeto futuro allí exige un grant
explícito revisado; conceder defaults por esquema sería demasiado amplio.

Las siete contraseñas de la unidad legacy siguen siendo distintas. Access añade dos credenciales runtime y una de
migrador; Audit añade una de runtime y una de migrador; NOVA añade cuatro credenciales runtime y una de migrador;
LUMEN añade una y una; PULSO añade cinco credenciales runtime y una de migrador. Todas deben ser
distintas y tener al menos 24
caracteres y limitarse a caracteres URI no reservados; ningún bootstrap las
incluye en logs ni errores. `MIGRATION_LOCK_TIMEOUT_MS` acota tanto el lock del
runner como el mutex del bootstrap y `MIGRATION_STATEMENT_TIMEOUT_MS` limita cada
transacción de DDL/roles.

## Verificación

Las pruebas cubren por separado la secuencia heredada `NOLOGIN` → bootstrap `LOGIN` y las secuencias provider-owned
de Access, Audit, NOVA, LUMEN y PULSO: base lógica → migración/adopción → bootstrap de roles,
fence persistente ante sesiones sin drenar, rollback atómico ante un fallo
parcial, reparación de privilege drift,
membresías en ambas direcciones, atributos de rol, grants posteriores a 024, ownership fail-closed y denegaciones como
LUMEN → Access/PULSO y Channel → LUMEN. La configuración renderizada de cada Compose se inspecciona para confirmar
los órdenes y que sólo los one-shots de base/roles reciban sus respectivas URLs administrativas.
`access-migrations`, `audit-migrations`, `nova-migrations`, `lumen-migrations` y `pulso-migrations` reciben únicamente la URL de su
owner; los tests de
`@hyperion/pulso-migrations` verifican además catálogo estructural, drift de ACL, ledgers, timeouts y las
denegaciones entre roles PULSO.
