---
documentType: runbook
status: draft
owner: platform-release
issue: HYP-GOV-001
reviewDue: 2026-08-15
---

# Congelación y disposición de ramas heredadas

Este runbook congela de forma procedimental las ramas remotas `interfaz-coopfuturo` y
`feat/ordered-event-contracts-v2`. No aplica protección en GitHub, no autoriza un merge y no autoriza borrar
ninguna referencia. La evidencia se capturó el 2026-07-18 contra
`AdministracionHyperion/Plataforma-Hyperion`, con `main` en
`a80b877d6c7a2c134ae8aa5172ae54289fd1f3c6`.

La congelación aún no está impuesta por una regla remota: el repositorio continúa en una cuenta personal cuyo
plan no permite la protección requerida. Hasta que exista una GitHub Organization con reglas efectivas, el SHA
capturado es la barrera de integridad. Si una rama cambia, esta auditoría queda invalidada y debe repetirse antes
de rescatar o retirar cualquier contenido.

## Estado de disposición

| Rama                              | SHA congelado                              | Relación con `main`                                                                 | Disposición                                                               |
| --------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `interfaz-coopfuturo`             | `591a4fff97eddaa16a1ea15fd2741af69b515514` | Sin ancestro común; comparación directa de 993 archivos                             | Preservación sustancial confirmada; conservar solo como fuente histórica. |
| `feat/ordered-event-contracts-v2` | `cd15c9b302ae5a30f492959f193bbbbd02d5e7e2` | 9 commits delante, 57 detrás; base común `c5497f83ebf9e57796e80aa749dd7cbdbcc7e145` | Rescate selectivo pendiente; prohibido integrar el catálogo central.      |

Desde la fecha de este documento:

- no se desplegará, publicará ni liberará un artefacto desde estas ramas;
- no se aceptarán commits nuevos, force-pushes ni merges hacia ellas;
- una corrección urgente debe partir del `main` vigente, no de una rama congelada;
- todo rescate citará rama, SHA y rutas de origen exactas en su PR; y
- no se hará merge, rebase ni cherry-pick de una rama completa.

## `interfaz-coopfuturo`

### Evidencia e inventario

El tip fue creado el 2026-07-17 y pertenece a una historia independiente de 57 commits. Su árbol contiene 472
archivos: 188 bajo `apps/`, 71 bajo `services/`, 55 bajo `docs/`, 48 bajo `contracts/`, 31 bajo `tests`, 21 bajo
`packages/` y 20 bajo `design/`. Comparar los dos árboles directamente con `main` produce 993 archivos cambiados,
27.189 inserciones y 133.483 eliminaciones; esa cifra no representa un diff integrable porque GitHub confirma
que no existe ancestro común.

La rama conserva una aplicación Next.js en `apps/web`, los servicios Python `pilot-core`, `documents`,
`handoff-liwa` y `whatsapp-adapter`, contratos JSON, pruebas, documentación de arquitectura y composiciones
Docker/PostgreSQL/Redis. También conserva decisiones que ya no son normativas:

- el navegador pega un bearer y lo guarda en `sessionStorage`, frente a la sesión `HttpOnly`, `Secure` y
  `SameSite` requerida;
- `apps/web/src/app/(shell)/laboratorio/page.tsx` selecciona `tenant_id: "coopfuturo"`;
- la arquitectura mezcla operaciones PULSO/WhatsApp con el cliente Coopfuturo que ahora pertenece a NOVA;
- los runbooks dependen de la rama y de slugs de tenant, y describen un repositorio, gateway y topología previos
  a ADR-0006; y
- la entrega Python/Redis no comparte ciclo, contratos ni fronteras con la implementación TypeScript provider-owned
  vigente.

La preservación de la interfaz ya está materializada y no requiere volver a fusionar el árbol:

- el PR #23, fusionado el 2026-07-17 desde un SHA anterior de `interfaz-coopfuturo`, trasladó 41 archivos de
  Conversaciones, webhooks y cutover LIWA;
- el PR #26, también fusionado, declara explícitamente la sincronización con el tip `591a4ff` y su merge commit es
  el `main` auditado, `a80b877d`;
- de los 71 archivos de `apps/web`, 40 tienen contenido idéntico en la ruta equivalente de
  `apps/coopfuturo-console`, 30 fueron adaptados y solo `src/hooks/use-pulso.ts` no existe; y
- la aplicación vigente reemplaza ese hook por `use-nova.ts` y añade adaptador NOVA, política de rutas, política
  de sesión y pruebas de seguridad/build.

### Material que puede revisarse de forma selectiva

