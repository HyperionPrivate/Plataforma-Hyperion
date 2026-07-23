# Releases federados

Este directorio separa el inventario desplegable y el manifiesto de cada celda: `platform`, `nova`, `lumen` y `pulso`.

## Estructura

- `catalogs/<cell>/<catalogVersion>.json`: inventario inmutable de componentes, versión SemVer, código fuente y distribución (`oci` o `npm`).
- `manifests/<cell>/<releaseVersion>.json`: versión de release y artefacto inmutable de cada componente.
- `rollback-policies/<cell>/<catalogVersion>.json`: partición OCI entre runtimes rollbackables y control plane forward-only, más el manifiesto SHA-256 de migraciones provider-owned.
- `schemas/`: contratos JSON Schema 2020-12 para catálogos, manifiestos y políticas de rollback.

Un catálogo publicado no se modifica: se agrega una nueva versión. El catálogo más reciente de cada celda debe contener todos los servicios de Compose y todos los artefactos publicables descubiertos en `apps/`, `services/` y los paquetes provider-owned `*-contracts`/`*-migrations`. Para ese catálogo vigente, el validador también comprueba que `version` y, para npm, `packageName` coincidan con el `package.json` declarado en `versionSource`; los catálogos históricos siguen siendo válidos cuando el código avanza de versión.

Los catálogos vigentes de NOVA, LUMEN y PULSO deben apuntar a una política de rollback canónica con la misma versión
y fijar también el SHA-256 de sus bytes. Una política v2 enumera por separado, y en orden de catálogo,
`rollbackOciComponents` (servicios, BFF y consola) y `forwardOnlyOciComponents` (el migrador que también ejecuta
database/role bootstrap). Las políticas v1 históricas se normalizan con el `kind` del catálogo: aunque su inventario
legacy se llame `ociComponents`, cualquier componente `kind: migrations` se trata siempre como forward-only.
La política exige el único migrador de la celda y fija cada SQL provider-owned por ruta y SHA-256. `release:check` compara esos
bytes con el checkout: una migración añadida, retirada, reordenada, modificada o tomada de otra celda exige una nueva
política y falla cerrada mientras tanto.

Un componente OCI puede cubrir varios aliases Compose sólo cuando todos ejecutan la misma imagen. `buildService`
selecciona el alias canónico y `composeServices` enumera todos sus consumidores; el productor construye cada alias,
exige que resuelvan al mismo image ID y publica/fija un único digest. Así, `audit-migrations` cubre
`audit-database-bootstrap`, `audit-migrations` y `audit-role-bootstrap`; los migradores provider-owned de LUMEN y
PULSO siguen el mismo patrón. Duplicar esos aliases como componentes o repositorios OCI separados está prohibido.

La excepción transicional `legacy-global-migrations` aplica ese mecanismo a `migrations` y `db-role-bootstrap`, que
ejecutan artefactos distintos de la misma imagen `@hyperion/migrations`. Esa cobertura hace reproducible el stack
heredado, no convierte sus migraciones, ledger ni bootstrap global de roles en una frontera autónoma; su retiro sigue
trazado por `HYP-DEBT-022`.

## Borradores y publicación

Los cuatro manifiestos iniciales tienen `status: "draft"` e `imagesVerified: false`. Sus digests OCI son centinelas deterministas generados localmente; documentan el formato, pero no representan imágenes publicadas y no deben desplegarse. Los contratos npm se fijan como `@scope/package@version` exacto.

Un manifiesto `published` requiere:

- una versión SemVer para el release y para cada componente;
- todas las imágenes OCI fijadas mediante digest SHA-256;
- repositorios de imagen iguales a los declarados por el catálogo;
- todos los contratos npm fijados al nombre y versión exactos del catálogo;
- `imagesVerified: true` después de comprobar los digests en el registry;
- un Git SHA completo en `sourceRevision` y una fecha `releasedAt`.

El validador rechaza tags mutables, componentes ausentes o extra, versiones divergentes, coordenadas npm ajenas, repositorios OCI ajenos, digests nulos y la promoción de un digest centinela.

