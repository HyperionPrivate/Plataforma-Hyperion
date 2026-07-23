# Registry de artefactos federados

[`repository-identity.v1.json`](repository-identity.v1.json) es la fuente normativa offline para el repositorio,
namespace GHCR, registry npm, environment de publicación y alcance migrado. En este corte el alcance de publicación
sigue siendo únicamente Platform (`releaseCells: ["platform"]`). Los catálogos/manifiestos de NOVA, LUMEN y PULSO ya
declaran `ghcr.io/hyperionprivate/...`, pero no entran en el scope de publicación hasta ampliar `releaseCells`,
acreditar teams con `write` y generar bundles bajo `releases/published/`.

`pnpm release:verify-registry-path` liga esa identidad al catálogo Platform vigente, al estado explícito de
CODEOWNERS y a los cuatro workflows que pueden mutar registries o GitHub Releases. El estado actual es
`verified-repository-access`: los teams canónicos tienen `push` explícito al repositorio y
`.github/CODEOWNERS` activa las reglas Platform.

Los workflows ejecutan además el preflight con `--verify-github-access`. Requieren el secreto de environment
`RELEASE_GOVERNANCE_TOKEN`, emitido con visibilidad de equipos de la organización y lectura de metadata del
repositorio. La comprobación consulta cada team previsto, exige `privacy=closed`, comprueba permiso
`push`/`maintain`/`admin` sobre `HyperionPrivate/Plataforma-Hyperion` y falla si la respuesta es ambigua, 404 o no
incluye evidencia de escritura. Ownership ya está acreditado; la publicación sigue bloqueada hasta configurar
secretos del environment (`RELEASE_GOVERNANCE_TOKEN`, `NPM_TOKEN`) y archivar readback bajo `releases/published/`.
El gate local no acredita credenciales ni artefactos remotos.

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
