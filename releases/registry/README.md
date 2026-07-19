# Registry de artefactos federados

`provider-artifacts.v1.json` fija el nombre npm, owner, path fuente, versión actual y estado de publicación de los
contratos provider-owned y de las librerías compartidas requeridas para extraer NOVA.

Estados de publicación:

- `ready`: existe un workflow verificable, pero el artefacto aún no se considera publicado;
- `pending-workflow`: falta una ruta de publicación aprobada;
- `published`: requiere readback del registry y provenance vinculada al commit de origen.

Los contratos se publican con `publish-provider-contracts.yml`, que añade el gate N/N−1. `@hyperion/database` y
`@hyperion/logger` usan el flujo separado `publish-shared-libraries.yml`: comparten el mismo empaquetador, preflight y
verificador de readback, pero no fingen poseer snapshots de compatibilidad contractual.
La operación, promoción separada y recuperación se documentan en
[`SHARED-LIBRARY-PUBLICATION.md`](../../docs/operations/SHARED-LIBRARY-PUBLICATION.md).

`pnpm contracts:registry:check` valida el catálogo, los snapshots N−1, los manifests y que ningún consumidor use
`workspace:` para contratos compartidos. `pnpm contracts:registry:nova-extraction` añade el gate estricto: todos los
artefactos externos requeridos por NOVA deben estar publicados y verificados.

Ese gate es deliberadamente offline: valida estado y evidencia declarada, pero no afirma haber consultado la red. Antes
de una extracción real también debe pasar `pnpm contracts:registry:nova-readback`, que vuelve a ejecutar `npm view` y
`npm pack` para cada artefacto externo, comprueba URL/identidad/`gitHead`, recalcula SHA-512 sobre los bytes descargados y
verifica la attestation de GitHub contra el workflow y commit registrados. Un candidato de evidencia subido por el
workflow no cambia por sí solo el estado a `published`; la promoción del catálogo sigue siendo una revisión separada.

El catálogo no reemplaza los release manifests por producto. Solo describe artefactos npm y el límite de extracción.
