import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { compareSemver, isSemver, RELEASE_CELLS } from "./release-model.mjs";

export const RELEASE_IDENTITY_PATH = "releases/registry/repository-identity.v1.json";

const IDENTITY_KEYS = new Set([
  "schemaVersion",
  "githubOrganization",
  "githubRepository",
  "ghcrNamespace",
  "npmRegistryOrigin",
  "releaseEnvironment",
  "releaseCells",
  "ownershipState",
  "cellOwners",
  "governanceOwners"
]);
const GOVERNANCE_OWNER_KEYS = Object.freeze(["architecture", "releaseSecurity"]);
const OWNERSHIP_STATES = new Set(["pending-repository-access", "verified-repository-access"]);
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const GHCR_NAMESPACE = /^ghcr\.io\/[a-z0-9](?:[a-z0-9-]{0,38})$/;
const RELEASE_ENVIRONMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

export async function loadReleaseIdentity(root) {
  const contents = await readFile(path.join(root, RELEASE_IDENTITY_PATH), "utf8");
  return JSON.parse(contents);
}

export function validateReleaseIdentity(identity, { context = RELEASE_IDENTITY_PATH } = {}) {
  const errors = [];
  if (!isRecord(identity)) return [`${context} must be a JSON object`];

  rejectUnknownKeys(identity, IDENTITY_KEYS, context, errors);
  if (identity.schemaVersion !== 1) errors.push(`${context}.schemaVersion must be 1`);
  if (typeof identity.githubOrganization !== "string" || !GITHUB_NAME.test(identity.githubOrganization)) {
    errors.push(`${context}.githubOrganization must be a GitHub organization login`);
  }
  if (typeof identity.githubRepository !== "string" || !GITHUB_REPOSITORY.test(identity.githubRepository)) {
    errors.push(`${context}.githubRepository must use owner/repository syntax`);
  } else if (identity.githubRepository.split("/")[0] !== identity.githubOrganization) {
    errors.push(`${context}.githubRepository owner must match githubOrganization`);
  }

  if (typeof identity.ghcrNamespace !== "string" || !GHCR_NAMESPACE.test(identity.ghcrNamespace)) {
    errors.push(`${context}.ghcrNamespace must be a lowercase ghcr.io organization namespace`);
  } else if (
    typeof identity.githubOrganization === "string" &&
    identity.ghcrNamespace !== `ghcr.io/${identity.githubOrganization.toLowerCase()}`
  ) {
    errors.push(`${context}.ghcrNamespace must belong to githubOrganization`);
  }

  if (identity.npmRegistryOrigin !== "https://registry.npmjs.org") {
    errors.push(`${context}.npmRegistryOrigin must be https://registry.npmjs.org`);
  }
  if (typeof identity.releaseEnvironment !== "string" || !RELEASE_ENVIRONMENT.test(identity.releaseEnvironment)) {
    errors.push(`${context}.releaseEnvironment must be a safe GitHub environment name`);
  }

  if (
    !Array.isArray(identity.releaseCells) ||
    identity.releaseCells.length === 0 ||
    identity.releaseCells.some((cell) => !RELEASE_CELLS.includes(cell)) ||
    new Set(identity.releaseCells).size !== identity.releaseCells.length
  ) {
    errors.push(`${context}.releaseCells must contain unique known release cells`);
  }
  if (!OWNERSHIP_STATES.has(identity.ownershipState)) {
    errors.push(`${context}.ownershipState must be pending-repository-access or verified-repository-access`);
  }

  validateOwnerMap(
    identity.cellOwners,
    Array.isArray(identity.releaseCells) ? identity.releaseCells : [],
    identity.githubOrganization,
    `${context}.cellOwners`,
    errors
  );
  validateOwnerMap(
    identity.governanceOwners,
    GOVERNANCE_OWNER_KEYS,
    identity.githubOrganization,
    `${context}.governanceOwners`,
    errors
  );

  if (/administracionhyperion/i.test(JSON.stringify(identity))) {
    errors.push(`${context} still contains the retired AdministracionHyperion identity`);
  }
  return errors;
}

export async function readLatestReleaseCatalog(root, cell) {
  if (!RELEASE_CELLS.includes(cell)) throw new Error(`Unknown release cell ${JSON.stringify(cell)}`);
  const directory = path.join(root, "releases", "catalogs", cell);
  const versions = (await readdir(directory))
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -5))
    .filter(isSemver)
    .sort(compareSemver);
  if (versions.length === 0) throw new Error(`No release catalog found for ${cell}`);
  const version = versions.at(-1);
  const catalog = JSON.parse(await readFile(path.join(directory, `${version}.json`), "utf8"));
  return { catalog, version };
}

export function validateCatalogReleaseIdentity(identity, catalog, { context = "release catalog" } = {}) {
  const errors = [];
  if (!isRecord(catalog)) return [`${context} must be a JSON object`];
  if (!identity?.releaseCells?.includes(catalog.cell)) {
    errors.push(`${context}.cell ${String(catalog.cell)} is outside the canonical release identity scope`);
  }
  const expectedOwner = identity?.cellOwners?.[catalog.cell];
  if (!expectedOwner) errors.push(`${context} has no canonical owner for cell ${String(catalog.cell)}`);
  else if (catalog.owner !== expectedOwner) errors.push(`${context}.owner must be ${expectedOwner}`);

  const imagePrefix = `${identity?.ghcrNamespace ?? ""}/`;
  const ociComponents = Array.isArray(catalog.components)
    ? catalog.components.filter((component) => component?.distribution === "oci")
    : [];
  if (ociComponents.length === 0) errors.push(`${context} must declare at least one OCI component`);
  for (const component of ociComponents) {
    if (typeof component.imageRepository !== "string" || !component.imageRepository.startsWith(imagePrefix)) {
      errors.push(`${context}.components.${String(component?.id)}.imageRepository must start with ${imagePrefix}`);
    }
  }
  if (/administracionhyperion/i.test(JSON.stringify(catalog))) {
    errors.push(`${context} still contains the retired AdministracionHyperion identity`);
  }
  return errors;
}

export function releaseIdentityOwnerHandles(identity) {
  return [
    ...new Set([...Object.values(identity?.cellOwners ?? {}), ...Object.values(identity?.governanceOwners ?? {})])
  ];
}

export function releaseIdentityTeamSlug(handle, organization) {
  if (typeof handle !== "string" || typeof organization !== "string") return null;
  const match = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,99}))$/.exec(handle);
  if (!match || match[1] !== organization) return null;
  return match[2];
}

function validateOwnerMap(value, expectedKeys, organization, context, errors) {
  if (!isRecord(value)) {
    errors.push(`${context} must be an object`);
    return;
  }
  const expected = new Set(expectedKeys);
  rejectUnknownKeys(value, expected, context, errors);
  for (const key of expectedKeys) {
    const handle = value[key];
    if (typeof handle !== "string" || handle !== `@${organization}/${teamSlug(handle)}`) {
      errors.push(`${context}.${key} must be a team handle under @${String(organization)}`);
    }
  }
}

function teamSlug(handle) {
  if (typeof handle !== "string") return "";
  const match = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,99}))$/.exec(handle);
  return match?.[1] ?? "";
}

function rejectUnknownKeys(value, allowed, context, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${context}.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (!(key in value)) errors.push(`${context}.${key} is required`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
