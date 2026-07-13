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
escribe temporalmente en un directorio privado, se procesa y se elimina en todos
los resultados de la solicitud. PostgreSQL conserva trazabilidad técnica y texto,
pero nunca los bytes del audio.

La posible utilidad futura del audio como soporte de revisión no basta para
definir su finalidad, plazo de conservación, acceso ni eliminación. Tampoco
autoriza su uso con datos clínicos reales.

## Decisión

### Política vigente para la demo

1. El audio es **efímero**. Solo puede existir durante una solicitud de
   transcripción.
2. Antes de escribir un temporal se validan origen, MIME, tamaño y duración.
3. El temporal se crea con permisos privados dentro del almacenamiento efímero,
   no ejecutable y acotado del servicio.
4. La eliminación se ejecuta en una cláusula de finalización tanto en éxito como
   en error, cancelación o aborto.
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
- La política es simple, verificable y falla cerrada.
- La trazabilidad técnica permanece disponible mediante transcript, hashes,
  estados e idempotencia.

### Negativas y límites

- No es posible reproducir el audio después de la solicitud.
- Una controversia sobre la transcripción no puede contrastarse con el audio
  original dentro de LUMEN.
- Transcript y hash no equivalen al audio ni garantizan por sí solos suficiencia
  clínica o probatoria.
- La decisión no certifica cumplimiento ni autoriza datos clínicos reales.

## Salvaguardas y verificación

- La [migración del pipeline](../../../packages/migrations/sql/020-lumen-real-audio-pipeline.sql)
  impide usar la trazabilidad como almacenamiento de audio y exige registrar la
  eliminación del temporal en estados terminales.
- [temporary-audio.ts](../../../services/lumen-service/src/temporary-audio.ts)
  concentra la creación privada y la limpieza en la finalización.
- [routes.ts](../../../services/lumen-service/src/routes.ts) registra
  `audioStored=false` y enlaza el resultado con su intento idempotente.
- [temporary-audio.test.ts](../../../services/lumen-service/src/temporary-audio.test.ts)
  verifica la limpieza ante resultados exitosos y fallidos.
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
