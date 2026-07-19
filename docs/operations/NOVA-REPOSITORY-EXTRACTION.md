---
documentType: runbook
status: draft
owner: nova-core
issue: HYP-FED-003
reviewDue: 2026-10-31
---

# Extracción de NOVA con historial preservado

Este runbook prepara el primer repositorio federado. El manifest y el rehearsal local están implementados, pero el
corte sigue bloqueado hasta que exista un commit candidato limpio y todos los artefactos externos tengan publicación y
readback verificables. Este documento no autoriza publicar paquetes, crear el repositorio remoto ni ejecutar `push`.
Esas operaciones requieren `main` protegida, aprobación del environment de release y un repositorio vacío dentro de
la Organization.

La fuente normativa de versiones y estado de publicación es
[`provider-artifacts.v1.json`](../../releases/registry/provider-artifacts.v1.json). El estado `ready` significa que el
artefacto puede entrar al workflow; no significa que exista en npm. El gate de catálogo y el readback vivo son gates
distintos y ambos deben pasar.

La selección reproducible de paths y linaje está versionada en
[`nova-repository-extraction.v1.json`](../../scripts/federation/nova-repository-extraction.v1.json). No se mantiene una
segunda lista manual de `--path` en este runbook.

## 1. Fijar el candidato y congelar artefactos externos

Desde un checkout limpio del commit candidato:

```powershell
$sourceRoot = (git rev-parse --show-toplevel).Trim()
$sourceRef = "refs/heads/main"
$sourceSha = (git rev-parse --verify "$sourceRef^{commit}").Trim()

if (git status --porcelain=v1 --untracked-files=all) {
  throw "El commit candidato debe estar completamente limpio"
}

corepack enable
pnpm install --frozen-lockfile
pnpm release:test
pnpm release:check
```

`release:check` debe mostrar una comparación real `1.0.0 -> 1.1.0` para cada contrato. Un resultado
`1.1.0 -> 1.1.0` no es evidencia N/N−1 y bloquea el corte.

Los contratos se publican desde `publish-provider-contracts.yml`, por tag canónico y desde el mismo commit protegido,
en este orden:

1. `@hyperion/platform-contracts@1.1.0`;
2. `@hyperion/audit-contracts@1.1.0`;
3. `@hyperion/nova-contracts@1.1.0`.

LUMEN y PULSO pueden publicar sus contratos después de Platform. No se debe publicar Audit o NOVA si su dependencia
exacta todavía no tiene readback en el registry.

`@hyperion/database@0.1.0` y `@hyperion/logger@0.1.0` también son dependencias externas. Su estado `ready` solo indica
que existe una ruta de publicación; no se sustituye la falta de un estado `published` verificado con `workspace:*`,
rangos, copias de tarballs ni evidencia fabricada localmente.

Después de cada publicación, registrar únicamente evidencia devuelta por el registry y ejecutar los dos gates en este
orden:

```powershell
# Gate offline: valida catálogo, estados y forma de la evidencia declarada. No accede al registry.
pnpm contracts:registry:nova-extraction

# Gate vivo: npm view + npm pack, bytes/SHA-512, tarball, gitHead y attestation de GitHub.
pnpm contracts:registry:nova-readback
```

El primer comando no prueba existencia ni bytes remotos. El segundo debe leer los cuatro artefactos externos desde el
registry autorizado y verificar su provenance contra el commit de origen. Mientras cualquiera falle, la extracción
queda bloqueada; no existe un modo de excepción.

## 2. Ejecutar el rehearsal aislado

Se requiere `git-filter-repo`. El rehearsal exige el ref completo, el SHA exacto y un worktree limpio. Crea un bare
single-branch bajo un directorio temporal nuevo, elimina inmediatamente `origin`, filtra desde el manifest, ejecuta
`git fsck --full --strict` y valida `commit-map`, `ref-map`, paths, autores, fechas y linaje. Rechaza repositorios
shallow, parciales o promisor-backed, elimina del entorno todas las variables `GIT_*` heredadas antes de cada spawn y
desactiva lazy fetch. Nunca resuelve ni escribe un remoto configurado.

```powershell
$outputParent = Join-Path ([IO.Path]::GetTempPath()) "hyperion-nova-rehearsals"
New-Item -ItemType Directory -Force -Path $outputParent | Out-Null

node scripts/federation/rehearse-nova-repository-extraction.mjs `
  --source-repository $sourceRoot `
  --source-ref $sourceRef `
  --expected-source-sha $sourceSha `
  --output-parent $outputParent
```

