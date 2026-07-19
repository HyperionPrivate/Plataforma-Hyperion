---
documentType: runbook
status: draft
owner: platform-release
issue: HYP-FED-002
reviewDue: 2026-09-30
---

# Publicación de librerías compartidas

Este runbook publica `@hyperion/database` o `@hyperion/logger` sin sobrescribir una coordenada npm existente. La
publicación autorizada ocurre únicamente mediante
[`publish-shared-libraries.yml`](../../.github/workflows/publish-shared-libraries.yml). El estado `ready` del
[catálogo](../../releases/registry/provider-artifacts.v1.json) significa que el flujo está preparado; no significa que
el paquete exista en el registry.

## Prerrequisitos

- `main` está protegida y el despacho se inicia desde `refs/heads/main`.
- El environment `release-publication` tiene aprobación requerida y `NPM_TOKEN` con permiso de publicación para el
  scope `@hyperion`.
- El manifest fuente y el catálogo declaran la misma versión estable exacta.
- Existe el tag canónico `shared/database/v<version>` o `shared/logger/v<version>` y resuelve al mismo commit de
  `main` que se va a publicar.
- Ese commit ha pasado `pnpm release:test`, `pnpm release:check` y los checks requeridos de la celda afectada.

No crear ni mover el tag después de iniciar la publicación. npm no admite sobrescribir una combinación
`packageName@version`; ante una divergencia se debe publicar una versión nueva.

## Despacho

Registrar el SHA exacto antes de crear el tag y obtener revisión humana para ambos valores. El operador autorizado
puede despachar el workflow desde GitHub Actions o con el equivalente siguiente:

```bash
gh workflow run publish-shared-libraries.yml \
  --ref main \
  -f library=database \
  -f version=0.1.0 \
  -f source_revision=<protected-main-40-character-sha> \
  -f registry_origin=https://registry.npmjs.org
```

Repetir con `library=logger` solo después de revisar el resultado de Database. El workflow rechaza refs no
protegidas, un SHA distinto de `github.sha`, un tag que no apunte al SHA y cualquier origin diferente del allowlist.

## Controles ejecutados

El workflow instala el lockfile, construye únicamente la clausura del paquete y ejecuta build, typecheck, test, lint y
format. Después:

1. copia solo archivos regulares de `dist/**`, sin enlaces simbólicos, a un staging fuera del repositorio;
2. genera allí un `package.json` con `gitHead` igual al SHA protegido, sin modificar el manifest fuente;
3. ejecuta un único `pnpm pack`, limita el `.tgz` a 64 MiB e inspecciona su inventario y manifest;
4. rechaza `workspace:`, `file:`, `link:`, aliases npm a Hyperion, hooks de instalación/empaquetado/publicación,
   opciones `publishConfig` no allowlisted y dependencias Hyperion que no sean SemVer exacto del catálogo;
5. autentica primero contra npm y publica solo si un `E404` inequívoco demuestra que la versión no existe;
6. atestigua y publica exactamente el mismo `.tgz`;
7. vuelve a descargar la coordenada y exige igualdad byte a byte, integridad SHA-512, `gitHead` y attestation ligada
   al workflow, SHA y `refs/heads/main` exactos.

No publicar el directorio ni volver a empaquetar el candidato entre attestation, publish y readback.

## Evidencia y promoción del catálogo

Descargar el artifact `shared-library-<library>-<version>-registry-evidence` de la ejecución. Revisar que su JSON y su
attestation correspondan al paquete, versión, repository, SHA, workflow, origin, URL del tarball, SHA-512, SHA-256 y
builder esperados. El artifact es solo un candidato: una PR separada debe cambiar `publication.state` a `published` e
incorporar exactamente `publication.registryEvidence`; no editar ni inventar campos a partir de logs.

Después de fusionar esa PR, ejecutar en orden:

```bash
pnpm contracts:registry:check
pnpm contracts:registry:nova-extraction
pnpm contracts:registry:nova-readback
```

El segundo comando es el gate offline de declaraciones; el tercero repite el readback vivo de todas las dependencias
externas de NOVA. La extracción no está autorizada si alguno falla.

## Reintentos y fallos parciales

- Si la publicación no ocurrió, se puede repetir el mismo workflow con SHA, tag y versión idénticos.
- Si npm ya contiene la versión, el workflow no vuelve a publicarla: empaqueta otra vez desde el mismo SHA y exige que
  los bytes descargados sean idénticos. Esto permite recuperar un fallo posterior al publish.
- Si la versión existente difiere en bytes, `gitHead`, metadata o provenance, detener el corte. No usar `--force`,
  `npm unpublish`, `npm deprecate` ni mover el tag.
- Si solo falló la disponibilidad eventual de metadata o attestation, el readback aplica reintentos acotados. Una
  nueva ejecución sigue siendo segura siempre que los inputs permanezcan idénticos.
- Conservar Database y Logger en `ready` hasta que la publicación y el readback hayan terminado y la evidencia haya
  sido revisada. No hay publicación ni promoción automática desde este repositorio.
