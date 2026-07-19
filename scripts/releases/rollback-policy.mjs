import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isSemver } from "./release-model.mjs";

export const ROLLBACK_CELLS = Object.freeze(["nova", "lumen", "pulso"]);

const POLICY_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "cell",
  "policyVersion",
  "catalogVersion",
  "ociComponents",
  "rollbackOciComponents",
  "forwardOnlyOciComponents",
  "migration"
]);
const MIGRATION_KEYS = new Set(["componentId", "sourcePath", "files"]);
const MIGRATION_FILE_KEYS = new Set(["path", "sha256"]);
const COMPONENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MIGRATION_PATH = /^sql\/[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;
const SHA256 = /^(?!0{64}$)[a-f0-9]{64}$/;

export function rollbackPolicyPath(cell, catalogVersion) {
  return `releases/rollback-policies/${cell}/${catalogVersion}.json`;
}

export function validateRollbackPolicy(policy, catalog, { context = "rollback policy" } = {}) {
  const errors = [];
  if (!isRecord(policy)) return [`${context} must be a JSON object`];
  rejectUnknownKeys(policy, POLICY_KEYS, context, errors);
  if (policy.$schema !== "../../schemas/rollback-policy.schema.json") {
    errors.push(`${context}.$schema must be ../../schemas/rollback-policy.schema.json`);
  }
  if (![1, 2].includes(policy.schemaVersion)) errors.push(`${context}.schemaVersion must be 1 or 2`);
  if (!ROLLBACK_CELLS.includes(policy.cell)) {
    errors.push(`${context}.cell must be one of ${ROLLBACK_CELLS.join(", ")}`);
  }
  if (!isSemver(policy.policyVersion)) errors.push(`${context}.policyVersion must be SemVer`);
  if (!isSemver(policy.catalogVersion)) errors.push(`${context}.catalogVersion must be SemVer`);
  if (!isRecord(catalog)) {
    errors.push(`${context} requires a release catalog`);
    return errors;
  }
  if (policy.cell !== catalog.cell) errors.push(`${context}.cell must match catalog cell ${catalog.cell}`);
  if (policy.catalogVersion !== catalog.catalogVersion) {
    errors.push(`${context}.catalogVersion must match catalog version ${catalog.catalogVersion}`);
  }
  if (policy.policyVersion !== catalog.catalogVersion) {
    errors.push(`${context}.policyVersion must match catalog version ${catalog.catalogVersion}`);
  }
  const expectedPolicyPath = rollbackPolicyPath(catalog.cell, catalog.catalogVersion);
  if (catalog.rollbackPolicy !== expectedPolicyPath) {
    errors.push(`${context} requires catalog.rollbackPolicy ${expectedPolicyPath}`);
  }

  const expectedOciComponents = Array.isArray(catalog.components)
    ? catalog.components.filter((component) => component.distribution === "oci")
    : [];
  const expectedOciIds = expectedOciComponents.map((component) => component.id);
  const expectedForwardOnlyIds = expectedOciComponents
    .filter((component) => component.kind === "migrations")
    .map((component) => component.id);
  const expectedRollbackIds = expectedOciComponents
    .filter((component) => component.kind !== "migrations")
    .map((component) => component.id);

  if (policy.schemaVersion === 1) {
    if (policy.rollbackOciComponents !== undefined || policy.forwardOnlyOciComponents !== undefined) {
      errors.push(`${context} schemaVersion 1 cannot declare schemaVersion 2 component partitions`);
    }
    validateComponentList(
      policy.ociComponents,
      expectedOciIds,
      `${context}.ociComponents`,
      "the catalog OCI components in catalog order",
      errors
    );
  } else if (policy.schemaVersion === 2) {
    if (policy.ociComponents !== undefined) {
      errors.push(`${context} schemaVersion 2 cannot declare legacy ociComponents`);
    }
    validateComponentList(
      policy.rollbackOciComponents,
      expectedRollbackIds,
      `${context}.rollbackOciComponents`,
      "the rollbackable runtime OCI components in catalog order",
      errors
    );
    validateComponentList(
      policy.forwardOnlyOciComponents,
      expectedForwardOnlyIds,
      `${context}.forwardOnlyOciComponents`,
      "the forward-only control-plane OCI components in catalog order",
      errors
    );
    const declared = [...(policy.rollbackOciComponents ?? []), ...(policy.forwardOnlyOciComponents ?? [])];
    if (new Set(declared).size !== declared.length) {
      errors.push(`${context} rollback and forward-only component partitions must be disjoint`);
    }
    if (expectedForwardOnlyIds.length === 0) {
      errors.push(`${context} requires at least one forward-only migrations component`);
    }
  }

  validateMigrationPolicy(policy.migration, policy.cell, catalog, context, errors);
  if (
    policy.schemaVersion === 2 &&
    isRecord(policy.migration) &&
    Array.isArray(policy.forwardOnlyOciComponents) &&
    !policy.forwardOnlyOciComponents.includes(policy.migration.componentId)
  ) {
    errors.push(`${context}.migration.componentId must be declared in forwardOnlyOciComponents`);
  }
  return errors;
}

export function rollbackComponentPartitions(policy, catalog) {
  const errors = validateRollbackPolicy(policy, catalog);
  if (errors.length > 0) throw new Error(`Rollback policy is invalid:\n- ${errors.join("\n- ")}`);
  const ociComponents = catalog.components.filter((component) => component.distribution === "oci");
  const byId = new Map(ociComponents.map((component) => [component.id, component]));
  const rollbackOciComponents =
    policy.schemaVersion === 2
      ? [...policy.rollbackOciComponents]
      : policy.ociComponents.filter((id) => byId.get(id)?.kind !== "migrations");
  const forwardOnlyOciComponents =
    policy.schemaVersion === 2
      ? [...policy.forwardOnlyOciComponents]
      : policy.ociComponents.filter((id) => byId.get(id)?.kind === "migrations");
  return Object.freeze({
    rollbackOciComponents: Object.freeze(rollbackOciComponents),
    forwardOnlyOciComponents: Object.freeze(forwardOnlyOciComponents)
  });
}

function validateComponentList(value, expected, context, expectation, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${context} must be a non-empty array`);
    return;
  }
  const ids = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !COMPONENT_ID.test(id)) {
      errors.push(`${context} must contain only kebab-case component ids`);
    } else if (ids.has(id)) {
      errors.push(`${context} contains duplicate component ${id}`);
    }
    ids.add(id);
  }
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    errors.push(`${context} must exactly match ${expectation}`);
  }
}

export async function loadRollbackPolicy(catalog, root) {
  const expectedPath = rollbackPolicyPath(catalog.cell, catalog.catalogVersion);
  if (catalog.rollbackPolicy !== expectedPath) {
    throw new Error(`catalog.rollbackPolicy must be ${expectedPath}`);
  }
  const policyPath = resolveInside(root, expectedPath, "rollback policy");
  const bytes = await readRegularFile(policyPath, "rollback policy");
  const policySha256 = createHash("sha256").update(bytes).digest("hex");
  if (policySha256 !== catalog.rollbackPolicySha256) {
    throw new Error("rollback policy SHA-256 does not match the owning release catalog");
  }
  const policy = parseJson(bytes, "rollback policy");
  const errors = validateRollbackPolicy(policy, catalog, { context: expectedPath });
  if (errors.length > 0) throw new Error(`Rollback policy is invalid:\n- ${errors.join("\n- ")}`);
  return {
    path: policyPath,
    policy,
    sha256: policySha256
  };
}

export async function verifyProviderMigrationManifest(policy, root) {
  const sourcePath = policy?.migration?.sourcePath;
  const sourceDirectory = resolveInside(root, sourcePath, "provider migration source");
  const sqlDirectory = path.join(sourceDirectory, "sql");
  const directoryStat = await lstat(sqlDirectory).catch((error) => {
    if (error?.code === "ENOENT") throw new Error("provider migration sql directory does not exist", { cause: error });
    throw error;
  });
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("provider migration sql directory must be a regular non-symlink directory");
  }

  const entries = (await readdir(sqlDirectory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const actualPaths = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/.test(entry.name)) {
      throw new Error(`provider migration sql directory contains unsupported entry ${entry.name}`);
    }
    actualPaths.push(`sql/${entry.name}`);
  }

  const expectedFiles = policy.migration.files;
  const expectedPaths = expectedFiles.map((entry) => entry.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("provider migration inventory differs from the rollback policy");
  }

  const evidenceLines = [];
  for (const expected of expectedFiles) {
    const filePath = resolveInside(sourceDirectory, expected.path, "provider migration file");
    const bytes = await readRegularFile(filePath, `provider migration ${expected.path}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expected.sha256) {
      throw new Error(`provider migration ${expected.path} SHA-256 differs from the rollback policy`);
    }
    evidenceLines.push(`${expected.path}=${digest}`);
  }
  return {
    count: evidenceLines.length,
    sha256: createHash("sha256")
      .update(`${evidenceLines.join("\n")}\n`)
      .digest("hex")
  };
}

