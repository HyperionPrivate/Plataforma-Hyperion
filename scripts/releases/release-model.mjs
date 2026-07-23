import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const RELEASE_CELLS = Object.freeze(["platform", "nova", "lumen", "pulso"]);

const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMPONENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OWNER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?)?$/;
const OCI_REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]*)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const OCI_IMAGE =
  /^(?<repository>[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[1-9][0-9]*)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@sha256:(?<digest>[0-9a-f]{64})$/;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SOURCE_REVISION = /^(?!0{40}$)[0-9a-f]{40}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

const CATALOG_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "cell",
  "catalogVersion",
  "owner",
  "createdAt",
  "rollbackPolicy",
  "rollbackPolicySha256",
  "components"
]);
const CATALOG_COMPONENT_KEYS = new Set([
  "id",
  "kind",
  "distribution",
  "sourcePath",
  "versionSource",
  "version",
  "imageRepository",
  "buildService",
  "composeServices",
  "packageName"
]);
const MANIFEST_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "cell",
  "catalogVersion",
  "releaseVersion",
  "status",
  "generatedAt",
  "releasedAt",
  "sourceRevision",
  "imagesVerified",
  "components"
]);
const MANIFEST_COMPONENT_KEYS = new Set(["id", "version", "image", "package"]);

export function isSemver(value) {
  const match = typeof value === "string" ? value.match(SEMVER) : null;
  if (!match) return false;
  const prerelease = match[4];
  if (!prerelease) return true;
  return prerelease.split(".").every((identifier) => !/^0[0-9]+$/.test(identifier));
}

