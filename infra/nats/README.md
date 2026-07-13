# Aislamiento JetStream por identidad de servicio

Hyperion usa una sola cuenta NATS, `HYPERION`, para que siete consumidores activos y un consumidor temporal de
drenaje compartan el stream `HYPERION_EVENTS`. Separar cada servicio en una
cuenta exigiría imports/exports y replicaría la administración del mismo flujo;
en esta etapa la separación se hace por usuario y listas blancas de subjects.
NATS define las cuentas como namespaces independientes, mientras que los
usuarios de una cuenta pueden limitarse por permisos de publicación y
suscripción ([documentación oficial](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/auth_intro)).

El overlay exige seis passwords diferentes, de 24 caracteres como mínimo, y
mantiene las credenciales fuera de `NATS_URL`. Los servicios admiten
`NATS_AUTH_TOKEN` únicamente para compatibilidad de pruebas/local; token y
usuario/password son mutuamente excluyentes.

## Responsabilidades

| Identidad  | Publica eventos                               | Consume durable                          |
| ---------- | --------------------------------------------- | ---------------------------------------- |
| `channel`  | `channel.inbound.received.v1`                 | ninguno                                  |
| `pulso`    | `pulso.message.received.v1`, referencia LUMEN | `pulso_channel_inbound_v1`               |
| `sofia`    | `sofia.audit.event.record.v1`                 | `sofia_pulso_message_v1`                 |
| `audit`    | sólo sus DLQ                                  | SOFIA/LUMEN y drenaje Audit legado       |
| `lumen`    | `lumen.audit.event.record.v1`                 | tres proyecciones LUMEN                  |
| `topology` | sólo API administrativa JetStream             | provisiona el stream y los ocho durables |

Cada consumidor sólo recibe permiso para consultar su información, pedir el
siguiente mensaje, confirmar/rechazar ese mensaje, recibir respuestas en su
`_INBOX.<identidad>.>` y publicar su DLQ mínima. Los subjects administrativos CREATE/UPDATE
son exclusivos de `topology`. Los durables se crean administrativamente porque
NATS recomienda que los consumidores durables conocidos sean administrados y
que la aplicación se limite a enlazarse a ellos
([documentación oficial](https://docs.nats.io/using-nats/developer/develop_jetstream/consumers)).

`audit_event_record_v1` no acepta publicaciones nuevas desde identidades runtime: sólo drena el subject
genérico previo y persiste su procedencia como `legacy-unknown`. Se retirará después de permanecer vacío más
tiempo que la retención del stream. La cuenta reserva hasta 16 consumidores para que durables de un despliegue
anterior no bloqueen una actualización antes de poder diagnosticarlos; ese margen no amplía subjects ni ACL.

`jetstream-topology-bootstrap` es un workload one-shot. Valida todo el drift,
crea recursos ausentes y conserva únicamente la migración estrecha y en sitio
de `max_deliver=12` a `-1`. Si falla, los servicios del overlay no arrancan.
