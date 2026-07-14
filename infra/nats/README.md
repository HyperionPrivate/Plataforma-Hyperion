# Aislamiento JetStream por identidad de servicio

Hyperion usa una sola cuenta NATS, `HYPERION`, para que trece durables administrados compartan el stream
`HYPERION_EVENTS`: diez activos, dos temporales de compatibilidad v1 (Channel y PULSO) y uno de drenaje Audit
legado. Separar cada servicio en una cuenta exigiría imports/exports y replicaría la administración del mismo flujo;
en esta etapa la separación se hace por usuario y listas blancas de subjects.
NATS define las cuentas como namespaces independientes, mientras que los
usuarios de una cuenta pueden limitarse por permisos de publicación y
suscripción ([documentación oficial](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro)).

El overlay exige seis passwords diferentes, de 24 caracteres como mínimo, y
mantiene las credenciales fuera de `NATS_URL`. Los servicios admiten
`NATS_AUTH_TOKEN` únicamente para compatibilidad de pruebas/local; token y
usuario/password son mutuamente excluyentes.

## Responsabilidades

| Identidad  | Publica eventos                                                               | Consume durable                                            |
| ---------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `channel`  | inbound v1/v2, `channel.delivery.updated.v1`, `channel.audit.event.record.v1` | ninguno                                                    |
| `pulso`    | mensajes v1/v2, `pulso.audit.event.record.v1`, referencia LUMEN y sus DLQ     | inbound Channel v1/v2 y `pulso_channel_delivery_v1`        |
| `sofia`    | `sofia.audit.event.record.v1` y sus DLQ                                       | mensajes PULSO v1/v2                                       |
| `audit`    | sólo las DLQ de sus cinco contratos                                           | auditoría SOFÍA/LUMEN/PULSO/Channel y drenaje Audit legado |
| `lumen`    | `lumen.audit.event.record.v1` y sus DLQ                                       | tres proyecciones LUMEN                                    |
| `topology` | sólo API administrativa JetStream                                             | provisiona el stream y los trece durables                  |

Cada consumidor sólo recibe permiso para consultar su información, pedir el
siguiente mensaje, confirmar/rechazar ese mensaje, recibir respuestas en su
`_INBOX.<identidad>.>` y publicar su DLQ mínima. Los subjects administrativos CREATE/UPDATE
son exclusivos de `topology`. Los durables se crean administrativamente porque
NATS recomienda que los consumidores durables conocidos sean administrados y
que la aplicación se limite a enlazarse a ellos
([documentación oficial](https://docs.nats.io/using-nats/developer/develop_jetstream/consumers)).

`audit_event_record_v1` no acepta publicaciones nuevas desde identidades runtime: sólo drena el subject
genérico previo y persiste su procedencia como `legacy-unknown`. Se retirará después de permanecer vacío más
tiempo que la retención del stream. La cuenta reserva hasta 18 consumidores: los trece administrados y cinco
slots para un despliegue anterior durante un rolling upgrade. Ese margen no amplía subjects ni ACL.

`channel.inbound.received.v2` y `pulso.message.received.v2` agregan una posición ordenada al sobre. PULSO y SOFÍA
persisten únicamente el siguiente número contiguo; un hueco se reintenta y no adelanta el checkpoint. Los contratos
v1 no deducen la posición por orden de llegada: durante la compatibilidad, el consumidor consulta al servicio
productor mediante su endpoint propietario y una credencial HTTP específica del vínculo.

`channel.delivery.updated.v1` usa un stream independiente por mensaje. Channel confirma el estado outbound y el
evento en una sola transacción; PULSO exige la siguiente secuencia y aplica inbox+proyección atómicamente. Las
auditorías `channel.*` y `pulso.*` también salen de outboxes propietarios y Audit las deduplica por `event_id`.
Cambiar entre HTTP y JetStream sólo sustituye el transporte del mismo sobre, no su semántica.

Cada versión tiene un durable separado. `CHANNEL_INBOUND_V1_COMPATIBILITY` en PULSO y
`PULSO_MESSAGE_V1_COMPATIBILITY` en SOFÍA están deshabilitadas por defecto y sólo se habilitan durante un rollout
supervisado:

1. provisionar los trece durables y desplegar primero consumidores capaces de recibir v1 y v2;
2. habilitar temporalmente las dos banderas v1 que correspondan al tramo en transición;
3. desplegar los productores v2 y observar que los durables v1 queden drenados;
4. cerrar primero la posibilidad de rollback del productor y después deshabilitar su consumidor v1.

Un rollback se realiza en orden inverso: productor antes que consumidor. Esta ventana no declara que cualquier
binario N-1 pueda ejecutarse contra cualquier fase contractual del esquema; esa combinación debe estar cubierta por
su ensayo de upgrade/rollback antes del despliegue. Las pruebas del repositorio demuestran orden, reintentos y replay
con datos controlados, pero no convierten por sí solas el broker de un nodo en una topología de producción.

`jetstream-topology-bootstrap` es un workload one-shot. Valida todo el drift,
crea recursos ausentes y conserva únicamente la migración estrecha y en sitio
de `max_deliver=12` a `-1`. Si falla, los servicios del overlay no arrancan.