function validateMigrationPolicy(migration, cell, catalog, context, errors) {
  const migrationContext = `${context}.migration`;
  if (!isRecord(migration)) {
    errors.push(`${migrationContext} must be a JSON object`);
    return;
  }
  rejectUnknownKeys(migration, MIGRATION_KEYS, migrationContext, errors);
  const expectedComponentId = `${cell}-migrations`;
  const expectedSourcePath = `packages/${cell}-migrations`;
  if (migration.componentId !== expectedComponentId) {
    errors.push(`${migrationContext}.componentId must be ${expectedComponentId}`);
  }
  if (migration.sourcePath !== expectedSourcePath) {
    errors.push(`${migrationContext}.sourcePath must be ${expectedSourcePath}`);
  }
  const migrationComponents = Array.isArray(catalog.components)
    ? catalog.components.filter((component) => component.kind === "migrations")
    : [];
  if (migrationComponents.length !== 1) {
    errors.push(`${context} requires exactly one provider-owned migrations component`);
  } else {
    const component = migrationComponents[0];
    if (
      component.id !== expectedComponentId ||
      component.distribution !== "oci" ||
      component.sourcePath !== expectedSourcePath
    ) {
      errors.push(`${context} migrations component must be OCI ${expectedComponentId} from ${expectedSourcePath}`);
    }
  }
  if (!Array.isArray(migration.files) || migration.files.length === 0) {
    errors.push(`${migrationContext}.files must be a non-empty array`);
    return;
  }
  const paths = new Set();
  let previousPath = "";
  for (const [index, file] of migration.files.entries()) {
    const fileContext = `${migrationContext}.files[${index}]`;
    if (!isRecord(file)) {
      errors.push(`${fileContext} must be a JSON object`);
      continue;
    }
    rejectUnknownKeys(file, MIGRATION_FILE_KEYS, fileContext, errors);
    if (typeof file.path !== "string" || !MIGRATION_PATH.test(file.path)) {
      errors.push(`${fileContext}.path must be a normalized provider SQL migration path`);
    } else if (paths.has(file.path)) {
      errors.push(`${migrationContext}.files contains duplicate path ${file.path}`);
    } else if (previousPath && file.path.localeCompare(previousPath) <= 0) {
      errors.push(`${migrationContext}.files must be sorted by path`);
    }
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      errors.push(`${fileContext}.sha256 must be an exact non-zero lowercase SHA-256`);
    }
    if (typeof file.path === "string") {
      paths.add(file.path);
      previousPath = file.path;
    }
  }
}

async function readRegularFile(filePath, label) {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist`, { cause: error });
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return readFile(filePath);
}

function resolveInside(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${label} path must be repository-relative`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} path escaped the repository root`);
  }
  return resolved;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`, { cause: error });
  }
}

function rejectUnknownKeys(value, allowed, context, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${context} contains unsupported property ${key}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