La salida `NOVA_EXTRACTION_REPORT` apunta a evidencia JSON y el directorio se conserva para inspección. El estado
`filtered-history-only` no certifica autonomía: el commit de adaptación de la sección siguiente aún es obligatorio.
El manifest debe estar en `scripts/federation/nova-repository-extraction.v1.json` dentro del checkout y sus bytes deben
coincidir exactamente con el blob del SHA candidato. El reporte usa rutas relativas deterministas y registra SHA-256
del archivo de paths, `commit-map` y `ref-map`, además de los identificadores de versión de Git y `git-filter-repo`.

El manifest incluye:

- los doce paquetes/aplicaciones/servicios NOVA;
- fixtures, releases, documentación, seguridad, CI, Docker y operaciones necesarios para adaptar el repositorio;
- renames históricos desde `web-console` y las migraciones globales `047`–`052`;
- paths `ancestry-only` para Contracts, Config, Durable Events y Service Runtime, donde el origen y el destino
  coexistían y un rename directo colisionaría;
- prefijos de LUMEN/PULSO que deben estar ausentes del HEAD filtrado.

Además de esos prefijos, todo path del HEAD filtrado debe quedar cubierto por la allowlist total del manifest. La
allowlist de tags de schema v1 es vacía: el rehearsal clona `--no-tags`, conserva un único ref de branch y no prepara
ningún tag para publicación.

El rehearsal no se debe ejecutar contra el worktree mientras tenga cambios sin commit. Tampoco instala dependencias,
crea el repositorio remoto, publica artefactos o hace `push`.

## 3. Commit de adaptación en el repositorio filtrado

Clonar localmente el bare indicado en el reporte, eliminar su `origin` local y crear un commit de adaptación antes de
añadir cualquier remoto externo:

```powershell
$reportPath = "<valor emitido en NOVA_EXTRACTION_REPORT>"
$report = Get-Content -Raw $reportPath | ConvertFrom-Json
$rehearsalRoot = [IO.Path]::GetFullPath((Split-Path -Parent $reportPath))
$rehearsalPrefix = $rehearsalRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if ($report.filtered.ref -ne "refs/heads/main" -or $report.publication.tagAllowlist.Count -ne 0) {
  throw "El reporte no corresponde al único ref y a la allowlist de tags vacía de schema v1"
}

foreach ($evidence in @($report.evidence.pathsFile, $report.evidence.commitMap, $report.evidence.refMap)) {
  $evidencePath = [IO.Path]::GetFullPath((Join-Path $rehearsalRoot $evidence.path))
  if (-not $evidencePath.StartsWith($rehearsalPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Una ruta de evidencia sale del directorio del rehearsal"
  }
  if (-not (Test-Path -LiteralPath $evidencePath -PathType Leaf)) {
    throw "Falta evidencia: $($evidence.path)"
  }
  $actualHash = (Get-FileHash -LiteralPath $evidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $evidence.sha256) {
    throw "Hash de evidencia inválido: $($evidence.path)"
  }
}

$bareRoot = Join-Path $rehearsalRoot $report.artifacts.bareRepository
$workRoot = Join-Path $rehearsalRoot "nova-work"
git clone --no-local --no-tags --single-branch --branch main -- $bareRoot $workRoot
git -C $workRoot remote remove origin
if (git -C $workRoot remote) { throw "El clone de adaptación no debe conservar remotos" }
$actualFilteredSha = (git -C $workRoot rev-parse --verify "refs/heads/main^{commit}").Trim()
if ($actualFilteredSha -ne $report.filtered.sha) { throw "El SHA clonado no coincide con el reporte" }
if ((git -C $workRoot symbolic-ref HEAD).Trim() -ne "refs/heads/main") { throw "HEAD no apunta a main" }
$refs = @(git -C $workRoot for-each-ref --format="%(refname)")
if ($refs.Count -ne 1 -or $refs[0] -ne "refs/heads/main") { throw "El clone contiene refs no autorizados" }
git -C $workRoot fsck --full --strict
```

El commit debe:

