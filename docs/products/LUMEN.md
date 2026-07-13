# LUMEN — Especificación técnica del producto

> Estado del documento: vigente para el corte demostrativo.
>
> Madurez del producto: en construcción. El backend clínico descrito aquí solo
> está autorizado con datos sintéticos.
>
> Decisión relacionada:
> [ADR-0002 — Retención de audio clínico](../architecture/decisions/ADR-0002-lumen-audio-retention.md).

## 1. Propósito

LUMEN es el producto de Hyperion que asiste el flujo de una consulta clínica:
prepara un resumen previo, recibe un dictado, produce un borrador estructurado y
permite que una persona autorizada lo revise y apruebe.

Esta especificación describe el estado comprobable del repositorio. No constituye
una autorización para usar datos clínicos reales, no certifica cumplimiento
regulatorio y no convierte una superficie demostrativa en una capacidad
productiva.

Los términos **DEBE**, **NO DEBE** y **REQUIERE** expresan requisitos normativos.

## 2. Clasificación del estado

LUMEN usa los mismos estados controlados de la matriz de producto. El calificativo
“backend funcional” describe evidencia técnica dentro de un estado, pero no es un
estado adicional ni autoriza datos clínicos reales.

| Estado                   | Significado                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `implementado`           | Existe contrato, persistencia, ruta y prueba automatizada dentro del alcance autorizado.                                                        |
| `parcial`                | Existe una parte funcional, pero falta una condición esencial del requisito.                                                                    |
| `demo sintética`         | La interfaz o el flujo solo están autorizados con datos sintéticos; puede existir backend funcional, lo cual debe indicarse de forma explícita. |
| `pendiente`              | No existe una implementación completa y verificable en el producto.                                                                             |
| `bloqueado por decisión` | La capacidad no puede activarse hasta que una decisión aprobada cierre sus condiciones clínicas, de seguridad, cumplimiento u operación.        |

Una pantalla navegable no es, por sí sola, evidencia de backend funcional. El
estado `demo sintética` tampoco equivale a una autorización de producción.

## 3. Límite del producto

- **LUM-001 — Propiedad del dominio.** `lumen-service` DEBE ser el propietario de
  encuentros clínicos, resúmenes de preconsulta, dictados, borradores
  estructurados e intentos de procesamiento de LUMEN.
- **LUM-002 — Propiedad de datos.** El runtime DEBE leer y escribir únicamente el
  esquema `lumen`. No DEBE consultar directamente tablas privadas de Access,
  PULSO IRIS ni Audit.
- **LUM-003 — Integración desacoplada.** Los cambios provenientes de otros
  contextos DEBEN llegar mediante contratos HTTP internos o eventos versionados.
  Las referencias externas se conservan como identificadores opacos y
  proyecciones locales.
- **LUM-004 — Despliegue independiente.** Una degradación de LUMEN no DEBE impedir
  el arranque del gateway ni de los demás productos. LUMEN mantiene imagen,
  readiness, rol de base de datos y ciclo de despliegue propios.
- **LUM-005 — Base de datos transicional.** El uso actual de un clúster PostgreSQL
  compartido no autoriza acceso cruzado. Los privilegios, el historial de esquema
  y las barreras de CI DEBEN preservar el límite lógico del servicio.
- **LUM-006 — Datos permitidos.** Hasta que se satisfagan los bloqueos de la
  sección 12, LUMEN solo DEBE operar con tenants, personas, profesionales y
  encuentros marcados explícitamente como sintéticos.

La frontera vigente está descrita en
[microservicios autónomos](../architecture/AUTONOMOUS-MICROSERVICES.md), la
[matriz de propiedad](../architecture/data-ownership.json) y los
[roles PostgreSQL](../architecture/POSTGRESQL-SERVICE-ROLES.md).

## 4. Actores

- **LUM-010 — Operador con acceso.** Puede consultar únicamente el tenant y las
  sedes autorizadas por sus proyecciones locales.
- **LUM-011 — Revisor clínico.** Es un operador con concesión activa de revisión.
  Puede iniciar, corregir y aprobar un registro; la aplicación no presume esta
  capacidad por el nombre de un rol genérico.
