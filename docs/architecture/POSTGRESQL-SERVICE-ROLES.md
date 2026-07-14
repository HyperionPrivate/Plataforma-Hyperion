# Roles PostgreSQL por contexto de servicio

## Secuencia de despliegue

`migrations` se conecta primero con el administrador. El fence aditivo
`020-service-role-nologin-fence.sql` desactiva como `NOLOGIN` cualquier identidad
existente antes de validar privilegios y falla si todavía existe una sesión de
servicio; `024-service-database-roles.sql` crea las
identidades faltantes y aplica la matriz publicada, y el fence aditivo de
membresías rechaza relaciones en cualquiera de las dos direcciones. La
validación y sus checksums deben quedar confirmados antes de activar una identidad
de runtime.

Antes de ejecutar migraciones se detienen y drenan todos los runtimes con base de
datos. Después, `db-role-bootstrap` toma un lock de sesión con espera acotada y
una primera transacción confirma como `NOLOGIN` cada identidad fija que ya
exista, antes de validar presencia o drift. Por eso un rol faltante, una
membresía o una capacidad insegura no deja a las demás identidades aceptando
sesiones nuevas. Tras el fence comprueba los tres contratos, que existen los
ocho roles y que su matriz inmutable es segura. En una segunda transacción
vuelve a aplicar la allow-list de 024 y los grants mínimos de objetos
posteriores, valida que no haya sesiones antiguas y sólo entonces rota las ocho
contraseñas y activa los roles como `LOGIN`, forzando
`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION` y
`NOBYPASSRLS`. Si falla la reparación, la validación o cualquier activación, la
rotación completa se revierte y todos los roles permanecen `NOLOGIN`: no puede
quedar una rotación parcial ni sobrevivir un privilegio agregado fuera de la
matriz. Se drenan las sesiones y se corrige la causa antes de reintentar; nunca se
activa un rol manualmente para eludir el fence.

Compose codifica el orden obligatorio `migrations` → `db-role-bootstrap` →
runtimes con base de datos. Ejecutar el bootstrap antes de la migración es un
error deliberado y no una ruta alternativa de aprovisionamiento.

Cada runtime recibe una URL restringida y `EXPECTED_DATABASE_ROLE`, obligatorio al
conectar a PostgreSQL en produccion. Las diez aplicaciones se distribuyen entre ocho roles:
Identity/Tenant comparten `hyperion_access` y Agent/Prompt comparten `hyperion_sofia`; los demás
contextos usan una identidad propia. El runtime exige que `current_user` y
`session_user` coincidan, comprueba capacidades y membresias antes de registrar
rutas o arrancar workers y liga el rol a un mapa normativo `serviceName -> rol`;
una identidad incorrecta cierra el pool y aborta el arranque.

## Matriz vigente

| Rol                    | Contexto          | Propiedad DML                                                 | Deuda transicional exacta                                                                                               |
| ---------------------- | ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hyperion_access`      | Identity + Tenant | tablas Access de `platform`                                   | ninguna consulta directa a otra propiedad                                                                               |
| `hyperion_sofia`       | Agent + Prompt    | `platform.agents`, `platform.prompt_flows`, `agent_runtime.*` | lectura de `platform.products`; lectura acotada de conversaciones/mensajes/pacientes PULSO; lectura de outbound Channel |
| `hyperion_knowledge`   | Knowledge         | `platform.knowledge_sources`                                  | ninguna                                                                                                                 |
| `hyperion_audit`       | Audit             | append-only (`SELECT`/`INSERT`) en ledger e inbox             | ninguna                                                                                                                 |
| `hyperion_integration` | Integration       | `platform.integrations`                                       | lectura de agentes/prompts y configuración de agenda PULSO                                                              |
| `hyperion_pulso`       | PULSO             | tablas y funciones `pulso_iris`                               | lectura de audit                                                                                                        |
| `hyperion_channel`     | Channel           | tablas y funciones `channel_runtime`                          | ninguna; delivery PULSO vía HTTP autenticado                                                                            |
| `hyperion_lumen`       | LUMEN             | sólo tablas y funciones `lumen`                               | ninguna; sin `USAGE` en `platform` ni `pulso_iris`                                                                      |

Los servicios que todavía usan la readiness global reciben únicamente `SELECT`
sobre `platform.schema_migrations`; LUMEN valida `lumen.schema_version`. Los
accesos transicionales deben reducirse junto con
`docs/architecture/boundary-baseline.json`.

El trigger histórico que inicializa `pulso_iris.agenda_settings` al crear un
tenant sigue siendo un acoplamiento pendiente. Para no conceder PULSO a Access,
la función fija se ejecuta como su propietario de migraciones con `search_path`
confiable. Debe reemplazarse por una proyección/evento al extraer completamente
la frontera Access → PULSO.

## Defaults y `PUBLIC`

Se revocan de `PUBLIC` los permisos sobre tablas, secuencias y funciones en los
esquemas administrados. Los esquemas de propietario único tienen default
privileges para futuras tablas, secuencias y funciones. `platform` es compartido
durante la transición, por lo que todo objeto futuro allí exige un grant
explícito revisado; conceder defaults por esquema sería demasiado amplio.

Las contraseñas Compose son ocho secretos distintos. Deben tener al menos 24
caracteres y limitarse a caracteres URI no reservados; el bootstrap nunca las
incluye en logs ni errores. `MIGRATION_LOCK_TIMEOUT_MS` acota tanto el lock del
runner como el mutex del bootstrap y `MIGRATION_STATEMENT_TIMEOUT_MS` limita cada
transacción de DDL/roles.

## Verificación

Las pruebas de migraciones cubren la secuencia `NOLOGIN` → bootstrap `LOGIN`,
fence persistente ante sesiones sin drenar, rollback atómico ante un fallo
parcial, reparación de privilege drift,
membresías en ambas direcciones, atributos de rol, consultas reales con los ocho
contextos, grants posteriores a 024, ownership fail-closed y denegaciones como
LUMEN → Access/PULSO y Channel → LUMEN. La configuración renderizada de Compose
también se inspecciona para confirmar el orden y que sólo `db-role-bootstrap` y
`migrations` reciben la URL administrativa.