Los verificadores de rollback son deliberadamente offline y de solo lectura. Ya no aceptan un manifiesto suelto ni
un SHA suministrado por el mismo operador. Reciben dos directorios descargados del GitHub Release: el bundle
`published` que fija los runtimes destino y el bundle `published` current que fija el control plane que permanece.
Cada directorio debe contener `manifest.json`, `image-inventory.json`, `registry-verification.json`,
`npm-verification.json`, `attestation.json` y `SHA256SUMS`. Se verifican los checksums, la attestation federada, los
readbacks OCI/npm y la provenance mediante el mismo `validate-published-release.mjs` usado al publicar. El verificador
no consulta registries, no despliega imágenes y no cambia tráfico:

```bash
pnpm ops:nova:rollback:verify -- --rollback-bundle <release-n-1/> --current-bundle <release-n/> --observed-images <observed.json> --confirm "ROLLBACK NOVA RUNTIMES <n-1> MANIFEST SHA256 <sha-n-1> KEEP CONTROL PLANE <n> MANIFEST SHA256 <sha-n>"
pnpm ops:lumen:rollback:verify -- --rollback-bundle <release-n-1/> --current-bundle <release-n/> --observed-images <observed.json> --confirm "ROLLBACK LUMEN RUNTIMES <n-1> MANIFEST SHA256 <sha-n-1> KEEP CONTROL PLANE <n> MANIFEST SHA256 <sha-n>"
pnpm ops:pulso:rollback:verify -- --rollback-bundle <release-n-1/> --current-bundle <release-n/> --observed-images <observed.json> --confirm "ROLLBACK PULSO RUNTIMES <n-1> MANIFEST SHA256 <sha-n-1> KEEP CONTROL PLANE <n> MANIFEST SHA256 <sha-n>"
```

El inventario observado v2 contiene `cell`, `rollbackReleaseVersion`, `currentReleaseVersion`, `rollbackImages` y
`forwardOnlyImages`. El primer mapa debe coincidir uno a uno con los runtimes del bundle destino; el segundo, con el
migrador/bootstrap del bundle current. Cada imagen usa exactamente `repositorio@sha256:<64-hex>`. Mezclar
`pulso-migrations` en `rollbackImages`, ejecutar su digest N−1 o omitir el digest current falla cerrado.

El verificador compara únicamente la política de migraciones del bundle current con el directorio SQL del checkout
que lo ejecuta. La política histórica PULSO `1.1.0` conserva sus bytes y hashes, pero su migrador jamás se selecciona
como target: sobre una base expandida, database-bootstrap, migraciones y role-bootstrap permanecen en la versión
current. Sigue siendo obligatorio descargar ambos bundles desde el release inmutable y conservar el recibo de
readback; fabricar localmente archivos con esta forma no demuestra publicación. Ningún gate local actual implica que
las imágenes PULSO históricas hayan sido publicadas o ensayadas.

## Comandos

Validar los catálogos y manifiestos versionados:

```bash
pnpm release:check
pnpm release:test
pnpm contracts:compatibility
```

`release:check` también empaqueta los cinco contratos provider-owned y compara su superficie pública con el último
snapshot en `fixtures/contracts/provider-owned/<package>/<version>.json`. Es un gate local y no autoriza por sí solo
una publicación. La baseline inicial `1.0.0` registra las declaraciones públicas, los subpaths y fingerprints
deterministas de los schemas Zod, pero se identifica como `repository-baseline`: no afirma que ese paquete exista en
un registry.

En cualquier versión, incluidos los cambios de `major`, se permiten exports y símbolos nuevos, pero se rechazan
subpaths o símbolos retirados, tipos que ya no sean asignables al consumidor N-1 y cualquier cambio silencioso de un
schema wire existente. Aumentar el `major` no elimina la ventana N/N-1. El diseño mínimo seguro adoptado exige
conservar la superficie previa; retirar esa superficie queda bloqueado hasta que exista una política de adaptador
cerrada, versionada y validada por este gate. Reutilizar la misma versión exige que toda la superficie permanezca
inmutable. Cada `.tgz` se inspecciona de nuevo: no puede contener `workspace:*`, dependencias Hyperion no exactas ni
artefactos compilados `*.test.*`.