- **LUM-012 — Sistema de origen.** Publica referencias administrativas de
  encuentros. No transfiere la propiedad de sus datos a LUMEN.
- **LUM-013 — Servicio de auditoría.** Recibe eventos durables de LUMEN sin
  acceder a sus tablas de dominio.
- **LUM-014 — Persona demostradora.** Interactúa con las superficies marcadas como
  demo. Sus acciones no deben presentarse como efectos clínicos, legales o
  financieros reales.

## 5. Seguridad clínica y revisión humana

- **LUM-020 — Asistencia, no decisión.** Toda salida estructurada es una propuesta.
  LUMEN NO DEBE diagnosticar, firmar, aprobar ni ejecutar una conducta clínica de
  forma autónoma.
- **LUM-021 — Borrador por defecto.** La estructuración DEBE producir un registro
  en estado `draft`.
- **LUM-022 — Aprobación explícita.** Solo una acción humana autenticada y con
  concesión de revisión activa puede cambiar un registro a `approved`.
- **LUM-023 — Confianza visible.** La evidencia por campo DEBE conservar origen,
  texto fuente y confianza. Una confianza inferior a `0.85` DEBE generar una
  incertidumbre que bloquee la aprobación hasta su revisión.
- **LUM-024 — Completitud mínima.** La aprobación DEBE fallar si falta cualquiera
  de los campos clínicos obligatorios definidos por el contrato vigente.
- **LUM-025 — Inmutabilidad.** Un encuentro o registro aprobado NO DEBE modificarse
  ni eliminarse por las rutas ordinarias.
- **LUM-026 — Linaje.** Un registro estructurado DEBE conservar la identidad del
  dictado y del intento de procesamiento que lo originaron. La evidencia no puede
  provenir de otro encuentro o tenant.
- **LUM-027 — Revisión del texto.** Cuando una persona corrige una transcripción,
  el texto recibido y el texto revisado DEBEN permanecer diferenciados y
  trazables.
- **LUM-028 — Fallo cerrado.** Si falta configuración, autorización, esquema o
  evidencia requerida, la operación DEBE rechazarse; no debe sustituirse por una
  respuesta simulada silenciosa.
- **LUM-029 — Auditoría durable.** Inicio, transcripción, estructuración,
  corrección, aprobación y fallos relevantes DEBEN producir evidencia de
  auditoría sin incluir audio ni contenido sensible innecesario.

Los contratos de contenido, incertidumbres y bloqueos están en
[packages/contracts](../../packages/contracts/src/index.ts). Las invariantes
persistentes están en la
[migración clínica](../../packages/migrations/sql/019-lumen-clinical-invariants.sql).

## 6. Capacidades HTTP funcionales

Todas las rutas de dominio son versionadas y acotadas por `tenantId`.

- **LUM-040 — Estado del servicio.** LUMEN expone salud, readiness y catálogo sin
  revelar secretos.
- **LUM-041 — Lista de trabajo.** `GET /v1/tenants/:tenantId/lumen/worklist`
  devuelve únicamente encuentros visibles en las proyecciones locales.
- **LUM-042 — Detalle del encuentro.**
  `GET /v1/tenants/:tenantId/lumen/encounters/:encounterId` devuelve encuentro,
  preconsulta, dictados y registro clínico del mismo tenant.
- **LUM-043 — Inicio de consulta.**
  `POST /v1/tenants/:tenantId/lumen/encounters/:encounterId/start` realiza la
  transición idempotente permitida desde preconsulta.
- **LUM-044 — Transcripción.**
  `POST /v1/tenants/:tenantId/lumen/encounters/:encounterId/transcriptions`
  valida el audio, reserva un intento idempotente, transcribe y persiste el
  resultado textual y su trazabilidad.
- **LUM-045 — Estructuración.**
  `POST /v1/tenants/:tenantId/lumen/encounters/:encounterId/structure` convierte
  una transcripción válida en un borrador clínico estructurado.
- **LUM-046 — Corrección.**
  `PATCH /v1/tenants/:tenantId/lumen/encounters/:encounterId/record` permite
  guardar correcciones humanas mientras el encuentro sea mutable.