- reducir `pnpm-workspace.yaml` a los paquetes NOVA y mantener `linkWorkspacePackages: true` para desarrollo local;
- retirar scripts, filtros de impacto y workflows de otras celdas del `package.json` raíz;
- convertir `nova.yml` en un workflow autónomo, sin depender de `_cell-ci.yml` del monorepo;
- conservar versiones exactas para Platform Contracts, Audit Contracts, Database y Logger;
- eliminar del HEAD todos los paths `ancestry-only`, conservándolos únicamente en la historia filtrada;
- adaptar `infra/docker/cells/nova.Dockerfile`, `infra/docker/console.nginx.conf.template`, ambos Compose y sus env examples;
- reescribir el generador Docker para instalar externos publicados, sin copiar fuentes Platform/Audit/Database/Logger;
- generar Docker desde la clausura NOVA y confirmar que no contiene fuentes, rutas o artefactos LUMEN/PULSO;
- adaptar los scripts CI, release, docs, backup, restore, recovery y rollback a NOVA solamente;
- mantener Coopfuturo como aplicación cliente específica, no como consola NOVA genérica.

Los paquetes que se mueven juntos dentro del repositorio NOVA pueden conservar `workspace:*`. Toda dependencia
`@hyperion/*` que quede fuera del repositorio debe ser una versión SemVer exacta presente en el catálogo.

El `pnpm-lock.yaml` del monorepo no es portable: varias dependencias exactas fueron resueltas como links locales. Solo
después de que los cuatro externos pasen el readback vivo se debe regenerar el lockfile en el clone adaptado, revisar
que no existan links externos y, desde entonces, exigir `pnpm install --frozen-lockfile`.

## 4. Verificar historia y autonomía

El rehearsal ya exige que cada commit fuente mapeado pertenezca al historial del path filtrado y compara identidades y
timestamps. Esto cubre ambos lados de cada rename, cada origen `ancestry-only`, el historial posterior de todos sus
destinos, los cuatro servicios y Coopfuturo. Conservar el reporte, `commit-map` y `ref-map` como evidencia del corte.
Después del commit de adaptación ejecutar:

```powershell
git fsck --full --strict
git log --follow -- services/nova-core-service/src/app.ts
git log --follow -- apps/coopfuturo-console/package.json
git log --follow -- apps/nova-console/src/pages/NovaPage.tsx
git log --follow -- packages/nova-migrations/sql/047-nova-autonomy.sql
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Además:

- comprobar con `git ls-tree` que el HEAD no contiene paths hermanos;
- analizar todos los `package.json` y rechazar dependencias LUMEN/PULSO o `workspace:*` externas;
- ejecutar los gates de imports y fronteras sobre código productivo;
- verificar manifest y hashes de los contextos NOVA y Coopfuturo;
- repetir la aceptación PostgreSQL, backup/restore y rollback;
- construir cada imagen y ejecutar el smoke con PULSO y LUMEN apagados;
- buscar rutas, endpoints, CSS, textos y chunks hermanos dentro de los bundles producidos.

## 5. Crear y publicar el repositorio

Solo después de los gates anteriores:

1. crear un repositorio vacío `nova` en la Organization, sin README ni commit inicial;
2. proteger `main` con CODEOWNER, checks y conversaciones resueltas;
3. obtener aprobación explícita sobre la URL, el SHA adaptado de `main` y la allowlist de tags vacía de schema v1;
4. añadir el remoto únicamente al clone adaptado y leer de vuelta la URL exacta;
5. publicar únicamente `refs/heads/main:refs/heads/main` mediante un push explícito y atómico;
6. clonar desde el nuevo remoto, comprobar SHA/refs y repetir todos los checks;
7. retirar cualquier dependencia `workspace:*` externa antes del primer release.

Ejemplo de forma autorizable para schema v1, sin tags:

```powershell
git -C $workRoot remote add nova <organization-empty-nova-repository>
git -C $workRoot remote get-url --all nova
git -C $workRoot push --atomic nova refs/heads/main:refs/heads/main
```

Está prohibido `git push --mirror`: podría publicar refs históricos no aprobados o eliminar refs del destino. Nunca se
publican branches, tags, replace refs ni metadatos de `filter-repo` por inferencia.

Un tag futuro exige una revisión versionada del manifest y tooling que lo clone, filtre y verifique explícitamente
antes de autorizar su refspec. No se puede ampliar la allowlist vacía durante el push inicial.

Conservar el monorepo como fuente de redirects durante la convivencia. El corte de tráfico y la eliminación de rutas
legacy son actividades separadas y requieren telemetría de redirects.