`publish-provider-contract` consulta primero el historial completo del package en el origin npm autorizado. Si el
input no coincide exactamente con la allowlist fija `https://registry.npmjs.org`, el job termina antes de exponer
`NPM_TOKEN`; un dispatcher no puede redirigir la credencial a otro host. Si el package existe, exige primero una
identidad autenticada (`npm whoami`) y selecciona como N-1 la mayor versión SemVer
publicada estrictamente menor que el target, incluso durante una reejecución; el target nunca se hace pasar por su
propio predecesor. Si el target es la primera y única versión, el historial autenticado demuestra que no hay una
versión previa y se conserva la baseline inicial. Un target menor que cualquier versión publicada falla. El
package seleccionado se descarga y se verifican identidad, `gitHead`, URL HTTPS del mismo origin, `dist.integrity`
SHA-512 de los bytes y la attestation GitHub que vincula esos bytes al workflow, commit y `refs/heads/main` exactos.
La comparación sólo continúa si existe
`fixtures/contracts/provider-owned/<package>/<version>.json` con provenance `published-registry` idéntica a esa
evidencia y si los bytes completos de ese JSON tienen su propia attestation GitHub para el mismo workflow/commit/ref.
Así, alterar declaraciones, fingerprints runtime o `contentSha256` conservando la provenance npm no produce un
baseline válido. Un snapshot `repository-baseline` sólo se admite para la primera versión cuando el registry autenticado
termina específicamente en `404` o enumera únicamente ese target en una reejecución; un timeout, error de
autenticación o respuesta exitosa vacía no demuestra ausencia y falla cerrado.

Después del readback de una publicación, el workflow vuelve a resolver el target exacto, compara los bytes remotos
con el `.tgz` local mediante el modo separado `--exact-target` y genera el artefacto
`provider-contract-<package>-<version>-published-registry`. El JSON contenido es el candidato inmutable que debe
tener bytes idénticos a la captura obtenida del mismo tarball; un segundo pack divergente falla cerrado. El workflow
atestigua también el JSON antes de subirlo. El candidato debe
revisarse y agregarse por PR al directorio de fixtures antes de publicar la siguiente versión. Si ya existe la
baseline de desarrollo de esa misma versión, la única promoción admitida cambia su provenance de
`repository-baseline` a `published-registry`: `contentSha256`, manifest, declaraciones y schemas deben permanecer
idénticos. Un snapshot ya promovido es inmutable. `--record-baseline` sólo crea un archivo faltante de desarrollo y
se niega a sobrescribirlo; no sirve como evidencia de registry.

La producción OCI se inicia manualmente con `build-attested-cell-images` sobre `main`. El input
`source_revision` debe coincidir exactamente con `github.sha` y `github.ref_protected` debe ser `true`; una rama
llamada `main` sin branch protection/ruleset falla cerrada. El workflow construye únicamente los servicios del
catálogo de la celda y publica primero el tag candidato único
`candidate-<source_revision>-<run_id>-<run_attempt>`. Captura el digest devuelto por ese mismo `docker push`,
comprueba candidato→digest y `repositorio@digest`, adjunta provenance SLSA al digest y sólo entonces promociona el
tag inmutable `<source_revision>`. La promoción vuelve a comprobar source-tag→digest y nunca sobrescribe un valor
divergente.

Una reejecución que encuentra el tag fuente no reconstruye, no sobrescribe y no vuelve a atestiguar: resuelve su
digest y deja que el job de evidencia verifique criptográficamente el signer, workflow, commit y ref exactos. Por
eso un fallo antes de la promoción es reintentable con otro candidato y uno posterior se reanuda por readback. El
artefacto resultante contiene `image-inventory.json`, `registry-verification.json` y sus checksums.

Los tags por SHA son inmutables por política. Antes de habilitar el environment `release-publication`, la
Organization debe registrar evidencia de la protección de `main` y limitar `packages:write`/delete de cada paquete
GHCR al workflow productor, que debe ser el único writer: ningún usuario, token ni otro workflow puede escribir. Si el registry
seleccionado ofrece inmutabilidad server-side, debe activarse; si GHCR no expone esa política para el plan usado, el
tag no se acepta como identidad de release y el digest firmado sigue siendo la única fuente de verdad. El workflow
detecta carreras antes y después de promover, pero este control externo de permisos sigue siendo requisito de
activación.