- **LUM-047 — Aprobación.**
  `POST /v1/tenants/:tenantId/lumen/encounters/:encounterId/approve` verifica
  autorización, completitud, incertidumbres y linaje antes de aprobar.
- **LUM-048 — Proyecciones internas.** El endpoint interno de proyecciones DEBE
  validar tipo, versión, tenant, hash e idempotencia antes de actualizar tablas
  locales.

La implementación de estas rutas se encuentra en
[routes.ts](../../services/lumen-service/src/routes.ts) y
[projection-events.ts](../../services/lumen-service/src/projection-events.ts).

## 7. Audio y transcripción

- **LUM-060 — Orígenes permitidos.** La entrada solo acepta captura de micrófono
  en navegador o carga explícitamente autorizada.
- **LUM-061 — Límites de entrada.** El contrato limita MIME, tamaño decodificado a
  5 MiB y duración a un intervalo de 1 a 90 segundos. La duración declarada DEBE
  contrastarse con el contenido recibido.
- **LUM-062 — Transporte seguro.** La consola NO DEBE solicitar ni enviar audio
  desde un origen de navegador inseguro, salvo el origen loopback controlado para
  pruebas locales.
- **LUM-063 — Retención temporal vigente.** El audio solo puede existir durante
  una solicitud, en un directorio privado y no ejecutable. DEBE eliminarse tanto
  en éxito como en error. No se persiste en PostgreSQL ni en almacenamiento de
  objetos.
- **LUM-064 — Evidencia conservada.** Se conservan el transcript, su revisión
  humana, el hash de entrada, metadatos técnicos mínimos, estados, timestamps,
  resultado e idempotencia. Un hash no permite reconstruir el audio.
- **LUM-065 — Cambio controlado.** Cualquier retención del audio posterior a la
  solicitud REQUIERE reemplazar
  [ADR-0002](../architecture/decisions/ADR-0002-lumen-audio-retention.md) y cumplir
  los bloqueos de activación clínica.

## 8. Datos y contratos

- **LUM-080 — Encuentro.** Estados permitidos: `preconsultation`, `in_progress`,
  `review` y `approved`.
- **LUM-081 — Dictado.** Conserva estado, transcript, origen autorizado,
  trazabilidad de revisión y vínculo con su encuentro.
- **LUM-082 — Registro clínico.** Conserva versión de esquema, contenido
  estructurado, estado, aprobador y timestamps. Solo existe un registro vigente
  por encuentro en el corte actual.
- **LUM-083 — Resumen de preconsulta.** Conserva texto, diagnósticos activos,
  medicación, alertas, tendencias, exámenes, línea de tiempo y fuentes
  identificables.
- **LUM-084 — Intento de procesamiento.** Conserva operación, clave de
  idempotencia, hash de entrada, estado terminal, snapshot de resultado y
  confirmación de eliminación del temporal; nunca contiene audio.
- **LUM-085 — Proyecciones.** LUMEN mantiene snapshots locales de tenant,
  concesiones de operador y referencias de encuentro con versión monótona y hash
  canónico.
- **LUM-086 — Inbox y outbox.** Los eventos recibidos y emitidos DEBEN ser
  idempotentes, versionados y recuperables. La publicación de auditoría no forma
  parte de la transacción remota.
- **LUM-087 — Historial de esquema.** El servicio valida su propia versión de
  esquema y no depende del historial global para quedar listo.

La forma normativa está en
[los contratos compartidos](../../packages/contracts/src/index.ts); la
persistencia inicial y la autonomía están en
[018-lumen-clinical-demo.sql](../../packages/migrations/sql/018-lumen-clinical-demo.sql),
[020-lumen-real-audio-pipeline.sql](../../packages/migrations/sql/020-lumen-real-audio-pipeline.sql)
y
[022-lumen-autonomy.sql](../../packages/migrations/sql/022-lumen-autonomy.sql).

## 9. Consola funcional

- **LUM-100 — Flujo clínico principal.** La consola web consume el backend de
  preconsulta, captura controlada, transcripción, estructuración, corrección y
  aprobación sobre el encuentro sintético autorizado.