| Fuente histórica                           | Valor potencial                                            | Condición de preservación                                                                           |
| ------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/web` y `design/`                     | UX, visuales y flujos operativos Coopfuturo                | Abrir PR solo ante una diferencia funcional demostrada; conservar binding NOVA y sesión segura.     |
| Fixes de LIWA/chat espejo y doble WhatsApp | Casos de fallo, sanitización y criterios de aceptación     | Reproducir el caso sobre los servicios NOVA vigentes; no portar el runtime Python completo.         |
| `contracts/` y pruebas                     | Vectores de idempotencia, clasificación de datos y eventos | Asignar cada contrato al proveedor actual y probar SemVer N/N−1; no publicar el registry histórico. |
| ADR, ownership y runbooks                  | Contexto de decisiones y riesgos operativos                | Tratar como evidencia histórica; ADR-0006 y los runbooks vigentes prevalecen.                       |

Los 30 archivos de UI adaptados no son una cola automática de trabajo. Solo se compararán cuando exista un issue
que describa una capacidad ausente y una prueba que falle en `apps/coopfuturo-console`.

## `feat/ordered-event-contracts-v2`

### Evidencia e inventario

La rama contiene nueve commits del 2026-07-13 y no tiene PR. Está 57 commits detrás de `main` y cambia cinco
archivos, con 2.269 inserciones y cuatro eliminaciones:

- añade `packages/durable-events/src/ordered-contracts.ts` (1.250 líneas);
- añade `packages/durable-events/src/ordered-contracts.test.ts` (737 líneas);
- exporta el módulo desde `packages/durable-events/src/index.ts`; y
- añade un ADR de eventos ordenados y modifica su índice.

El código histórico ofrece material reusable: validación estricta del envelope, límites de bytes/profundidad/nodos
JSON, binding entre principal NATS, subject, productor y consumidor, verificación de tenant/partición/secuencia,
clasificación V1/V2 y una batería amplia de casos negativos.

No se puede integrar como está. `ORDERED_EVENT_SERVICE_IDENTITIES` y `ORDERED_EVENT_CONTRACTS` forman un catálogo
cerrado que conoce conjuntamente WhatsApp, PULSO, SOFÍA, LUMEN y Audit desde `@hyperion/durable-events`. Esto
contradice la propiedad provider-owned y la prohibición de catálogos multiproducto de ADR-0006. Además:

- registra `sofia.audit.event.record.v2` y `lumen.audit.event.record.v2`, mientras el contrato Audit vigente acepta
  eventos de proveedor V1 mediante `@hyperion/audit-contracts`;
- duplica contratos ordenados que ya evolucionaron en PULSO (`channel.inbound.received.v2` y
  `pulso.message.received.v2`) con migraciones y ventanas N/N−1 propias;
- fija identidades, consumers y subjects de varios proveedores dentro de una sola publicación; y
- intenta crear otro ADR-0003, número que hoy pertenece a los límites de NOVA y está parcialmente reemplazado por
  ADR-0006.

### Corte permitido para rescate

Un PR de rescate debe partir del `main` protegido y cumplir todos estos límites:

1. separar helpers neutrales de serialización/validación de los contratos de dominio;
2. mover tipos, producers, consumers y subjects a los paquetes del proveedor correspondiente;
3. conservar solo vectores de prueba aplicables al contrato vigente y añadir compatibilidad N/N−1;
4. no introducir un listado exhaustivo de productos, servicios o eventos en `@hyperion/durable-events`;
5. asignar un nuevo número de ADR si aún existe una decisión no cubierta por ADR-0006; y
6. demostrar que un cambio exclusivo de PULSO o LUMEN no afecta el release de Platform/NOVA.

No se cherry-pickearán los nueve commits: mezclan código genérico, contratos de dominio y documentación con
propiedad incompatible en una misma secuencia.

## Flujo de preservación

Para cada fragmento que aún tenga valor:

1. abrir o vincular un issue con owner de la célula y criterio de aceptación;
2. crear una rama nueva desde el `main` protegido;
3. copiar el fragmento mínimo y registrar `sourceBranch`, `sourceSha` y `sourcePaths` en el cuerpo del PR;
4. adaptar ownership, versiones, autenticación, tenant binding y transporte a los contratos vigentes;
5. ejecutar lint, typecheck, unitarias, integración, fronteras federadas y checks de la célula afectada;
6. exigir revisión humana/CODEOWNER y conversaciones resueltas; y
7. anotar aquí el PR de preservación antes de retirar la referencia original.

No se considera preservación un enlace a la rama, una copia sin pruebas o un PR que vuelva a introducir secretos,
slugs operativos de tenant, bearers de navegador, HTTP público, catálogo multiproducto o release global.

## Condiciones para retirar cada rama

La rama solo puede borrarse tras una aprobación humana explícita y cuando se cumpla todo lo siguiente:

- el SHA remoto coincide con el SHA congelado de este documento;
- `main` está protegida y los PR de preservación requeridos están fusionados con checks verdes;
- cada grupo del inventario está marcado como preservado mediante PR o rechazado con justificación;
- no existe workflow, despliegue, runbook vigente ni entorno que haga checkout de la rama;
- los runbooks `not-current` que todavía la mencionan se archivaron o revalidaron;
- el historial queda recuperable mediante un tag de archivo protegido o un bundle verificado en almacenamiento
  controlado; y
- el owner de `platform-release` registra el readback del tag/bundle y autoriza el borrado en `HYP-GOV-001`.

El borrado remoto, la creación del tag y cualquier cambio de reglas son operaciones posteriores y fuera del alcance
de este documento.

## Verificación reproducible

Después de `git fetch origin`, verificar los SHAs y la divergencia sin hacer checkout:

```powershell
git rev-parse origin/main origin/interfaz-coopfuturo origin/feat/ordered-event-contracts-v2
git merge-base origin/main origin/interfaz-coopfuturo
git rev-list --left-right --count origin/main...origin/feat/ordered-event-contracts-v2
git diff --shortstat origin/main origin/interfaz-coopfuturo
git diff --stat origin/main...origin/feat/ordered-event-contracts-v2
```

`git merge-base` debe terminar sin imprimir un SHA para `interfaz-coopfuturo`; ese código distinto de cero es la
evidencia esperada de historias independientes, no un error que deba corregirse con un merge.
