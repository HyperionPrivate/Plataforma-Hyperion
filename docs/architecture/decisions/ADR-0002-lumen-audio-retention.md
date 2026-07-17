# ADR-0002 — Retención de audio clínico en LUMEN

- **Estado:** aceptada para la demo sintética; activación clínica real bloqueada.
- **Fecha:** 2026-07-13.
- **Ámbito:** captura, procesamiento, trazabilidad y eliminación del audio de
  LUMEN.
- **Especificación relacionada:**
  [LUMEN](../../products/LUMEN.md#7-audio-y-transcripción).

## Contexto

LUMEN convierte audio autorizado en una transcripción y, después, en un borrador
clínico sujeto a revisión humana. Conservar el audio después de la solicitud
amplía de forma material el conjunto de datos sensibles, las obligaciones de
acceso, el ciclo de vida, los respaldos y el impacto de un incidente.

El corte actual ya implementa una política distinta: el audio se valida, se
escribe temporalmente en un directorio privado y se procesa. La eliminación se
intenta al terminar la solicitud; si el sistema de archivos no confirma el
borrado, el intento queda en `cleanup_pending` y un reconciliador durable lo
reintenta. PostgreSQL conserva trazabilidad técnica y texto, pero nunca los bytes
ni la ruta del audio.

La posible utilidad futura del audio como soporte de revisión no basta para
definir su finalidad, plazo de conservación, acceso ni eliminación. Tampoco
autoriza su uso con datos clínicos reales.

## Decisión

### Política vigente para la demo

1. El audio es **efímero**. Solo puede existir durante el procesamiento de una
   transcripción o, ante una interrupción o un fallo de borrado, durante su
   recuperación pendiente.
2. Antes de escribir un temporal se validan origen, MIME, tamaño y duración.
3. El temporal se crea con permisos privados dentro del almacenamiento efímero,
   no ejecutable y acotado del servicio.
4. La eliminación se intenta al finalizar tanto en éxito como en error,
   cancelación o aborto. Un fallo no se presenta como éxito: bloquea el estado
   terminal en `cleanup_pending` hasta que un reintento confirme el borrado.
5. El audio y su representación codificada NO se guardan en PostgreSQL,
   almacenamiento de objetos, colas, auditoría ni logs.
6. No se habilita una ruta de descarga, reproducción o recuperación de audio.

### Evidencia que sí se conserva

Para permitir diagnóstico técnico, idempotencia y trazabilidad sin retener el
audio, LUMEN conserva:

- transcript recibido y, cuando aplica, transcript revisado por una persona;
- hash criptográfico de la entrada;
- origen, MIME y duración verificada;
- operación, clave de idempotencia y estados de procesamiento;
- timestamps de inicio y terminación;
- snapshot y hash del resultado estructurado;
- vínculo entre intento, dictado, encuentro y registro;
- confirmación de eliminación del temporal;
- eventos de auditoría mínimos, sin audio ni contenido innecesario.

El hash demuestra igualdad frente a unos bytes disponibles para comparación, pero
no permite reconstruir el audio ni sustituye su contenido como evidencia.

### Bloqueo de activación clínica real

LUMEN NO puede habilitar audio de personas reales hasta que exista una política
conjunta de Producto, Seguridad y responsables jurídicos, aprobada y versionada.
Como mínimo debe resolver:

1. finalidad exacta y necesidad de conservar o no el audio;
2. base de autorización, información a la persona y mecanismo de ejercicio de
   derechos;
3. plazo por estado del encuentro y regla de eliminación verificable;
4. roles con acceso, revisión periódica y auditoría de cada reproducción;
5. cifrado, gestión de llaves, residencia, respaldos y copias derivadas;
6. tratamiento de retenciones excepcionales y órdenes de preservación;
7. respuesta a incidentes, exportación y eliminación;
8. pruebas de restauración, purga y fallo seguro;
9. migración de datos y reversa sin pérdida del registro clínico;
10. actualización de contratos, esquema, modelo de amenazas y operación.

La decisión resultante debe reemplazar este ADR. Una variable de entorno o
bandera de funcionalidad no es aprobación suficiente.

## Alternativas consideradas

### A. Conservar todo el audio por defecto

Rechazada. Aumenta exposición y costo operativo antes de definir una finalidad y
un ciclo de vida aprobados. También crea copias en respaldos y recuperaciones que
la implementación actual no gobierna.

### B. Eliminar el audio al terminar la solicitud

Seleccionada para la demo. Minimiza datos persistentes y coincide con las
invariantes, rutas, pruebas y procedimientos actuales.

### C. Retención configurable por tenant

Rechazada por ahora. Una configuración flexible trasladaría una decisión de
gobierno a una opción operativa propensa a errores. Solo puede reconsiderarse
después de aprobar la política clínica real y sus controles.

## Consecuencias

### Positivas

- Se reduce la cantidad de información sensible persistente.
- Se evita propagar audio a respaldos, réplicas y procesos secundarios.
- La política es verificable y falla cerrada: un intento no queda terminal sin
  confirmación de borrado o evidencia administrativa de que su scope efímero
  completo fue destruido.
- La trazabilidad técnica permanece disponible mediante transcript, hashes,
  estados e idempotencia.

### Negativas y límites

- No es posible reproducir el audio después de la solicitud.
- Un fallo persistente del almacenamiento puede prolongar temporalmente la
  existencia del residuo y requiere alerta y remediación operativa.
- Cada réplica necesita un `LUMEN_INSTANCE_ID` estable y único. Con el `tmpfs` de
  Compose, eliminar el contenedor destruye toda la frontera temporal y el
  reemplazo reconcilia la ausencia; si un orquestador usa almacenamiento
  temporal persistente, debe remontar la misma frontera exclusiva hasta
  completar la limpieza.
- Una caída no controlada conserva el cerco de la lease hasta su expiración; el
  reemplazo debe usar la misma identidad. Si existe trabajo no terminal de una
  identidad distinta con lease expirada o ausente, LUMEN falla readiness de
  forma global y exige restaurar esa identidad y su frontera. No hay
  reclamación automática entre owners porque una réplica no puede demostrar
  que el almacenamiento temporal ajeno sea seguro de borrar.
- La imagen N-1 anterior al protocolo determinista sólo puede operar durante
  una única ventana global de rollback, con un scope efímero exacto reflejado
  en `PGAPPNAME` y privilegios temporales. No existen ventanas paralelas ni
  recuperación por ruta para sus directorios aleatorios.
- Una controversia sobre la transcripción no puede contrastarse con el audio
  original dentro de LUMEN.
- Transcript y hash no equivalen al audio ni garantizan por sí solos suficiencia
  clínica o probatoria.
- La decisión no certifica cumplimiento ni autoriza datos clínicos reales.

## Salvaguardas y verificación

- La [migración del pipeline](../../../packages/migrations/sql/020-lumen-real-audio-pipeline.sql)
  impide usar la trazabilidad como almacenamiento de audio y exige registrar la
  eliminación del temporal en estados terminales.
- La [migración de recuperación](../../../packages/migrations/sql/029-lumen-audio-cleanup-recovery.sql)
  introduce `cleanup_pending`, distingue `deterministic_v2` de
  `legacy_ephemeral_v1`, exige drenar intentos no atribuibles antes del cambio y
  bloquea la transición terminal hasta confirmar el borrado. El protocolo
  legacy captura el scope de `PGAPPNAME` sólo cuando coincide con la ventana
  administrativa abierta; nunca inventa un `cleanup_owner` ni una ruta
  determinista.
- La [fase de contrato y lease](../../../packages/migrations/sql/032-lumen-audio-cleanup-contract.sql)
  valida las restricciones, crea una lease exclusiva por owner y mantiene
  evidencia administrativa de las ventanas N-1 y scopes destruidos; el
  [índice concurrente](../../../packages/migrations/sql/033-lumen-audio-cleanup-index.sql)
  acelera los reintentos del owner y el
  [índice de owners no resueltos](../../../packages/migrations/sql/039-lumen-unresolved-cleanup-owner-index.sql)
  mantiene acotado el chequeo global de readiness. Ambos permiten reconciliar
  pendientes sin un scan completo.
- [temporary-audio.ts](../../../services/lumen-service/src/temporary-audio.ts)
  concentra la creación privada y la limpieza en la finalización.
- [audio-cleanup-recovery.ts](../../../services/lumen-service/src/audio-cleanup-recovery.ts)
  recupera intentos interrumpidos del mismo owner y reintenta únicamente
  filas `deterministic_v2` y sus directorios asociados; filtra explícitamente el
  protocolo legacy, no barre el directorio raíz ni toca audio activo de otra
  réplica. Una lease duplicada impide arrancar y perder el heartbeat degrada
  readiness a HTTP 503.
- [lumen-n-minus-one-compatibility.ts](../../../packages/migrations/src/lumen-n-minus-one-compatibility.ts)
  serializa apertura, cierre, atestación y bootstrap con el mismo mutex. La
  apertura y el cierre usan un fence `NOLOGIN` confirmado; el cierre drena toda
  sesión `hyperion_lumen`, revoca los grants mínimos y conserva el fence. Sólo
  después de destruir externamente la frontera efímera y cerrar la ventana se
  permite registrar el hash de esa evidencia y finalizar intentos legacy del
  scope exacto. El comando no busca ni elimina archivos, el runtime LUMEN no
  puede autoatestiguarse y el retorno a `LOGIN` requiere el bootstrap completo.
- [routes.ts](../../../services/lumen-service/src/routes.ts) registra
  `audioStored=false` y enlaza el resultado con su intento idempotente.
- [temporary-audio.test.ts](../../../services/lumen-service/src/temporary-audio.test.ts)
  verifica la limpieza ante resultados exitosos y fallidos.
- [audio-cleanup-recovery.test.ts](../../../services/lumen-service/src/audio-cleanup-recovery.test.ts)
  verifica aislamiento por owner, reintentos y cierre del reconciliador.
- [speech-to-text.test.ts](../../../services/lumen-service/src/speech-to-text.test.ts)
  verifica límites, cancelación y manejo seguro del procesamiento.
- [PRODUCTION.md](../../PRODUCTION.md#demo-clinica-lumen) mantiene el
  procedimiento operativo alineado con esta decisión.

Un cambio que introduzca almacenamiento de audio debe fallar la revisión
arquitectónica si no incluye un ADR reemplazante, migraciones, pruebas de ciclo de
vida y actualización de la especificación LUMEN.

## Criterio para reemplazar este ADR

Este ADR puede reemplazarse únicamente cuando:

1. exista una política aprobada que cubra todos los bloqueos anteriores;
2. el diseño especifique amenazas, acceso, cifrado, retención, purga y respaldos;
3. las migraciones y rutas fallen cerradas ante una configuración incompleta;
4. las pruebas demuestren conservación y eliminación según la política;
5. el runbook productivo incluya monitoreo, incidentes, restauración y purga;
6. la
   [especificación de LUMEN](../../products/LUMEN.md#12-capacidades-pendientes)
   cambie el estado de activación con evidencia versionada.