export function compareSemver(left, right) {
  const leftMatch = left.match(SEMVER);
  const rightMatch = right.match(SEMVER);
  if (!leftMatch || !rightMatch) throw new Error("compareSemver requires valid SemVer values");

  for (let index = 1; index <= 3; index += 1) {
    const difference = BigInt(leftMatch[index]) - BigInt(rightMatch[index]);
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }

  const leftPrerelease = leftMatch[4]?.split(".") ?? [];
  const rightPrerelease = rightMatch[4]?.split(".") ?? [];
  if (leftPrerelease.length === 0 || rightPrerelease.length === 0) {
    return leftPrerelease.length === rightPrerelease.length ? 0 : leftPrerelease.length === 0 ? 1 : -1;
  }

  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPrerelease[index];
    const rightIdentifier = rightPrerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^[0-9]+$/.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function parseOciImageReference(value) {
  const match = typeof value === "string" ? value.match(OCI_IMAGE) : null;
  if (!match?.groups) return null;
  return { repository: match.groups.repository, digest: match.groups.digest };
}

export function parseNpmPackageReference(value) {
  if (typeof value !== "string") return null;
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return null;
  const packageName = value.slice(0, separator);
  const version = value.slice(separator + 1);
  if (!NPM_PACKAGE_NAME.test(packageName) || !isSemver(version)) return null;
  return { packageName, version };
}

export function draftImageReference(cell, catalogVersion, component) {
  if (component.distribution !== "oci") {
    throw new Error(`Draft image references require an OCI component, received ${component.id}`);
  }
  const digest = createHash("sha256")
    .update(`hyperion-unpublished-draft:${cell}:${catalogVersion}:${component.id}:${component.version}`)
    .digest("hex");
  return `${component.imageRepository}@sha256:${digest}`;
}

export function composeServicesForComponent(component) {
  if (component?.distribution !== "oci") return [];
  return Array.isArray(component.composeServices) ? [...component.composeServices] : [component.id];
}

export function buildServiceForComponent(component) {
  if (component?.distribution !== "oci") return null;
  return component.buildService ?? composeServicesForComponent(component)[0] ?? component.id;
}

export function validateCatalog(catalog, { context = "catalog", root } = {}) {
  const errors = [];
  if (!isRecord(catalog)) return [`${context} must be a JSON object`];
  rejectUnknownKeys(catalog, CATALOG_KEYS, context, errors);

  requireEqual(catalog.$schema, "../../schemas/release-catalog.schema.json", `${context}.$schema`, errors);
  requireEqual(catalog.schemaVersion, 1, `${context}.schemaVersion`, errors);
  if (!RELEASE_CELLS.includes(catalog.cell)) errors.push(`${context}.cell must be one of ${RELEASE_CELLS.join(", ")}`);
  if (!isSemver(catalog.catalogVersion)) errors.push(`${context}.catalogVersion must be SemVer`);
  if (typeof catalog.owner !== "string" || !OWNER.test(catalog.owner)) {
    errors.push(`${context}.owner must be a GitHub user or team handle`);
  }
  if (!isUtcTimestamp(catalog.createdAt)) errors.push(`${context}.createdAt must be an ISO-8601 UTC timestamp`);
  if (catalog.rollbackPolicy !== undefined) {
    const expectedRollbackPolicy = `releases/rollback-policies/${catalog.cell}/${catalog.catalogVersion}.json`;
    if (!isSafeRepositoryPath(catalog.rollbackPolicy) || catalog.rollbackPolicy !== expectedRollbackPolicy) {
      errors.push(`${context}.rollbackPolicy must be ${expectedRollbackPolicy}`);
    }
    if (catalog.cell === "platform") errors.push(`${context}.rollbackPolicy is reserved for product cells`);
    if (
      typeof catalog.rollbackPolicySha256 !== "string" ||
      !/^(?!0{64}$)[a-f0-9]{64}$/.test(catalog.rollbackPolicySha256)
    ) {
      errors.push(`${context}.rollbackPolicySha256 must be an exact non-zero lowercase SHA-256`);
    }
  } else if (catalog.rollbackPolicySha256 !== undefined) {
    errors.push(`${context}.rollbackPolicySha256 requires rollbackPolicy`);
  }
  if (!Array.isArray(catalog.components) || catalog.components.length === 0) {
    errors.push(`${context}.components must be a non-empty array`);
    return errors;
  }

  const ids = new Set();
  const imageRepositories = new Map();
  const composeServiceOwners = new Map();
  for (const [index, component] of catalog.components.entries()) {
    const componentContext = `${context}.components[${index}]`;
    if (!isRecord(component)) {
      errors.push(`${componentContext} must be a JSON object`);
      continue;
    }
    rejectUnknownKeys(component, CATALOG_COMPONENT_KEYS, componentContext, errors);
    if (typeof component.id !== "string" || !COMPONENT_ID.test(component.id)) {
      errors.push(`${componentContext}.id must be a kebab-case component id`);
    } else if (ids.has(component.id)) {
      errors.push(`${context}.components contains duplicate id ${component.id}`);
    } else {
      ids.add(component.id);
    }
    if (!["service", "gateway", "bff", "console", "migrations", "contract"].includes(component.kind)) {
      errors.push(`${componentContext}.kind must be service, gateway, bff, console, migrations, or contract`);
    }
    if (!["oci", "npm"].includes(component.distribution)) {
      errors.push(`${componentContext}.distribution must be oci or npm`);
    }
    if (!isSafeRepositoryPath(component.sourcePath)) {
      errors.push(`${componentContext}.sourcePath must be a normalized repository-relative path`);
    }
    if (!isSafeRepositoryPath(component.versionSource) || !component.versionSource?.endsWith("/package.json")) {
      errors.push(`${componentContext}.versionSource must point to a repository package.json`);
    } else if (
      typeof component.sourcePath === "string" &&
      component.versionSource !== `${component.sourcePath}/package.json`
    ) {
      errors.push(`${componentContext}.versionSource must belong to sourcePath`);
    }
    if (!isSemver(component.version)) errors.push(`${componentContext}.version must be SemVer`);
    if (component.distribution === "oci") {
      if (typeof component.imageRepository !== "string" || !OCI_REPOSITORY.test(component.imageRepository)) {
        errors.push(`${componentContext}.imageRepository must be an OCI repository without a tag or digest`);
      } else if (imageRepositories.has(component.imageRepository)) {
        errors.push(
          `${componentContext}.imageRepository duplicates ${imageRepositories.get(component.imageRepository)}; ` +
            "one OCI component must own every Compose alias of the same image"
        );
      } else {
        imageRepositories.set(component.imageRepository, component.id);
      }
      if (component.packageName !== undefined) {
        errors.push(`${componentContext}.packageName is not allowed for OCI components`);
      }
      if (component.kind === "contract") {
        errors.push(`${componentContext}.kind contract must use npm distribution`);
      }
      if (component.buildService !== undefined && !COMPONENT_ID.test(component.buildService)) {
        errors.push(`${componentContext}.buildService must be a kebab-case Compose service`);
      }
      if (component.composeServices !== undefined) {
        if (!Array.isArray(component.composeServices) || component.composeServices.length === 0) {
          errors.push(`${componentContext}.composeServices must be a non-empty array`);
        } else {
          const aliases = new Set();
          for (const service of component.composeServices) {
            if (typeof service !== "string" || !COMPONENT_ID.test(service)) {
              errors.push(`${componentContext}.composeServices must contain only kebab-case Compose services`);
            } else if (aliases.has(service)) {
              errors.push(`${componentContext}.composeServices contains duplicate service ${service}`);
            }
            aliases.add(service);
          }
        }
        if (component.buildService === undefined) {
          errors.push(`${componentContext}.buildService is required when composeServices is declared`);
        }
      }
      const composeServices = composeServicesForComponent(component);
      const buildService = buildServiceForComponent(component);
      if (buildService && !composeServices.includes(buildService)) {
        errors.push(`${componentContext}.buildService must be included in composeServices`);
      }
      for (const service of composeServices.filter((entry) => typeof entry === "string" && COMPONENT_ID.test(entry))) {
        const previousOwner = composeServiceOwners.get(service);
        if (previousOwner) {
          errors.push(`${componentContext}.composeServices duplicates ${service} already owned by ${previousOwner}`);
        } else {
          composeServiceOwners.set(service, component.id);
        }
      }
    } else if (component.distribution === "npm") {
      if (typeof component.packageName !== "string" || !NPM_PACKAGE_NAME.test(component.packageName)) {
        errors.push(`${componentContext}.packageName must be a valid lowercase npm package name`);
      }
      if (component.imageRepository !== undefined) {
        errors.push(`${componentContext}.imageRepository is not allowed for npm components`);
      }
      if (component.buildService !== undefined || component.composeServices !== undefined) {
        errors.push(`${componentContext}.buildService and composeServices are not allowed for npm components`);
      }
      if (component.kind !== "contract") {
        errors.push(`${componentContext}.distribution npm is reserved for contract components`);
      }
    }
  }
  if (root) errors.push(...validateCatalogSources(catalog, { context, root }));
  return errors;
}

export function validateCatalogSources(catalog, { context = "catalog", root } = {}) {
  const errors = [];
  if (!root || !isRecord(catalog) || !Array.isArray(catalog.components)) return errors;
  for (const [index, component] of catalog.components.entries()) {
    if (!isRecord(component)) continue;
    const componentContext = `${context}.components[${index}]`;
    if (isSafeRepositoryPath(component.sourcePath)) {
      validateExistingPath(root, component.sourcePath, `${componentContext}.sourcePath`, errors);
    }
    if (isSafeRepositoryPath(component.versionSource)) {
      validateExistingPath(root, component.versionSource, `${componentContext}.versionSource`, errors);
      validateVersionSource(root, component, componentContext, errors);
    }
  }
  return errors;
}

export function validateManifest(manifest, catalog, { context = "manifest", publishable = false } = {}) {
  const errors = [];
  if (!isRecord(manifest)) return [`${context} must be a JSON object`];
  rejectUnknownKeys(manifest, MANIFEST_KEYS, context, errors);

  requireEqual(manifest.$schema, "../../schemas/release-manifest.schema.json", `${context}.$schema`, errors);
  requireEqual(manifest.schemaVersion, 1, `${context}.schemaVersion`, errors);
  if (!RELEASE_CELLS.includes(manifest.cell)) errors.push(`${context}.cell must be one of ${RELEASE_CELLS.join(", ")}`);
  if (!isSemver(manifest.catalogVersion)) errors.push(`${context}.catalogVersion must be SemVer`);
  if (!isSemver(manifest.releaseVersion)) errors.push(`${context}.releaseVersion must be SemVer`);
  if (!["draft", "published"].includes(manifest.status)) errors.push(`${context}.status must be draft or published`);
  if (!isUtcTimestamp(manifest.generatedAt)) errors.push(`${context}.generatedAt must be an ISO-8601 UTC timestamp`);
  if (typeof manifest.imagesVerified !== "boolean") errors.push(`${context}.imagesVerified must be boolean`);
  if (manifest.sourceRevision !== undefined && !SOURCE_REVISION.test(manifest.sourceRevision)) {
    errors.push(`${context}.sourceRevision must be a non-zero 40-character lowercase Git SHA`);
  }
  if (manifest.releasedAt !== undefined && !isUtcTimestamp(manifest.releasedAt)) {
    errors.push(`${context}.releasedAt must be an ISO-8601 UTC timestamp`);
  }
  if (manifest.status === "draft" && manifest.releasedAt !== undefined) {
    errors.push(`${context}.releasedAt is only allowed for published manifests`);
  }
  if (manifest.status === "published") {
    if (!SOURCE_REVISION.test(manifest.sourceRevision ?? ""))
      errors.push(`${context}.sourceRevision is required when published`);
    if (!isUtcTimestamp(manifest.releasedAt)) errors.push(`${context}.releasedAt is required when published`);
    if (manifest.imagesVerified !== true) errors.push(`${context}.imagesVerified must be true when published`);
    if (
      isUtcTimestamp(manifest.generatedAt) &&
      isUtcTimestamp(manifest.releasedAt) &&
      Date.parse(manifest.releasedAt) < Date.parse(manifest.generatedAt)
    ) {
      errors.push(`${context}.releasedAt cannot be earlier than generatedAt`);
    }
  }
  if (publishable && manifest.status !== "published")
    errors.push(`${context} is not publishable because status is not published`);

  if (!isRecord(catalog) || !Array.isArray(catalog.components)) {
    errors.push(`${context} cannot be checked without a valid catalog`);
    return errors;
  }
  if (manifest.cell !== catalog.cell) errors.push(`${context}.cell does not match catalog cell ${catalog.cell}`);
  if (manifest.catalogVersion !== catalog.catalogVersion) {
    errors.push(`${context}.catalogVersion does not match catalog version ${catalog.catalogVersion}`);
  }
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    errors.push(`${context}.components must be a non-empty array`);
    return errors;
  }

  const catalogById = new Map(catalog.components.map((component) => [component.id, component]));
  const ids = new Set();
  for (const [index, component] of manifest.components.entries()) {
    const componentContext = `${context}.components[${index}]`;
    if (!isRecord(component)) {
      errors.push(`${componentContext} must be a JSON object`);
      continue;
    }
    rejectUnknownKeys(component, MANIFEST_COMPONENT_KEYS, componentContext, errors);
    if (typeof component.id !== "string" || !COMPONENT_ID.test(component.id)) {
      errors.push(`${componentContext}.id must be a kebab-case component id`);
      continue;
    }
    if (ids.has(component.id)) errors.push(`${context}.components contains duplicate id ${component.id}`);
    ids.add(component.id);

    const catalogComponent = catalogById.get(component.id);
    if (!catalogComponent) {
      errors.push(`${componentContext}.id is not present in catalog ${catalog.cell}@${catalog.catalogVersion}`);
      continue;
    }
    if (!isSemver(component.version)) errors.push(`${componentContext}.version must be SemVer`);
    if (component.version !== catalogComponent.version) {
      errors.push(`${componentContext}.version must equal catalog version ${catalogComponent.version}`);
    }

    if (catalogComponent.distribution === "oci") {
      if (component.package !== undefined) {
        errors.push(`${componentContext}.package is not allowed for an OCI component`);
      }
      const parsedImage = parseOciImageReference(component.image);
      if (!parsedImage) {
        errors.push(`${componentContext}.image must be an OCI reference pinned by sha256 digest`);
      } else {
        if (parsedImage.repository !== catalogComponent.imageRepository) {
          errors.push(`${componentContext}.image repository must be ${catalogComponent.imageRepository}`);
        }
        if (/^0{64}$/.test(parsedImage.digest)) errors.push(`${componentContext}.image digest cannot be all zeros`);
        if (
          manifest.status === "published" &&
          component.image === draftImageReference(catalog.cell, catalog.catalogVersion, catalogComponent)
        ) {
          errors.push(`${componentContext}.image still uses the unpublished draft digest`);
        }
      }
    } else if (catalogComponent.distribution === "npm") {
      if (component.image !== undefined) {
        errors.push(`${componentContext}.image is not allowed for an npm component`);
      }
      const parsedPackage = parseNpmPackageReference(component.package);
      if (!parsedPackage) {
        errors.push(`${componentContext}.package must be an exact npm package@version reference`);
      } else {
        if (parsedPackage.packageName !== catalogComponent.packageName) {
          errors.push(`${componentContext}.package name must be ${catalogComponent.packageName}`);
        }
        if (parsedPackage.version !== catalogComponent.version) {
          errors.push(`${componentContext}.package version must be ${catalogComponent.version}`);
        }
      }
    }
  }

  for (const component of catalog.components) {
    if (!ids.has(component.id)) errors.push(`${context}.components is missing catalog component ${component.id}`);
  }
  if (manifest.components.length !== catalog.components.length) {
    errors.push(`${context}.components must contain exactly ${catalog.components.length} catalog components`);
  }
  for (const [index, component] of catalog.components.entries()) {
    if (manifest.components[index]?.id !== component.id) {
      errors.push(`${context}.components must preserve catalog order; expected ${component.id} at index ${index}`);
    }
  }
  return errors;
}

