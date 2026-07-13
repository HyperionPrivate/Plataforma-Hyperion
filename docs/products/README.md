# Productos

Esta carpeta es la fuente de verdad versionada para el alcance funcional de los productos de software de
Hyperion. Las especificaciones son deliberadamente técnicas y no incluyen contratos, precios, datos personales,
credenciales ni información reservada de clientes.

## Portafolio de software

| Producto                    | Propósito                                                                                       | Estado documentado                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [PULSO IRIS](PULSO-IRIS.md) | Atención administrativa, agenda y automatización multicanal. SOFÍA es su agente conversacional. | Implementación parcial con integraciones y automatizaciones todavía simuladas o pendientes. |
| [LUMEN](LUMEN.md)           | Asistencia clínica por voz con revisión y aprobación humana.                                    | Corte de demostración clínica limitado a datos sintéticos.                                  |

SOFÍA puede desplegarse en un contexto técnico separado para proteger su ciclo de vida, datos y operación, pero
no constituye un producto comercial independiente. La consultoría y otros servicios profesionales tampoco son
runtimes de la plataforma. Esta separación se formaliza en
[ADR-0001](../architecture/decisions/ADR-0001-product-service-boundaries.md).

## Estados de cobertura

La [matriz de trazabilidad](REQUIREMENTS-TRACEABILITY.md) usa exclusivamente estos estados:

| Estado                   | Significado                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `implementado`           | Existe un flujo funcional respaldado por código y pruebas dentro del alcance indicado.             |
| `parcial`                | Existe una parte funcional, pero falta al menos una condición necesaria del requisito.             |
| `simulado`               | El flujo usa un sustituto explícito y no prueba la integración externa real.                       |
| `demo sintética`         | La interfaz o el flujo solo están autorizados con datos sintéticos de demostración.                |
| `pendiente`              | No existe evidencia suficiente de implementación.                                                  |
| `bloqueado por decisión` | La implementación no debe avanzar hasta cerrar una decisión de producto, seguridad o cumplimiento. |

Un estado de implementación no demuestra que el código esté desplegado en un ambiente. Un despliegue se acredita
por separado mediante commit, imágenes y registro operativo.

## Control de cambios

- Cada requisito estable conserva su identificador `PUL-*` o `LUM-*`.
- Cambiar alcance o estado exige actualizar la especificación y la matriz en el mismo cambio.
- Las decisiones que alteren límites, seguridad, retención o cumplimiento se registran como ADR.
- Una promesa futura, un mockup o una pantalla local nunca se clasifican como `implementado` sin backend,
  persistencia, autorización y pruebas proporcionales al riesgo.

Algunas migraciones históricas conservan en comentarios o metadatos el nombre de documentos internos usados al
crear el esquema. Esas cadenas son evidencia de procedencia y no enlaces normativos. Las migraciones aplicadas no
se reescriben porque sus checksums forman parte del historial; el alcance canónico y saneado vive en esta carpeta.

Estas especificaciones consolidan el alcance funcional y lo contrastan con evidencia versionada del repositorio.
Una fuente privada o externa debe quedar resumida, saneada y aprobada aquí antes de cambiar un requisito o su
estado; no constituye una dependencia documental del proyecto.
