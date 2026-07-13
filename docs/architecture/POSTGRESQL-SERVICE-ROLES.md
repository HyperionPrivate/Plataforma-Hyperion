# Roles PostgreSQL por contexto de servicio

## Secuencia de despliegue

`db-role-bootstrap` se conecta con el administrador de migraciones, crea o rota
los ocho roles `LOGIN` y les fuerza `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOINHERIT`, `NOREPLICATION` y `NOBYPASSRLS`. No concede permisos. Después,
`migrations` usa la misma conexión administrativa y `024-service-database-roles.sql`
aplica la matriz de privilegios.

La migración también es segura fuera de Compose: si el bootstrap no se ejecutó,
crea las identidades faltantes como `NOLOGIN` y aplica igualmente los grants. De
ese modo nunca registra un checksum como falso no-op. Un bootstrap posterior
puede activarlas sin cambiar la matriz. La migración falla si un rol tiene
capacidades administrativas, membresías o es propietario de objetos.

Cada runtime recibe una URL distinta y `EXPECTED_DATABASE_ROLE`, obligatorio al
conectar a PostgreSQL en produccion. El runtime exige que `current_user` y
`session_user` coincidan, comprueba capacidades y membresias antes de registrar
rutas o arrancar workers y liga el rol a un mapa normativo `serviceName -> rol`;
una identidad incorrecta cierra el pool y aborta el arranque.

## Matriz vigente

| Rol                    | Contexto          | Propiedad DML                                                 | Deuda transicional exacta                                                                                               |
| ---------------------- | ----------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hyperion_access`      | Identity + Tenant | tablas Access de `platform`                                   | ninguna consulta directa a otra propiedad                                                                               |
| `hyperion_sofia`       | Agent + Prompt    | `platform.agents`, `platform.prompt_flows`, `agent_runtime.*` | lectura de `platform.products`; lectura/escritura acotada de conversaciones/mensajes PULSO; lectura de outbound Channel |
| `hyperion_knowledge`   | Knowledge         | `platform.knowledge_sources`                                  | ninguna                                                                                                                 |
| `hyperion_audit`       | Audit             | append-only (`SELECT`/`INSERT`) en ledger e inbox             | ninguna                                                                                                                 |
| `hyperion_integration` | Integration       | `platform.integrations`                                       | lectura de agentes/prompts y configuración de agenda PULSO                                                              |
| `hyperion_pulso`       | PULSO             | tablas y funciones `pulso_iris`                               | lectura de audit; lectura/actualización acotada de bindings e inbound Channel                                           |
| `hyperion_channel`     | Channel           | tablas y funciones `channel_runtime`                          | lectura/actualización de `pulso_iris.messages`                                                                          |
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
incluye en logs ni errores.

## Verificación

Las pruebas de migraciones cubren la secuencia `NOLOGIN` → bootstrap `LOGIN`,
atributos de rol, consultas reales con los ocho contextos, escrituras con
triggers, ownership fail-closed y denegaciones como LUMEN → Access/PULSO y
Channel → LUMEN. La configuración renderizada de Compose también se inspecciona
para confirmar que sólo `db-role-bootstrap` y `migrations` reciben la URL
administrativa.