- **LUM-101 — Presentación adaptable.** El flujo principal DEBE conservar
  navegación y acciones utilizables en escritorio y viewport móvil. Esta
  adaptación web no implica una aplicación móvil nativa ni operación offline.

## 10. Superficies demostrativas

- **LUM-120 — Laboratorios demo.** Representa captura, bandeja y revisión con
  archivos locales. No ejecuta extracción ni escribe en una historia clínica.
- **LUM-121 — Asistente demo.** Responde desde reglas y fuentes sintéticas
  locales. No consulta un expediente real ni envía acciones a otros productos.
- **LUM-122 — Modelos demo.** Permite manipular un modelo en memoria. No persiste,
  versiona ni publica reglas clínicas.
- **LUM-123 — Consentimiento demo.** Permite dibujar y sellar una firma de prueba.
  No produce un documento con validez legal.
- **LUM-124 — Facturación demo.** Representa estados y preparación de lotes. No
  emite, valida, radica ni contacta sistemas externos.
- **LUM-125 — Dashboard demo.** Presenta métricas prefabricadas y no consulta una
  fuente analítica productiva.

## 11. Estado real de las capacidades

| IDs             | Capacidad                                                                                                | Estado vigente                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| LUM-040–LUM-048 | Salud, worklist, encuentro, inicio, transcripción, estructuración, corrección, aprobación y proyecciones | `demo sintética`: backend funcional limitado a datos sintéticos    |
| LUM-020–LUM-029 | Revisión humana, confianza, bloqueos, linaje, inmutabilidad y auditoría                                  | `demo sintética`: salvaguardas funcionales en el corte sintético   |
| LUM-060–LUM-065 | Captura controlada, validación, temporal y eliminación de audio                                          | `demo sintética`: backend funcional para prueba sintética          |
| LUM-080–LUM-087 | Esquema privado, contratos, intentos, inbox, outbox y versión local                                      | `parcial`: faltan productores, backfill y recuperación completa    |
| LUM-100         | Preconsulta, dictado y revisión en consola web                                                           | `demo sintética`: funcional sobre el backend sintético             |
| LUM-101         | Navegación y presentación adaptable a escritorio y móvil                                                 | `demo sintética`: web adaptable; no es una aplicación móvil nativa |
| LUM-120         | Bandeja y captura visual de laboratorios                                                                 | `demo sintética`: estado local, sin OCR ni persistencia clínica    |
| LUM-121         | Asistente conversacional                                                                                 | `demo sintética`: respuestas locales, sin consulta clínica real    |
| LUM-122         | Editor de modelos de historia clínica                                                                    | `demo sintética`: cambios locales, sin publicación persistente     |
| LUM-123         | Consentimiento y firma en pantalla                                                                       | `demo sintética`: no genera un consentimiento legal                |
| LUM-124         | Facturación y RIPS                                                                                       | `demo sintética`: no emite, valida ni radica                       |
| LUM-125         | Dashboard gerencial                                                                                      | `demo sintética`: métricas prefabricadas                           |
| LUM-140         | Activación con información clínica real                                                                  | `bloqueado por decisión`                                           |
| LUM-141–LUM-147 | Módulos de negocio completos, operación desconectada e integraciones públicas                            | `pendiente`                                                        |

Las superficies de demostración están identificadas en sus propios componentes:
[laboratorios](../../apps/web-console/src/components/lumen/demo/LumenLaboratoriesView.tsx),
[asistente](../../apps/web-console/src/components/lumen/demo/LumenAssistantView.tsx),
[modelos](../../apps/web-console/src/components/lumen/demo/LumenModelsView.tsx),
[consentimientos](../../apps/web-console/src/components/lumen/demo/LumenConsentView.tsx),
[facturación](../../apps/web-console/src/components/lumen/demo/LumenBillingView.tsx)
y
[dashboard](../../apps/web-console/src/components/lumen/demo/LumenDashboardView.tsx).

## 12. Capacidades pendientes

- **LUM-140 — Datos clínicos reales.** Bloqueado hasta completar gobierno de datos,
  evaluación de seguridad, política de retención y autorización formal del
  ambiente.