Los candidatos no son identidad de release ni se despliegan. Su retención operativa es de 30 días para diagnóstico.
Después, una política de lifecycle o tarea de mantenimiento aprobada puede retirar únicamente tags con prefijo
`candidate-` si no pertenecen a una ejecución activa; antes debe comprobar que cualquier tag fuente asociado y su
provenance permanecen verificables. La limpieza nunca elimina tags fuente, digests referenciados ni attestations. Si
el registry no puede imponer esta selección, la limpieza queda manual y auditada.

`publish-federated-release` también debe despacharse desde `main` protegida con `source_revision` igual al
`github.sha` de la ejecución; una definición ejecutada desde otra ref falla antes de configurar credenciales o
registries. Acepta el inventario OCI y repite el readback de registry. Además descarga cada contrato npm exacto desde
el origin HTTPS autorizado, rechaza tarballs mayores de 64 MiB antes de cargarlos en memoria, verifica el
`dist.integrity` SHA-512 de sus bytes y exige provenance GitHub
que vincule el tarball al mismo commit de `main` mediante `publish-provider-contracts.yml`. Si el paquete, la
integridad o esa attestation no existen, el workflow falla antes de producir `status: "published"`; una coordenada
npm derivada sólo del catálogo no cuenta como evidencia.

Después sella `manifest.json`, los inventarios OCI/npm, ambas verificaciones de provenance y la attestation de
release. La fecha se deriva del commit y los fingerprints se calculan sobre la identidad OCI y los statements SLSA
canónicos, no sobre logs variables de CLI, para que los bytes sean deterministas entre reintentos. El reconciliador
crea o retoma el GitHub Release borrador únicamente cuando tag, target SHA, celda, versión, título, notas, nombres de
assets, bytes y checksums coinciden exactamente. Sube sólo assets ausentes de un borrador; jamás usa
overwrite/clobber. Un release ya publicado e idéntico termina idempotentemente; un asset, tag o metadato divergente
falla cerrado. Un tag huérfano sólo se reutiliza si resuelve exactamente al source SHA.

`publish-provider-contract` publica uno de los cinco contratos provider-owned desde el tag canónico
`contracts/<package-id>/v<version>`. Exige que tag, versión, `main` protegida y `source_revision` coincidan; prueba y
construye la clausura, empaqueta una sola vez e inspecciona el manifest dentro del `.tgz`. La publicación se rechaza
si queda un protocolo `workspace:*` o si una dependencia Hyperion no se convirtió a la versión SemVer exacta de su
proveedor. El workflow atestigua ese mismo tarball antes de enviarlo al registry y, al terminar o reintentarse,
descarga la coordenada publicada y exige igualdad byte a byte, `gitHead`, integridad SHA-512 y provenance del
workflow/commit/ref exactos. Una versión existente divergente nunca se sobrescribe.

`publish-shared-library` aplica el mismo pack único, preflight autenticado, attestation y readback a
`@hyperion/database` y `@hyperion/logger`, desde `shared/<package-id>/v<version>`. Mantiene un workflow separado porque
estas librerías no poseen la comparación N/N−1 ni los snapshots de superficie propios de un contrato. El readback
produce un candidato inmutable de evidencia; no promueve automáticamente el catálogo a `published`.

Los cuatro workflows que mutan registries o releases se serializan con `cancel-in-progress: false`: una ejecución nueva
no cancela otra que ya haya publicado estado. Los estados parciales exactos se reanudan por readback; los divergentes
no se eliminan ni corrigen automáticamente y requieren intervención manual aprobada.

Generar un borrador determinista usando el catálogo más reciente:

```bash
pnpm release:generate -- \
  --cell lumen \
  --release-version 0.2.0-dev.0 \
  --output releases/manifests/lumen/0.2.0-dev.0.json
```

El generador siguiente sólo ilustra la forma del manifiesto. La publicación autorizada ocurre exclusivamente por el
workflow, con una asignación por cada componente OCI y evidencia npm verificada; los contratos npm no se consideran
publicados por aparecer en el catálogo:

```bash
pnpm release:generate -- \
  --cell lumen \
  --release-version 0.2.0 \
  --status published \
  --source-revision <40-character-git-sha> \
  --images-verified \
  --image lumen-service=ghcr.io/hyperionprivate/lumen-service@sha256:<64-hex-oci-digest> \
  --output releases/manifests/lumen/0.2.0.json
```

El generador no sobrescribe archivos salvo que se use explícitamente `--force`.