export function assertValid(errors, message = "Release data is invalid") {
  if (errors.length > 0) throw new Error(`${message}:\n- ${errors.join("\n- ")}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, context, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${context} contains unsupported property ${key}`);
  }
}

function requireEqual(actual, expected, context, errors) {
  if (actual !== expected) errors.push(`${context} must equal ${JSON.stringify(expected)}`);
}

function isUtcTimestamp(value) {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function isSafeRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "." && segment !== ".." && SAFE_PATH_SEGMENT.test(segment));
}

function validateExistingPath(root, relativePath, context, errors) {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    errors.push(`${context} escapes the repository root`);
  } else if (!existsSync(absolutePath)) {
    errors.push(`${context} does not exist: ${relativePath}`);
  }
}

function validateVersionSource(root, component, context, errors) {
  const absolutePath = path.resolve(root, component.versionSource);
  let packageManifest;
  try {
    packageManifest = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(`${context}.versionSource cannot be read as JSON: ${error.message}`);
    return;
  }
  if (packageManifest.version !== component.version) {
    errors.push(`${context}.version must match ${component.versionSource} (${packageManifest.version ?? "missing"})`);
  }
  if (component.distribution === "npm" && packageManifest.name !== component.packageName) {
    errors.push(`${context}.packageName must match ${component.versionSource} (${packageManifest.name ?? "missing"})`);
  }
}