- **LUM-141 — Laboratorios.** Pendientes la ingesta durable, extracción,
  validación humana, deduplicación y vinculación clínica.
- **LUM-142 — Asistente.** Pendientes recuperación trazable, aislamiento estricto
  del contexto, evaluación clínica y ejecución controlada de acciones.
- **LUM-143 — Modelos clínicos.** Pendientes persistencia, versionado, doble
  aprobación, migración de borradores y publicación.
- **LUM-144 — Consentimientos.** Pendientes plantillas gobernadas, identidad,
  evidencia probatoria, revocación y conservación.
- **LUM-145 — Facturación y RIPS.** Pendientes generación, validación, emisión,
  radicación, estados y conciliación reales.
- **LUM-146 — Operación desconectada.** Pendientes captura cifrada offline,
  sincronización, resolución de conflictos y purga verificable en dispositivo.
- **LUM-147 — Integraciones públicas.** Pendientes API pública, autorización por
  scopes, límites de consumo, webhooks firmados, consola y sandbox aislado.

## 13. Criterios de aceptación del corte vigente

- **LUM-200.** Un tenant no puede leer ni modificar encuentros de otro tenant.
- **LUM-201.** Un encuentro no sintético es rechazado por las invariantes de base
  de datos.
- **LUM-202.** Una entrada de audio fuera de MIME, tamaño o duración permitidos se
  rechaza antes del procesamiento.
- **LUM-203.** Cada archivo temporal de audio se elimina en éxito, error,
  cancelación y aborto de la solicitud.
- **LUM-204.** Repetir una operación con la misma clave y la misma entrada devuelve
  el resultado idempotente; reutilizar la clave con otra entrada produce
  conflicto.
- **LUM-205.** La estructuración nunca aprueba automáticamente un registro.
- **LUM-206.** Una incertidumbre o confianza inferior al umbral bloquea la
  aprobación.
- **LUM-207.** La ausencia de un campo obligatorio bloquea la aprobación.
- **LUM-208.** Un registro aprobado no puede editarse ni eliminarse por rutas
  ordinarias.
- **LUM-209.** La evidencia de un dictado o intento ajeno al encuentro es
  rechazada.
- **LUM-210.** Los eventos de proyección duplicados no repiten efectos y una
  versión anterior no reemplaza una posterior.
- **LUM-211.** Los efectos de auditoría quedan en outbox dentro de la misma
  transacción del cambio de dominio.
- **LUM-212.** Toda superficie no conectada a un backend real se identifica
  explícitamente como demostrativa y no afirma haber ejecutado efectos externos.

La evidencia automatizada principal está en
[lumen.integration.test.ts](../../services/lumen-service/src/lumen.integration.test.ts),
[temporary-audio.test.ts](../../services/lumen-service/src/temporary-audio.test.ts),
[projection-events.integration.test.ts](../../services/lumen-service/src/projection-events.integration.test.ts)
y las
[pruebas de contratos](../../packages/contracts/src/index.test.ts).

## 14. Fuera de alcance del corte vigente

- **LUM-300.** Diagnóstico, prescripción, firma o aprobación autónomos.
- **LUM-301.** Uso de datos clínicos reales o integración con un expediente
  productivo.
- **LUM-302.** Conservación o reproducción posterior del audio original.
- **LUM-303.** Validez legal de consentimientos, documentos o firmas de la demo.
- **LUM-304.** Emisión financiera, radicación, validación oficial o comunicación
  real con terceros desde las superficies demo.
- **LUM-305.** Certificación normativa o declaración de cumplimiento por el solo
  hecho de implementar controles técnicos.
- **LUM-306.** Aplicación móvil nativa, operación offline o almacenamiento clínico
  local en dispositivos.

## 15. Gobierno del documento

Un cambio de estado DEBE acompañarse de evidencia versionada: contrato, migración,
ruta, prueba y, cuando cambie una decisión de riesgo, un ADR. La documentación
operativa vigente para la demo se mantiene en
[PRODUCTION.md](../PRODUCTION.md).

Ninguna actualización de esta especificación, por sí sola, habilita datos
clínicos reales.
