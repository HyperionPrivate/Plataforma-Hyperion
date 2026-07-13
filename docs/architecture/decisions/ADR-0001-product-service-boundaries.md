# ADR-0001: Límites de producto y de servicio

- Estado: Aceptada
- Fecha: 2026-07-13

## Contexto

La plataforma necesita permitir varios productos independientes sin asumir que cada nombre comercial corresponde a un único microservicio. Un producto agrupa una propuesta y un recorrido de usuario; un límite técnico agrupa datos, comportamiento y responsabilidades que deben cambiar, escalar y fallar juntos. Son dimensiones relacionadas, pero no equivalentes.

El monorepo tampoco determina el estilo de ejecución. Puede contener varios contextos autónomos siempre que la autonomía se sostenga con propiedad exclusiva de datos, contratos explícitos, despliegue y recuperación independientes, y ausencia de consultas SQL entre propietarios.

PULSO IRIS ya compone agenda, automatización conversacional, canales e integraciones. LUMEN contiene un flujo clínico diferente y requiere su propia frontera de datos y riesgo. SOFÍA forma parte de la experiencia de PULSO, aunque su runtime tiene motivos técnicos para aislarse. La consultoría produce análisis, configuración o entregables profesionales, pero no representa por sí misma un proceso de software en ejecución.

## Decisión

1. **PULSO IRIS es un producto.** Puede estar compuesto por varios contextos técnicos y servicios desplegables.
2. **LUMEN es un producto.** Conserva un contexto propietario de datos y un ciclo de evolución independiente de PULSO.
3. **SOFÍA es una capacidad de PULSO IRIS, no un tercer producto en esta decisión.** Su ejecución puede y debe operar como el contexto técnico autónomo `sofia-automation` cuando ello permita desplegar, escalar, observar o recuperar la automatización sin acoplarla al núcleo de agenda.
4. **La consultoría es un servicio profesional, no un microservicio.** No se creará un `consulting-service` salvo que aparezca posteriormente un dominio de software persistente con comportamiento runtime y criterios propios de autonomía. Los documentos o entregables de consultoría no justifican esa frontera.
5. **Producto comercial y límite desplegable se modelan por separado.** No se exige una relación uno a uno entre productos, contextos acotados, repositorios, procesos o despliegues.
6. **Los límites técnicos se deciden por cohesión y autonomía**, no por organigrama ni por nombres comerciales: propiedad de datos, contratos versionados, aislamiento de fallos, necesidades de escala, frecuencia de cambio, seguridad y operación.

## Mapa adoptado

| Concepto    | Clasificación de producto | Límite técnico actual u objetivo                                                                                               | Regla                                                                                            |
| ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| PULSO IRIS  | Producto                  | `pulso-core`, `sofia-automation`, canal y adaptadores de integración; consume capacidades transversales de acceso y auditoría. | El producto puede coordinar varios contextos sin leer directamente sus datos propietarios.       |
| LUMEN       | Producto                  | `lumen`, con datos y proyecciones locales; consume contratos de acceso, auditoría y eventos autorizados.                       | Su ciclo clínico, riesgo y persistencia permanecen aislados de PULSO.                            |
| SOFÍA       | Capacidad de PULSO IRIS   | `sofia-automation`; puede abarcar más de un proceso desplegable durante la transición.                                         | Puede desplegarse y fallar de forma independiente sin cambiar su pertenencia al producto PULSO.  |
| Consultoría | Servicio profesional      | Ninguno por defecto.                                                                                                           | Se gestiona como trabajo y entregables, no como API, base de datos o proceso runtime artificial. |

El gateway continúa siendo el borde de entrada y la consola web puede presentar varios productos, pero ninguno de los dos se convierte por ello en propietario de sus datos de dominio.

## Criterios para aceptar un límite desplegable autónomo

Un contexto se considerará autónomo cuando cumpla, de forma verificable, todos estos criterios:

- Tiene un propietario explícito de sus tablas, migraciones, credenciales de rol y política de retención.
- Expone APIs o eventos versionados para toda interacción entre contextos.
- No realiza consultas ni escrituras SQL sobre datos cuyo propietario sea otro contexto.
- Dispone de health/readiness, métricas, logs correlacionables y procedimientos de recuperación.
- Puede desplegarse y revertirse sin una liberación sincronizada obligatoria de los demás contextos.
- Define idempotencia, reintentos, reconciliación y comportamiento ante indisponibilidad para sus integraciones.
- Mantiene pruebas de contrato y recorridos de extremo a extremo proporcionales al riesgo.

Crear un nuevo producto no crea automáticamente un microservicio. Del mismo modo, separar un proceso por escala u operación no crea automáticamente un nuevo producto.

## Consecuencias

### Positivas

- PULSO puede evolucionar su agenda y SOFÍA a ritmos distintos sin fragmentar la experiencia comercial.
- LUMEN obtiene una frontera clara para datos, controles y decisiones clínicas.
- Los nombres de servicios dejan de condicionar el catálogo de productos.
- La consultoría no añade infraestructura, persistencia ni operación sin una necesidad de dominio demostrable.
- La matriz de requisitos puede comunicar madurez de producto sin confundirla con la topología de despliegue.

### Costos y obligaciones

- PULSO necesita composición entre varios contextos y pruebas de contratos entre ellos.
- SOFÍA requiere retirar accesos SQL transicionales antes de declarar autonomía completa.
- Las proyecciones entre productos deben incluir backfill, reconciliación y trazabilidad de origen.
- La consola compartida debe respetar los permisos y estados de cada producto, sin convertirse en una vía de acoplamiento de datos.
- La plataforma debe operar más de un despliegue y mantener observabilidad correlacionada.

## Alternativas descartadas

### Un microservicio por producto

Se descarta porque concentraría en PULSO capacidades con perfiles de escala, fallo y cambio diferentes, y confundiría una unidad comercial con una unidad operativa.

### Declarar SOFÍA como producto independiente ahora

Se descarta porque la capacidad actual completa principalmente el recorrido de agenda de PULSO. Su autonomía técnica ya puede lograrse sin duplicar catálogo, experiencia ni gobierno de producto. Esta clasificación podrá revisarse si aparece una propuesta y ciclo de vida propios respaldados por requisitos reales.

### Crear un microservicio de consultoría

Se descarta porque un servicio profesional no posee por definición un runtime, datos de dominio ni disponibilidad técnica. Si en el futuro surge un producto de software para gestionar esa actividad, se evaluará por los criterios de autonomía de este ADR y no por el nombre de la oferta.

### Nombrar y dividir todos los servicios según el catálogo comercial

Se descarta porque fuerza renombres y fronteras artificiales, dificulta reutilizar capacidades transversales y no mejora por sí mismo la autonomía.

## Evidencia y documentos relacionados

- `docs/architecture/AUTONOMOUS-MICROSERVICES.md`
- `docs/architecture/POSTGRESQL-SERVICE-ROLES.md`
- `docs/architecture/data-ownership.json`
- `docs/architecture/boundary-baseline.json`
- `docs/products/REQUIREMENTS-TRACEABILITY.md`

## Regla de revisión

Esta decisión se revisará si cambia el catálogo de productos, si SOFÍA adquiere una propuesta y operación propias, o si aparece un nuevo dominio runtime. La revisión debe conservar la separación entre producto comercial y límite técnico, y documentar migración, propiedad de datos y compatibilidad de contratos antes de mover responsabilidades.
