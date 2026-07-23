#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const standaloneComposeTemplate = path.join(repositoryRoot, "infra", "docker-compose.pulso.yml");
const environmentExample = path.join(repositoryRoot, "infra", "pulso.env.example");
const backupWrapper = path.join(scriptDirectory, "pulso-postgres-backup.sh");
const restoreWrapper = path.join(scriptDirectory, "pulso-postgres-restore.sh");

export const DRILL_CONFIRMATION = "RUN ISOLATED PULSO POSTGRES RECOVERY DRILL";
export const PROJECT_PREFIX = "hyperion-pulso-recovery-acceptance";
export const EXPECTED_MIGRATIONS = [
  "001-pulso-autonomous-baseline.sql",
  "002-pulso-runtime-roles.sql",
  "003-sofia-readiness-marker.sql",
  "004-access-channel-tenant-projection.sql",
  "005-access-iris-tenant-projection.sql",
  "006-access-sofia-tenant-projection.sql",
  "007-access-integration-tenant-projection.sql",
  "008-access-knowledge-tenant-projection.sql",
  "009-contract-channel-access-tenant-fks.sql",
  "010-contract-integration-access-tenant-fks.sql",
  "011-contract-sofia-access-tenant-fks.sql",
  "012-contract-iris-access-tenant-fks.sql",
  "013-contract-knowledge-access-tenant-fks.sql",
  "014-drop-n-minus-one-legacy-adapters.sql",
  "015-revoke-sofia-pulso-iris-control-plane-grants.sql",
  "016-attest-access-fk-contract.sql"
];
export const EXPECTED_SCHEMA_VERSION = "16\t016-attest-access-fk-contract.sql";
export const EXPECTED_SOFIA_SCHEMA_VERSION = "2\t006-access-sofia-tenant-projection.sql";
export const EXPECTED_OWNER_STATE = "4\t0\t0";
export const EXPECTED_USER_SCHEMA_STATE =
  "agent_runtime\nchannel_runtime\nintegration_runtime\nknowledge_runtime\nplatform\npulso_iris";
export const RUNTIME_ROLES = [
  "hyperion_pulso",
  "hyperion_sofia",
  "hyperion_knowledge",
  "hyperion_integration",
  "hyperion_channel"
];
export const DOCKER_ROUTING_OVERRIDE_VARIABLES = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY"
];
export const EXPECTED_ACL_STATE = [
  "f",
  "f",
  "f",
  "t",
  "t",
  "t",
  ...RUNTIME_ROLES.flatMap(() => ["t", "f", "f"]),
  "f"
].join("\t");

const PROJECT_PATTERN = /^hyperion-pulso-recovery-acceptance(?:-[a-z0-9][a-z0-9-]{0,29})?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_DATABASE = "hyperion_pulso";
const RESTORE_DATABASE = "hyperion_pulso_restore_drill";
const MIGRATOR_ROLE = "hyperion_pulso_migrator";
const POSTGRES_ADMIN_USER = "hyperion_pulso_admin";
const MAX_BUFFER = 64 * 1024 * 1024;
const SENSITIVE_EVIDENCE_FILENAMES = new Set([
  ".npmrc",
  ".netrc",
  "credentials.json",
  "service-account.json",
  "id_rsa",
  "id_ed25519"
]);
const recoveryArtifactPayloads = new WeakMap();
const ARTIFACT_LAYOUT = Object.freeze({
  schemaVersion: 1,
  archive: "postgres-backup.dump.gz",
  schema: "schema.sql",
  ledger: "migration-ledger.tsv",
  catalog: "catalog-evidence.json",
  sourceClosure: "source",
  commandSources: "command-sources",
  logs: Object.freeze({
    backup: "logs/backup.log",
    restore: "logs/restore.log",
    migrationValidation: "logs/migration-validation.log",
    roleValidation: "logs/role-validation.log"
  })
});
const RUNTIME_PASSWORD_VARIABLES = new Map([
  ["hyperion_pulso", "PULSO_DATABASE_PASSWORD"],
  ["hyperion_sofia", "SOFIA_DATABASE_PASSWORD"],
  ["hyperion_knowledge", "KNOWLEDGE_DATABASE_PASSWORD"],
  ["hyperion_integration", "INTEGRATION_DATABASE_PASSWORD"],
  ["hyperion_channel", "CHANNEL_DATABASE_PASSWORD"]
]);
let sealedDockerContext;
let sealedDockerEndpoint;

function catalogTablePrivilege(schema, relation, privilege) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || !/^[a-z_][a-z0-9_]*$/.test(relation)) {
    throw new Error("unsafe PostgreSQL catalog privilege probe identifier");
  }
  if (!/^(SELECT|INSERT)$/.test(privilege)) {
    throw new Error("unsafe PostgreSQL catalog privilege probe operation");
  }
  return `pg_catalog.has_table_privilege(
      current_user,
      (select relation_state.oid
         from pg_catalog.pg_class relation_state
         join pg_catalog.pg_namespace namespace_state
           on namespace_state.oid = relation_state.relnamespace
        where namespace_state.nspname = '${schema}'
          and relation_state.relname = '${relation}'),
      '${privilege}')`;
}

export const RUNTIME_ACCESS_PROBES = {
  hyperion_pulso: {
    allowedPrimary: "has_table_privilege(current_user, 'pulso_iris.conversations', 'INSERT')",
    allowedSecondary: "has_table_privilege(current_user, 'pulso_iris.messages', 'SELECT')",
    forbiddenPrimary: catalogTablePrivilege("pulso_iris", "migration_ledger", "SELECT"),
    forbiddenSecondary: catalogTablePrivilege("platform", "agents", "SELECT"),
    schema: "pulso_iris"
  },
  hyperion_sofia: {
    allowedPrimary: "has_table_privilege(current_user, 'agent_runtime.jobs', 'INSERT')",
    allowedSecondary: "has_table_privilege(current_user, 'platform.agents', 'SELECT')",
    forbiddenPrimary: catalogTablePrivilege("pulso_iris", "conversations", "SELECT"),
    forbiddenSecondary: catalogTablePrivilege("platform", "knowledge_sources", "SELECT"),
    schema: "agent_runtime"
  },
  hyperion_knowledge: {
    allowedPrimary: "has_table_privilege(current_user, 'platform.knowledge_sources', 'SELECT')",
    allowedSecondary: "has_schema_privilege(current_user, 'platform', 'USAGE')",
    forbiddenPrimary: catalogTablePrivilege("platform", "integrations", "SELECT"),
    forbiddenSecondary: catalogTablePrivilege("platform", "knowledge_sources", "INSERT"),
    schema: "platform"
  },
  hyperion_integration: {
    allowedPrimary: "has_table_privilege(current_user, 'platform.integrations', 'SELECT')",
    allowedSecondary: "has_schema_privilege(current_user, 'platform', 'USAGE')",
    forbiddenPrimary: catalogTablePrivilege("platform", "knowledge_sources", "SELECT"),
    forbiddenSecondary: catalogTablePrivilege("platform", "integrations", "INSERT"),
    schema: "platform"
  },
  hyperion_channel: {
    allowedPrimary: "has_table_privilege(current_user, 'channel_runtime.inbound_events', 'INSERT')",
    allowedSecondary:
      "has_function_privilege(current_user, 'channel_runtime.claim_next_inbound_event(text)', 'EXECUTE')",
    forbiddenPrimary: catalogTablePrivilege("agent_runtime", "jobs", "SELECT"),
    forbiddenSecondary: catalogTablePrivilege("pulso_iris", "conversations", "SELECT"),
    schema: "channel_runtime"
  }
};

export function parseArguments(argv, now = new Date(), randomSuffix = randomBytes(4).toString("hex")) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") {
      options.help = true;
      continue;
    }
    if (name !== "--confirm" && name !== "--project" && name !== "--evidence-output") {
      throw new Error(`Unknown argument: ${name}`);
    }
    const key = name === "--evidence-output" ? "evidenceOutput" : name.slice(2);
    if (options[key] !== undefined) throw new Error(`Duplicate argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[key] = value;
  }
  if (options.help) return options;
  if (options.confirm !== DRILL_CONFIRMATION) throw new Error(`--confirm must equal '${DRILL_CONFIRMATION}'`);
  const operationId = compactUtc(now);
  const project = options.project ?? `${PROJECT_PREFIX}-${operationId.toLowerCase()}-${randomSuffix}`;
  assertSafeProjectName(project);
  return { ...options, operationId, project };
}

export function assertSafeProjectName(project) {
  if (typeof project !== "string" || !PROJECT_PATTERN.test(project) || project.length > 63) {
    throw new Error(`--project must match ${PROJECT_PATTERN} and contain at most 63 characters`);
  }
}

export function prepareEvidenceOutput(candidate) {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 4096 ||
    /[\r\n\0]/.test(candidate)
  ) {
    throw new Error("--evidence-output must be a non-empty single-line path");
  }
  const requested = path.resolve(candidate);
  if (path.extname(requested).toLowerCase() !== ".json") {
    throw new Error("--evidence-output must name a .json file");
  }
  const requestedParent = path.dirname(requested);
  let parentMetadata;
  try {
    parentMetadata = lstatSync(requestedParent);
  } catch {
    throw new Error("--evidence-output parent directory must already exist");
  }
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("--evidence-output parent must be a real directory, not a symbolic link");
  }
  const canonical = path.join(realpathSync(requestedParent), path.basename(requested));
  assertUnusedEvidencePath(canonical, "--evidence-output");
  assertUnusedEvidencePath(`${canonical}.artifacts`, "--evidence-output artifact bundle");
  return canonical;
}

function assertUnusedEvidencePath(candidate, label) {
  let targetMetadata;
  try {
    targetMetadata = lstatSync(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (targetMetadata?.isSymbolicLink()) {
    throw new Error(`${label} refuses an existing symbolic link`);
  }
  if (targetMetadata) throw new Error(`${label} already exists; refusing to overwrite it`);
}

function artifactPath(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe recovery artifact path: ${String(relativePath)}`);
  }
  const target = path.resolve(root, relativePath);
  const fromRoot = path.relative(root, target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`recovery artifact escapes its bundle: ${relativePath}`);
  }
  return target;
}

function writeArtifact(root, relativePath, content) {
  const target = artifactPath(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { flag: "wx", mode: 0o600 });
}

function writeArtifactEntries(root, entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label} must contain files`);
  const paths = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !Buffer.isBuffer(entry.content) || paths.has(entry.path)) {
      throw new Error(`${label} contains an invalid or duplicate file`);
    }
    paths.add(entry.path);
    writeArtifact(root, entry.path, entry.content);
  }
}

function validateArtifactPayload(artifacts) {
  if (!artifacts || typeof artifacts !== "object" || !Buffer.isBuffer(artifacts.archive)) {
    throw new Error("recovery evidence is missing its synthetic PostgreSQL archive");
  }
  for (const name of ["schema", "ledger"]) {
    if (typeof artifacts[name] !== "string" || artifacts[name].length === 0) {
      throw new Error(`recovery evidence is missing its ${name} artifact`);
    }
  }
  if (!artifacts.catalog || typeof artifacts.catalog !== "object" || Array.isArray(artifacts.catalog)) {
    throw new Error("recovery evidence is missing its catalog artifact");
  }
  for (const name of Object.keys(ARTIFACT_LAYOUT.logs)) {
    if (typeof artifacts.logs?.[name] !== "string" || artifacts.logs[name].length === 0) {
      throw new Error(`recovery evidence is missing its ${name} log artifact`);
    }
  }
  if (!Array.isArray(artifacts.sourceFiles) || !Array.isArray(artifacts.commandSourceFiles)) {
    throw new Error("recovery evidence is missing its source closure artifacts");
  }
}

export function writeRecoveryEvidence(candidate, evidence, suppliedArtifacts) {
  const target = prepareEvidenceOutput(candidate);
  if (!evidence || typeof evidence !== "object" || evidence.cleanupVerified !== true) {
    throw new Error("recovery evidence cannot be written until cleanupVerified is true");
  }
  const artifacts = suppliedArtifacts ?? recoveryArtifactPayloads.get(evidence);
  validateArtifactPayload(artifacts);
  const bundleRoot = `${target}.artifacts`;
  const artifactBundle = {
    ...ARTIFACT_LAYOUT,
    logs: { ...ARTIFACT_LAYOUT.logs },
    directory: path.basename(bundleRoot)
  };
  const persistedEvidence = { ...evidence, artifactBundle };
  const serialized = `${JSON.stringify(persistedEvidence, null, 2)}\n`;
  let descriptor;
  let receiptCreated = false;
  let bundleCreated = false;
  try {
    mkdirSync(bundleRoot, { mode: 0o700 });
    bundleCreated = true;
    writeArtifact(bundleRoot, ARTIFACT_LAYOUT.archive, artifacts.archive);
    writeArtifact(bundleRoot, ARTIFACT_LAYOUT.schema, artifacts.schema);
    writeArtifact(bundleRoot, ARTIFACT_LAYOUT.ledger, artifacts.ledger);
    writeArtifact(bundleRoot, ARTIFACT_LAYOUT.catalog, `${JSON.stringify(artifacts.catalog, null, 2)}\n`);
    for (const [name, relativePath] of Object.entries(ARTIFACT_LAYOUT.logs)) {
      writeArtifact(bundleRoot, relativePath, artifacts.logs[name]);
    }
    const sourceRoot = artifactPath(bundleRoot, ARTIFACT_LAYOUT.sourceClosure);
    mkdirSync(sourceRoot, { mode: 0o700 });
    writeArtifactEntries(sourceRoot, artifacts.sourceFiles, "source closure");
    const commandsRoot = artifactPath(bundleRoot, ARTIFACT_LAYOUT.commandSources);
    mkdirSync(commandsRoot, { mode: 0o700 });
    writeArtifactEntries(commandsRoot, artifacts.commandSourceFiles, "command sources");

    descriptor = openSync(target, "wx", 0o600);
    receiptCreated = true;
    writeFileSync(descriptor, serialized, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    const cleanupErrors = [];
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (receiptCreated) {
      try {
        unlinkSync(target);
      } catch (unlinkError) {
        cleanupErrors.push(unlinkError);
      }
    }
    if (bundleCreated) {
      try {
        rmSync(bundleRoot, { recursive: true, force: false });
      } catch (bundleError) {
        cleanupErrors.push(bundleError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "evidence write failed and its partial receipt or artifact bundle could not be removed",
        { cause: error }
      );
    }
    throw error;
  }
  return { path: target, bundlePath: bundleRoot, sha256: sha256(serialized) };
}

export function assertProjectAbsent(resources, project) {
  const occupied = Object.entries(resources).filter(([, values]) => values.length > 0);
  if (occupied.length > 0) {
    const summary = occupied.map(([kind, values]) => `${kind}=${values.join(",")}`).join("; ");
    throw new Error(`isolated Docker project ${project} already has resources; refusing to reuse it: ${summary}`);
  }
}

export function assertDefaultDockerRouting(environment = process.env) {
  const configured = DOCKER_ROUTING_OVERRIDE_VARIABLES.filter((name) =>
    Object.prototype.hasOwnProperty.call(environment, name)
  );
  if (configured.length > 0) {
    throw new Error(`PULSO recovery requires default Docker routing through HOME; unset: ${configured.join(", ")}`);
  }
}

export function preflightDefaultDockerClient(environment, docker) {
  assertDefaultDockerRouting(environment);
  docker(["version", "--format", "{{.Server.Version}}"]);
  docker(["compose", "version", "--short"]);
  return resolveDockerIdentity(docker);
}

export function resolveDockerIdentity(docker, platform = process.platform) {
  const context = docker(["context", "show"]).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context)) {
    throw new Error(`Docker returned an unsafe active context name: ${context || "<empty>"}`);
  }
  const endpoint = docker(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]).trim();
  if (!endpoint || endpoint.length > 2048 || /[\r\n\0]/.test(endpoint)) {
    throw new Error("Docker returned an unsafe or empty endpoint for the active context");
  }
  const localScheme = platform === "win32" ? "npipe://" : "unix://";
  if (!endpoint.startsWith(localScheme)) {
    throw new Error(`PULSO recovery requires a local ${localScheme} Docker endpoint; got ${endpoint}`);
  }
  return { context, endpoint };
}

export function expectedMigrationFiles(root = repositoryRoot) {
  return readdirSync(path.join(root, "packages", "pulso-migrations", "sql"))
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort();
}

export function parseKeyValueOutput(output) {
  const values = new Map();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

export function normalizeSchemaDump(value) {
  return (
    value
      .replaceAll("\r\n", "\n")
      .replace(/^\\restrict\s+\S+$/gm, "\\restrict <normalized>")
      .replace(/^\\unrestrict\s+\S+$/gm, "\\unrestrict <normalized>")
      .trimEnd() + "\n"
  );
}

export function renderIsolatedStandaloneCompose(contents, contextDirectory) {
  if (!path.isAbsolute(contextDirectory)) throw new Error("isolated PULSO Docker context must be absolute");
  const normalizedContext = contextDirectory.replaceAll("\\", "/");
  if (/[\r\n"]/.test(normalizedContext)) throw new Error("isolated PULSO Docker context contains unsafe characters");

  const contextDeclaration = "  context: ../.docker-contexts/pulso";
  const lineEnding = contents.includes("\r\n") ? "\r\n" : "\n";
  const postgresPorts = `    ports:${lineEnding}      - "127.0.0.1:\${PULSO_POSTGRES_HOST_PORT:-55440}:5432"${lineEnding}`;
  if (contents.split(contextDeclaration).length !== 2) {
    throw new Error("standalone PULSO Compose must contain exactly one canonical build context");
  }
  if (contents.split(postgresPorts).length !== 2) {
    throw new Error("standalone PULSO Compose must contain exactly one canonical PostgreSQL ports block");
  }
  return contents.replace(contextDeclaration, `  context: "${normalizedContext}"`).replace(postgresPorts, "");
}

export function isExpectedRuntimeDdlDenial(message) {
  return /ERROR:\s+permission denied (?:to create schema|for database)/i.test(String(message));
}

export function expectedRuntimeState(role) {
  if (!RUNTIME_ROLES.includes(role)) throw new Error(`unknown PULSO runtime role: ${role}`);
  const canReadGlobalMarker = role !== "hyperion_sofia";
  const canReadSofiaMarker = role === "hyperion_sofia";
  const globalMarker = canReadGlobalMarker
    ? EXPECTED_SCHEMA_VERSION
    : "15\t015-revoke-sofia-pulso-iris-control-plane-grants.sql";
  return `${role}\t${RESTORE_DATABASE}\t${globalMarker}\t${canReadGlobalMarker}\t${canReadSofiaMarker}\ttrue\ttrue\tfalse\tfalse\tfalse`;
}

export function schemaMarkerVersion(value, label) {
  const fields = String(value).split("\t");
  const version = Number(fields[0]);
  if (
    fields.length !== 2 ||
    !/^[1-9]\d*$/.test(fields[0] ?? "") ||
    !Number.isSafeInteger(version) ||
    !/^\d{3}-.+\.sql$/.test(fields[1] ?? "")
  ) {
    throw new Error(`${label} schema marker must be '<positive-version>\\t<NNN-migration.sql>'`);
  }
  return version;
}

export function parsePulsoMigrationReceipt(output) {
  const receipt = parseJsonEvent(output, "pulso_migrations_complete");
  for (const field of ["applied", "adopted", "skipped"]) {
    if (!Array.isArray(receipt[field]) || receipt[field].some((value) => typeof value !== "string")) {
      throw new Error(`PULSO migration validation returned an invalid ${field} receipt`);
    }
  }
  if (receipt.applied.length > 0 || receipt.adopted.length > 0) {
    throw new Error("restored PULSO validation unexpectedly applied or adopted a migration");
  }
  if (JSON.stringify(receipt.skipped) !== JSON.stringify(EXPECTED_MIGRATIONS)) {
    throw new Error(
      `restored PULSO validation did not skip the exact provider migration catalog: ${receipt.skipped.join(", ")}`
    );
  }
  return receipt;
}

export function parsePulsoRoleReceipt(output) {
  const receipt = parseJsonEvent(output, "pulso_database_roles_ready");
  if (receipt.roleCount !== RUNTIME_ROLES.length) {
    throw new Error(`restored PULSO role validation returned roleCount=${String(receipt.roleCount)}`);
  }
  return receipt;
}

export function assertPulsoCatalogEvidence({
  aclState,
  ledger,
  ownerState,
  runtimeStates,
  schemaVersion,
  sofiaSchemaVersion,
  userSchemas
}) {
  assertLedgerMatchesFiles(ledger, EXPECTED_MIGRATIONS);
  if (schemaVersion !== EXPECTED_SCHEMA_VERSION) throw new Error(`PULSO schema version mismatch: ${schemaVersion}`);
  if (sofiaSchemaVersion !== EXPECTED_SOFIA_SCHEMA_VERSION) {
    throw new Error(`SOFIA schema version mismatch: ${sofiaSchemaVersion}`);
  }
  if (ownerState !== EXPECTED_OWNER_STATE) throw new Error(`PULSO schema/object ownership mismatch: ${ownerState}`);
  if (aclState !== EXPECTED_ACL_STATE) throw new Error(`PULSO database/schema ACL mismatch: ${aclState}`);
  const actualRoles = Object.keys(runtimeStates ?? {}).sort();
  const expectedRoles = [...RUNTIME_ROLES].sort();
  if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
    throw new Error(`PULSO runtime evidence role set mismatch: ${actualRoles.join(", ")}`);
  }
  for (const role of RUNTIME_ROLES) {
    if (runtimeStates[role] !== expectedRuntimeState(role)) {
      throw new Error(`PULSO runtime access mismatch for ${role}: ${runtimeStates[role]}`);
    }
  }
  if (userSchemas !== EXPECTED_USER_SCHEMA_STATE) {
    throw new Error(`restored PULSO user schema whitelist mismatch: ${userSchemas}`);
  }
}

function parseJsonEvent(output, event) {
  const matches = [];
  for (const line of String(output).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value?.event === event) matches.push(value);
    } catch {
      // Ignore non-receipt process output; the exact event remains mandatory.
    }
  }
  if (matches.length !== 1) throw new Error(`expected exactly one ${event} receipt, got ${matches.length}`);
  return matches[0];
}

function compactUtc(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("invalid drill timestamp");
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

function usage() {
  return `Usage:
  node scripts/ops/run-pulso-postgres-recovery-drill.mjs --confirm "${DRILL_CONFIRMATION}" [--project ${PROJECT_PREFIX}-<id>] [--evidence-output <unused-receipt.json>]

This opt-in drill creates only a fresh, isolated Docker Compose project, performs a real
PostgreSQL backup and restore, verifies the provider ledger through migration 016, owner-local SOFIA marker, ownership,
PUBLIC/migrator database ACL and all five runtime-role boundaries, then removes only
that project's containers, networks, volumes and locally tagged build images.
The scope is PostgreSQL only; WhatsApp session storage is intentionally excluded.
`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: options.inherit ? "inherit" : "pipe",
    windowsHide: true
  });
  if (result.error) throw new Error(`could not execute ${command}: ${result.error.message}`, { cause: result.error });
  if ((result.status ?? 1) !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function runDocker(args, options) {
  const routedArgs = sealedDockerEndpoint ? ["--host", sealedDockerEndpoint, ...args] : args;
  return run("docker", routedArgs, options);
}

function composeArgs(project, environmentFile, composeFile) {
  return ["compose", "-p", project, "--env-file", environmentFile, "-f", composeFile];
}

export function expectedProjectResourceNames(project) {
  assertSafeProjectName(project);
  return {
    containerPrefixes: [`${project}-`, `${project}_`],
    imageRepositoryPrefixes: [`${project}-`, `${project}_`],
    networkNames: [`${project}_default`],
    volumeNames: [`${project}_pulso_postgres_data`, `${project}_pulso_whatsapp_sessions`]
  };
}

export function listProjectResources(project, docker = runDocker) {
  assertSafeProjectName(project);
  const expected = expectedProjectResourceNames(project);
  const capture = (args) =>
    docker(args)
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  const merge = (...groups) => [...new Set(groups.flat())].sort();
  const namedContainers = capture(["ps", "-a", "--format", "{{.Names}}"]).filter((name) =>
    expected.containerPrefixes.some((prefix) => name.startsWith(prefix))
  );
  const namedNetworks = capture(["network", "ls", "--format", "{{.Name}}"]).filter(
    (name) => expected.networkNames.includes(name) || name.startsWith(`${project}_`)
  );
  const namedVolumes = capture(["volume", "ls", "--format", "{{.Name}}"]).filter(
    (name) => expected.volumeNames.includes(name) || name.startsWith(`${project}_`)
  );
  return {
    containers: merge(
      capture(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]),
      namedContainers
    ),
    networks: merge(
      capture(["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"]),
      namedNetworks
    ),
    volumes: merge(
      capture(["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"]),
      namedVolumes
    ),
    images: merge(
      ...expected.imageRepositoryPrefixes.map((prefix) =>
        capture(["image", "ls", "--filter", `reference=${prefix}*`, "--format", "{{.Repository}}:{{.Tag}}"])
      )
    )
  };
}

export function parseDockerInventory(output) {
  return String(output)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, name, image] = line.split("\t");
      if (!/^[a-f0-9]{12,64}$/.test(id ?? "") || !name || !image) {
        throw new Error(`Docker returned an invalid inventory row: ${line}`);
      }
      return { id, name, image };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function assertDockerInventoryPreserved(before, after) {
  const afterByName = new Map(after.map((entry) => [entry.name, entry]));
  for (const expected of before) {
    const observed = afterByName.get(expected.name);
    if (!observed || observed.id !== expected.id || observed.image !== expected.image) {
      throw new Error(`preexisting Docker resource changed during PULSO recovery: ${expected.name}`);
    }
  }
}

function captureDirectoryClosure(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relativePath = path.relative(root, absolute).replaceAll("\\", "/");
        assertSafeEvidenceSourcePath(relativePath);
        entries.push({
          path: relativePath,
          content: readFileSync(absolute)
        });
      } else {
        throw new Error(`PULSO recovery closure contains an unsupported filesystem entry: ${absolute}`);
      }
    }
  };
  visit(root);
  const rows = entries.map((entry) => `${entry.path}\t${sha256(entry.content)}`);
  return { files: rows.length, sha256: sha256(`${rows.join("\n")}\n`), entries };
}

function assertSafeEvidenceSourcePath(relativePath) {
  const name = path.posix.basename(relativePath).toLowerCase();
  const privateEnvironment = name === ".env" || (name.startsWith(".env.") && !name.endsWith(".example"));
  const credentialName = SENSITIVE_EVIDENCE_FILENAMES.has(name);
  if (privateEnvironment || credentialName || /\.(?:key|pem|p12|pfx)$/.test(name)) {
    throw new Error(`PULSO recovery evidence refuses potentially secret-bearing source file: ${relativePath}`);
  }
}

export function hashDirectoryClosure(root) {
  const { files, sha256: digest } = captureDirectoryClosure(root);
  return { files, sha256: digest };
}

function dockerInventory() {
  return parseDockerInventory(runDocker(["ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}"]));
}

function sourceEvidence(contextDirectory) {
  const revision = run("git", ["rev-parse", "HEAD"]).trim();
  const branch = run("git", ["branch", "--show-current"]).trim() || "detached";
  const status = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const patch = run("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const commandSources = [
    fileURLToPath(import.meta.url),
    backupWrapper,
    restoreWrapper,
    path.join(scriptDirectory, "postgres-backup.sh"),
    path.join(scriptDirectory, "postgres-restore.sh"),
    standaloneComposeTemplate
  ];
  const commandSourceEntries = commandSources
    .map((file) => ({
      path: path.relative(repositoryRoot, file).replaceAll("\\", "/"),
      content: readFileSync(file)
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const commandRows = commandSourceEntries.map((entry) => `${entry.path}\t${sha256(entry.content)}`);
  const sourceClosure = captureDirectoryClosure(contextDirectory);
  const migrationSqlClosure = hashDirectoryClosure(path.join(repositoryRoot, "packages", "pulso-migrations", "sql"));
  return {
    evidence: {
      branch,
      revision,
      workingTreeIncluded: true,
      workingTreeStatusSha256: sha256(status),
      workingTreePatchSha256: sha256(patch),
      closure: { files: sourceClosure.files, sha256: sourceClosure.sha256 },
      migrationSqlClosure,
      commandSourcesSha256: sha256(`${commandRows.join("\n")}\n`)
    },
    artifacts: {
      sourceFiles: sourceClosure.entries,
      commandSourceFiles: commandSourceEntries
    }
  };
}

function resolveBash() {
  const candidates = [
    process.env.HYPERION_BASH?.trim(),
    ...(process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe"] : []),
    "bash"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("Bash 4+ is required for the PULSO backup and restore wrappers");
}

function toBashPath(bash, filePath) {
  if (process.platform !== "win32") return filePath;
  return run(bash, ["-lc", 'cygpath -u "$1"', "hyperion-cygpath", filePath]).trim();
}

function prepareEnvironment(target) {
  const credentials = {
    admin: randomBytes(24).toString("base64url"),
    migrator: randomBytes(24).toString("base64url"),
    runtimes: Object.fromEntries(RUNTIME_ROLES.map((role) => [role, randomBytes(24).toString("base64url")]))
  };
  let contents = readFileSync(environmentExample, "utf8");
  const replacements = new Map([
    ["PULSO_POSTGRES_ADMIN_PASSWORD", credentials.admin],
    ["PULSO_MIGRATOR_DATABASE_PASSWORD", credentials.migrator],
    ...RUNTIME_ROLES.map((role) => [RUNTIME_PASSWORD_VARIABLES.get(role), credentials.runtimes[role]]),
    ["PULSO_POSTGRES_DB", SOURCE_DATABASE]
  ]);
  for (const [name, value] of replacements) {
    const pattern = new RegExp(`^${name}=.*$`, "m");
    if (!pattern.test(contents)) throw new Error(`PULSO environment example is missing ${name}`);
    contents = contents.replace(pattern, `${name}=${value}`);
  }
  writeFileSync(target, contents, { mode: 0o600 });
  return credentials;
}

function writeIsolatedStandaloneCompose(runtimeRoot, contextOutputRoot) {
  const target = path.join(runtimeRoot, "docker-compose.pulso.recovery.yml");
  const contents = renderIsolatedStandaloneCompose(
    readFileSync(standaloneComposeTemplate, "utf8"),
    path.join(contextOutputRoot, "pulso")
  );
  writeFileSync(target, contents, { mode: 0o600 });
  return target;
}

function writeOpsFiles(root, project) {
  const composeFile = path.join(root, "docker-compose.pulso-ops.yml");
  const environmentFile = path.join(root, ".env.pulso-ops");
  writeFileSync(
    composeFile,
    `name: ${project}\nservices:\n  postgres:\n    image: postgres:16-alpine\n    profiles: ["pulso-ops"]\n`,
    { mode: 0o600 }
  );
  writeFileSync(environmentFile, `PULSO_POSTGRES_DB=${SOURCE_DATABASE}\n`, { mode: 0o600 });
  return { composeFile, environmentFile };
}

function wrapperEnvironment(bash, root, opsFiles, additions) {
  return {
    ...process.env,
    PULSO_OPS_TEST_MODE: "1",
    PULSO_OPS_TEST_ROOT: toBashPath(bash, root),
    PULSO_OPS_COMPOSE_FILE: toBashPath(bash, opsFiles.composeFile),
    PULSO_OPS_ENV_FILE: toBashPath(bash, opsFiles.environmentFile),
    ...additions
  };
}

function dockerPsql(compose, database, sql) {
  return runDocker([
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    POSTGRES_ADMIN_USER,
    "-d",
    database,
    "-c",
    sql
  ]).trim();
}

function runtimePsql(compose, database, role, password, sql) {
  const args = [
    ...compose,
    "exec",
    "-T",
    "-e",
    "PGPASSWORD",
    "postgres",
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    role,
    "-d",
    database,
    "-c",
    sql
  ];
  return runDocker(args, { env: { ...process.env, PGPASSWORD: password } }).trim();
}

function assertRuntimeDdlDenied(compose, database, credentials) {
  for (const role of RUNTIME_ROLES) {
    try {
      runtimePsql(
        compose,
        database,
        role,
        credentials[role],
        `create schema pulso_recovery_forbidden_${role.replace(/^hyperion_/, "")}`
      );
    } catch (error) {
      if (isExpectedRuntimeDdlDenial(error instanceof Error ? error.message : String(error))) continue;
      throw new Error(`PULSO runtime DDL probe failed unexpectedly for ${role}`, { cause: error });
    }
    throw new Error(`PULSO runtime ${role} unexpectedly created a schema after restore`);
  }
}

function schemaDump(compose, database) {
  return normalizeSchemaDump(
    runDocker([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "sh",
      "-eu",
      "-c",
      'exec pg_dump --schema-only --no-privileges --quote-all-identifiers -U "$POSTGRES_USER" -d "$1"',
      "_",
      database
    ])
  );
}

function migrationLedger(compose, database) {
  return dockerPsql(
    compose,
    database,
    "select name || E'\\t' || checksum from pulso_iris.migration_ledger order by name"
  );
}

function schemaVersion(compose, database) {
  return dockerPsql(
    compose,
    database,
    "select current_version || E'\\t' || migration_name from pulso_iris.schema_version where service_name = 'pulso'"
  );
}

function sofiaSchemaVersion(compose, database) {
  return dockerPsql(
    compose,
    database,
    "select current_version || E'\\t' || migration_name from agent_runtime.schema_version where service_name = 'sofia'"
  );
}

function ownershipState(compose, database) {
  return dockerPsql(
    compose,
    database,
    `select count(*) filter (where pg_get_userbyid(namespace.nspowner) = '${MIGRATOR_ROLE}') || E'\\t' ||
            (select count(*) from pg_class relation
              join pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
             where relation_namespace.nspname = any(array['platform','pulso_iris','agent_runtime','channel_runtime'])
               and relation.relkind in ('r','p','v','m','S','f')
               and pg_get_userbyid(relation.relowner) <> '${MIGRATOR_ROLE}') || E'\\t' ||
            (select count(*) from pg_proc procedure
              join pg_namespace procedure_namespace on procedure_namespace.oid = procedure.pronamespace
             where procedure_namespace.nspname = any(array['platform','pulso_iris','agent_runtime','channel_runtime'])
               and pg_get_userbyid(procedure.proowner) <> '${MIGRATOR_ROLE}')
       from pg_namespace namespace
      where namespace.nspname = any(array['platform','pulso_iris','agent_runtime','channel_runtime'])`
  );
}

function aclState(compose, database) {
  const runtimePrivileges = RUNTIME_ROLES.flatMap((role) => [
    `has_database_privilege('${role}', current_database(), 'CONNECT')`,
    `has_database_privilege('${role}', current_database(), 'CREATE')`,
    `has_database_privilege('${role}', current_database(), 'TEMPORARY')`
  ]).join(",\n      ");
  return dockerPsql(
    compose,
    database,
    `select concat_ws(E'\\t',
      (select coalesce(bool_or(grantee = 0 and privilege_type = 'CONNECT'), false)
         from pg_database database_state,
              lateral aclexplode(coalesce(database_state.datacl, acldefault('d', database_state.datdba)))
        where database_state.datname = current_database()),
      (select coalesce(bool_or(grantee = 0 and privilege_type = 'CREATE'), false)
         from pg_database database_state,
              lateral aclexplode(coalesce(database_state.datacl, acldefault('d', database_state.datdba)))
        where database_state.datname = current_database()),
      (select coalesce(bool_or(grantee = 0 and privilege_type = 'TEMPORARY'), false)
         from pg_database database_state,
              lateral aclexplode(coalesce(database_state.datacl, acldefault('d', database_state.datdba)))
        where database_state.datname = current_database()),
      has_database_privilege('${MIGRATOR_ROLE}', current_database(), 'CONNECT'),
      has_database_privilege('${MIGRATOR_ROLE}', current_database(), 'CREATE'),
      has_database_privilege('${MIGRATOR_ROLE}', current_database(), 'TEMPORARY'),
      ${runtimePrivileges},
      (select coalesce(bool_or(acl.grantee = 0 and acl.privilege_type in ('CREATE', 'USAGE')), false)
         from pg_namespace namespace_state,
              lateral aclexplode(coalesce(namespace_state.nspacl, acldefault('n', namespace_state.nspowner))) acl
        where namespace_state.nspname = any(array['platform','pulso_iris','agent_runtime','channel_runtime'])))`
  );
}

function runtimeState(compose, database, role, password) {
  const probe = RUNTIME_ACCESS_PROBES[role];
  if (!probe) throw new Error(`missing runtime access probe for ${role}`);
  // SOFIA no longer holds USAGE/SELECT on pulso_iris after tip 015; inject the
  // tip marker bytes from the drill constants instead of reading the table.
  const markerProjection =
    role === "hyperion_sofia"
      ? `'15' || E'\\t' || '015-revoke-sofia-pulso-iris-control-plane-grants.sql'`
      : `current_version || E'\\t' || migration_name`;
  const fromClause = role === "hyperion_sofia" ? "" : " from pulso_iris.schema_version where service_name = 'pulso'";
  return runtimePsql(
    compose,
    database,
    role,
    password,
    `select current_user || E'\\t' || current_database() || E'\\t' || ${markerProjection} || E'\\t' ||
            ${catalogTablePrivilege("pulso_iris", "schema_version", "SELECT")} || E'\\t' ||
            ${catalogTablePrivilege("agent_runtime", "schema_version", "SELECT")} || E'\\t' ||
            ${probe.allowedPrimary} || E'\\t' ||
            ${probe.allowedSecondary} || E'\\t' ||
            ${probe.forbiddenPrimary} || E'\\t' ||
            ${probe.forbiddenSecondary} || E'\\t' ||
            has_schema_privilege(current_user, '${probe.schema}', 'CREATE')${fromClause}`
  );
}

function allRuntimeStates(compose, database, credentials) {
  return Object.fromEntries(
    RUNTIME_ROLES.map((role) => [role, runtimeState(compose, database, role, credentials[role])])
  );
}

function userSchemaState(compose, database) {
  return dockerPsql(
    compose,
    database,
    `select schema_name
       from information_schema.schemata
      where schema_name not in ('public', 'information_schema')
        and schema_name !~ '^pg_'
      order by schema_name`
  );
}

function dropIsolatedSourceDatabase(compose) {
  dockerPsql(
    compose,
    "postgres",
    `select pg_terminate_backend(pid)
       from pg_stat_activity
      where datname = '${SOURCE_DATABASE}'
        and pid <> pg_backend_pid()`
  );
  dockerPsql(compose, "postgres", `drop database "${SOURCE_DATABASE}"`);
  const remains = dockerPsql(
    compose,
    "postgres",
    `select exists(select 1 from pg_database where datname = '${SOURCE_DATABASE}')`
  );
  if (remains !== "f") throw new Error("isolated PULSO source database still exists after explicit drop");
}

function validateRestoredProviderState(compose, credentials) {
  const migratorUrl = `postgres://hyperion_pulso_migrator:${encodeURIComponent(
    credentials.migrator
  )}@postgres:5432/${RESTORE_DATABASE}`;
  const migrationOutput = runDocker(
    [...compose, "run", "--rm", "--no-deps", "-e", "PULSO_MIGRATOR_DATABASE_URL", "pulso-migrations"],
    { env: { ...process.env, PULSO_MIGRATOR_DATABASE_URL: migratorUrl } }
  );
  const migrationReceipt = parsePulsoMigrationReceipt(migrationOutput);
  const roleOutput = runDocker(
    [...compose, "run", "--rm", "--no-deps", "-e", "PULSO_POSTGRES_DB", "pulso-role-bootstrap"],
    { env: { ...process.env, PULSO_POSTGRES_DB: RESTORE_DATABASE } }
  );
  const roleReceipt = parsePulsoRoleReceipt(roleOutput);
  return {
    migrationReceipt,
    roleReceipt,
    migrationOutput,
    roleOutput,
    migrationOutputSha256: sha256(migrationOutput),
    roleOutputSha256: sha256(roleOutput)
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function recoveryMarkerCode(operationId) {
  return `postgres-recovery-${operationId.toLowerCase()}`;
}

function safeRemoveTemporary(root, expectedPrefix) {
  if (!root) return;
  const resolvedRoot = path.resolve(root);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(resolvedRoot) !== temporaryRoot ||
    !path.basename(resolvedRoot).startsWith(expectedPrefix) ||
    resolvedRoot === temporaryRoot
  ) {
    throw new Error(`refusing to remove unexpected temporary path: ${resolvedRoot}`);
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}

function assertLedgerMatchesFiles(ledger, expectedFiles) {
  const rows = ledger ? ledger.split(/\r?\n/) : [];
  const names = rows.map((row) => row.split("\t", 1)[0]);
  if (JSON.stringify(names) !== JSON.stringify(expectedFiles)) {
    throw new Error(`PULSO migration ledger differs from provider SQL files: ${names.join(", ")}`);
  }
  if (rows.some((row) => !/^\d{3}-.+\.sql\t[a-f0-9]{64}$/.test(row))) {
    throw new Error("PULSO migration ledger contains an invalid name or checksum");
  }
}

function verifyBackupOutput(output, operationId) {
  const values = parseKeyValueOutput(output);
  const expectedFile = `pulso-${operationId}.dump.gz`;
  if (values.get("BACKUP_FILE") !== expectedFile) throw new Error("backup wrapper reported an unexpected archive");
  if (values.get("BACKUP_PROFILE") !== "pulso" || values.get("BACKUP_DATABASE") !== SOURCE_DATABASE) {
    throw new Error("backup wrapper did not report the exact PULSO source database");
  }
  const digest = values.get("BACKUP_SHA256") ?? "";
  if (!SHA256_PATTERN.test(digest)) throw new Error("backup wrapper did not report a valid SHA-256");
  return {
    digest,
    expectedFile,
    receipt: Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)))
  };
}

function verifyRestoreOutput(output, expectedDigest) {
  const values = parseKeyValueOutput(output);
  if (
    values.get("RESTORE_PROFILE") !== "pulso" ||
    values.get("RESTORE_DATABASE") !== RESTORE_DATABASE ||
    values.get("RESTORE_OWNER") !== MIGRATOR_ROLE ||
    values.get("RESTORE_SHA256") !== expectedDigest
  ) {
    throw new Error("restore wrapper did not report the exact PULSO restore target and digest");
  }
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function runDrill(options) {
  const { operationId, project } = options;
  if (sealedDockerContext) throw new Error("a PULSO recovery drill is already active in this process");
  assertDefaultDockerRouting(process.env);
  assertSafeProjectName(project);
  if (!/^\d{8}T\d{6}Z$/.test(operationId)) throw new Error("operationId must be a compact UTC timestamp");
  const dockerIdentity = preflightDefaultDockerClient(process.env, runDocker);
  sealedDockerContext = dockerIdentity.context;
  sealedDockerEndpoint = dockerIdentity.endpoint;

  let runtimeRoot;
  let backupRoot;
  let restoreRoot;
  let compose;
  let ownsProject = false;
  let dockerCleanupComplete = false;
  let dockerInventoryBefore;
  let result;
  let artifacts;
  let drillError;

  try {
    dockerInventoryBefore = dockerInventory();
    assertProjectAbsent(listProjectResources(project), project);
    runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-pulso-recovery-runtime."));
    backupRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-backup-test."));
    restoreRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-restore-test."));
    const mainEnvironment = path.join(runtimeRoot, "pulso.env");
    const contextOutputRoot = path.join(runtimeRoot, "docker-contexts");
    const isolatedCompose = writeIsolatedStandaloneCompose(runtimeRoot, contextOutputRoot);
    const credentials = prepareEnvironment(mainEnvironment);
    const backupOps = writeOpsFiles(backupRoot, project);
    const restoreOps = writeOpsFiles(restoreRoot, project);
    compose = composeArgs(project, mainEnvironment, isolatedCompose);
    const bash = resolveBash();

    run(
      process.execPath,
      [
        path.join(repositoryRoot, "scripts", "docker", "generate-cell-contexts.mjs"),
        "--cell",
        "pulso",
        "--output",
        contextOutputRoot
      ],
      { inherit: true }
    );
    const sourceCapture = sourceEvidence(path.join(contextOutputRoot, "pulso"));
    const source = sourceCapture.evidence;
    ownsProject = true;
    runDocker([...compose, "build", "pulso-database-bootstrap", "pulso-migrations", "pulso-role-bootstrap"], {
      inherit: true
    });
    runDocker([...compose, "up", "--detach", "--wait", "postgres"], { inherit: true });
    for (const service of ["pulso-database-bootstrap", "pulso-migrations", "pulso-role-bootstrap"]) {
      runDocker([...compose, "run", "--rm", "--no-deps", service], { inherit: true });
    }

    const marker = sha256(`${project}:${operationId}:${randomBytes(16).toString("hex")}`);
    const markerCode = recoveryMarkerCode(operationId);
    dockerPsql(
      compose,
      SOURCE_DATABASE,
      `set role ${MIGRATOR_ROLE};
       insert into platform.products(code, name, status, owner_service, metadata)
       values (
         ${sqlLiteral(markerCode)},
         'PULSO PostgreSQL recovery drill',
         'paused',
         'pulso-recovery-drill',
         jsonb_build_object('operationId', ${sqlLiteral(operationId)}, 'recoveryCanarySha256', ${sqlLiteral(marker)})
       );`
    );

    const sourceLedger = migrationLedger(compose, SOURCE_DATABASE);
    const expectedMigrations = expectedMigrationFiles();
    if (JSON.stringify(expectedMigrations) !== JSON.stringify(EXPECTED_MIGRATIONS)) {
      throw new Error(`unexpected provider migration files: ${expectedMigrations.join(", ")}`);
    }
    assertLedgerMatchesFiles(sourceLedger, expectedMigrations);
    if (schemaVersion(compose, SOURCE_DATABASE) !== EXPECTED_SCHEMA_VERSION) {
      throw new Error("source PULSO schema is not at provider version 16 / 016");
    }
    if (sofiaSchemaVersion(compose, SOURCE_DATABASE) !== EXPECTED_SOFIA_SCHEMA_VERSION) {
      throw new Error("source SOFIA schema is not at owner-local version 2 / 006");
    }
    const sourceSchema = schemaDump(compose, SOURCE_DATABASE);
    const sourceSchemaSha256 = sha256(sourceSchema);

    const backupDirectory = path.join(backupRoot, "backups", "pulso");
    const backupOutput = run(bash, [backupWrapper], {
      env: wrapperEnvironment(bash, backupRoot, backupOps, {
        PULSO_EXPECTED_DOCKER_CONTEXT: dockerIdentity.context,
        PULSO_EXPECTED_DOCKER_ENDPOINT: dockerIdentity.endpoint,
        PULSO_BACKUP_DIR: toBashPath(bash, backupDirectory),
        PULSO_BACKUP_TIMESTAMP: operationId,
        PULSO_POSTGRES_DB: SOURCE_DATABASE
      })
    });
    const backup = verifyBackupOutput(backupOutput, operationId);
    const backupArchive = path.join(backupDirectory, backup.expectedFile);
    if (!existsSync(backupArchive) || sha256(readFileSync(backupArchive)) !== backup.digest) {
      throw new Error("published backup archive does not match the wrapper SHA-256");
    }

    const restoreDirectory = path.join(restoreRoot, "backups", "pulso");
    mkdirSync(restoreDirectory, { recursive: true, mode: 0o700 });
    const restoreArchive = path.join(restoreDirectory, backup.expectedFile);
    copyFileSync(backupArchive, restoreArchive);
    const restoreOutput = run(bash, [restoreWrapper], {
      env: wrapperEnvironment(bash, restoreRoot, restoreOps, {
        PULSO_EXPECTED_DOCKER_CONTEXT: dockerIdentity.context,
        PULSO_EXPECTED_DOCKER_ENDPOINT: dockerIdentity.endpoint,
        PULSO_BACKUP_DIR: toBashPath(bash, restoreDirectory),
        PULSO_RESTORE_ARCHIVE: toBashPath(bash, restoreArchive),
        PULSO_RESTORE_DATABASE: RESTORE_DATABASE,
        PULSO_RESTORE_SHA256: backup.digest,
        PULSO_RESTORE_CONFIRM: `RESTORE PULSO ${RESTORE_DATABASE} SHA256 ${backup.digest}`
      })
    });
    const restoreReceipt = verifyRestoreOutput(restoreOutput, backup.digest);

    const restoredMarker = dockerPsql(
      compose,
      RESTORE_DATABASE,
      `select (metadata ->> 'recoveryCanarySha256') || E'\\t' || (metadata ->> 'operationId')
         from platform.products
        where code = ${sqlLiteral(markerCode)}`
    );
    if (restoredMarker !== `${marker}\t${operationId}`) {
      throw new Error("restored recovery marker differs from the source marker");
    }
    const restoredLedger = migrationLedger(compose, RESTORE_DATABASE);
    if (restoredLedger !== sourceLedger) throw new Error("restored migration ledger differs from the source ledger");
    const restoredSchema = schemaDump(compose, RESTORE_DATABASE);
    if (sha256(restoredSchema) !== sourceSchemaSha256) {
      throw new Error("restored schema dump differs from the source schema dump");
    }
    const restoredOwner = dockerPsql(
      compose,
      "postgres",
      `select pg_get_userbyid(datdba) from pg_database where datname = ${sqlLiteral(RESTORE_DATABASE)}`
    );
    if (restoredOwner !== MIGRATOR_ROLE) throw new Error(`restored database has unexpected owner: ${restoredOwner}`);

    dropIsolatedSourceDatabase(compose);
    const providerValidation = validateRestoredProviderState(compose, credentials);

    const catalogEvidence = {
      aclState: aclState(compose, RESTORE_DATABASE),
      ledger: restoredLedger,
      ownerState: ownershipState(compose, RESTORE_DATABASE),
      runtimeStates: allRuntimeStates(compose, RESTORE_DATABASE, credentials.runtimes),
      schemaVersion: schemaVersion(compose, RESTORE_DATABASE),
      sofiaSchemaVersion: sofiaSchemaVersion(compose, RESTORE_DATABASE),
      userSchemas: userSchemaState(compose, RESTORE_DATABASE)
    };
    assertPulsoCatalogEvidence(catalogEvidence);
    assertRuntimeDdlDenied(compose, RESTORE_DATABASE, credentials.runtimes);

    const serializedRuntimeStates = RUNTIME_ROLES.map((role) => catalogEvidence.runtimeStates[role]).join("\n");
    result = {
      schemaVersion: 2,
      cell: "pulso",
      scope: "postgres-only",
      operationId,
      project,
      dockerContext: dockerIdentity.context,
      dockerEndpointSha256: sha256(`${dockerIdentity.endpoint}\n`),
      source,
      sourceDatabase: SOURCE_DATABASE,
      sourceDatabaseRemovedBeforeValidation: true,
      restoreDatabase: RESTORE_DATABASE,
      restoreOwner: restoredOwner,
      backupSha256: backup.digest,
      schemaSha256: sourceSchemaSha256,
      ledgerSha256: sha256(`${sourceLedger}\n`),
      aclSha256: sha256(
        `${catalogEvidence.aclState}\n${catalogEvidence.sofiaSchemaVersion}\n${serializedRuntimeStates}\n`
      ),
      globalReadinessMarkerSha256: sha256(`${catalogEvidence.schemaVersion}\n`),
      sofiaReadinessMarkerSha256: sha256(`${catalogEvidence.sofiaSchemaVersion}\n`),
      catalogEvidenceSha256: sha256(
        `${catalogEvidence.ledger}\n${catalogEvidence.ownerState}\n${catalogEvidence.aclState}\n${catalogEvidence.userSchemas}\n${serializedRuntimeStates}\n`
      ),
      migrationCount: expectedMigrations.length,
      schemaVersionValue: schemaMarkerVersion(catalogEvidence.schemaVersion, "PULSO"),
      sofiaSchemaVersionValue: schemaMarkerVersion(catalogEvidence.sofiaSchemaVersion, "SOFIA"),
      recoveryCanarySha256: marker,
      sourceRecoveryCanarySha256: marker,
      restoredRecoveryCanarySha256: restoredMarker.split("\t", 1)[0],
      recoveryCanaryPreserved: true,
      runtimeRolesVerified: RUNTIME_ROLES.length,
      migrationsSkippedOnValidation: providerValidation.migrationReceipt.skipped,
      roleBootstrapCount: providerValidation.roleReceipt.roleCount,
      publicDatabasePrivilegesRevoked: true,
      whatsappSessionsIncluded: false,
      schemaVerifier: {
        name: "assertPulsoCatalogEvidence",
        verified: true,
        expectedGlobalMarker: EXPECTED_SCHEMA_VERSION,
        expectedSofiaMarker: EXPECTED_SOFIA_SCHEMA_VERSION
      },
      rawReceipts: {
        backup: backup.receipt,
        restore: restoreReceipt,
        migrationValidation: providerValidation.migrationReceipt,
        roleValidation: providerValidation.roleReceipt
      },
      logSha256: {
        backup: sha256(backupOutput),
        restore: sha256(restoreOutput),
        migrationValidation: providerValidation.migrationOutputSha256,
        roleValidation: providerValidation.roleOutputSha256
      }
    };
    artifacts = {
      archive: readFileSync(backupArchive),
      schema: sourceSchema,
      ledger: `${sourceLedger}\n`,
      catalog: catalogEvidence,
      logs: {
        backup: backupOutput,
        restore: restoreOutput,
        migrationValidation: providerValidation.migrationOutput,
        roleValidation: providerValidation.roleOutput
      },
      sourceFiles: sourceCapture.artifacts.sourceFiles,
      commandSourceFiles: sourceCapture.artifacts.commandSourceFiles
    };
  } catch (error) {
    drillError = error;
  } finally {
    try {
      if (ownsProject) {
        runDocker([...compose, "down", "--volumes", "--rmi", "local", "--timeout", "10"], { inherit: true });
        assertProjectAbsent(listProjectResources(project), project);
      }
      const dockerInventoryAfter = dockerInventory();
      assertDockerInventoryPreserved(dockerInventoryBefore ?? [], dockerInventoryAfter);
      if (result) {
        result.dockerInventory = {
          before: dockerInventoryBefore,
          after: dockerInventoryAfter,
          beforeSha256: sha256(`${JSON.stringify(dockerInventoryBefore)}\n`),
          afterSha256: sha256(`${JSON.stringify(dockerInventoryAfter)}\n`),
          preexistingResourcesPreserved: true
        };
      }
      dockerCleanupComplete = true;
    } catch (error) {
      drillError = drillError
        ? new AggregateError([drillError, error], "drill failed and isolated Docker cleanup also failed")
        : error;
    }
    if (dockerCleanupComplete) {
      for (const [root, prefix] of [
        [runtimeRoot, "hyperion-pulso-recovery-runtime."],
        [backupRoot, "hyperion-backup-test."],
        [restoreRoot, "hyperion-restore-test."]
      ]) {
        if (root) safeRemoveTemporary(root, prefix);
      }
    } else {
      process.stderr.write(
        `Recovery drill temporary files retained for exact cleanup: ${[runtimeRoot, backupRoot, restoreRoot]
          .filter(Boolean)
          .join(", ")}\n`
      );
    }
    sealedDockerContext = undefined;
    sealedDockerEndpoint = undefined;
  }

  if (drillError) throw drillError;
  const evidence = { ...result, cleanupVerified: true };
  if (!artifacts) throw new Error("successful recovery drill did not retain its synthetic verification artifacts");
  recoveryArtifactPayloads.set(evidence, artifacts);
  return evidence;
}

export function executeDrill(options, drill = runDrill) {
  const preparedEvidenceOutput = options.evidenceOutput ? prepareEvidenceOutput(options.evidenceOutput) : undefined;
  const evidence = drill(options);
  const evidenceArtifact = preparedEvidenceOutput ? writeRecoveryEvidence(preparedEvidenceOutput, evidence) : undefined;
  return { evidence, evidenceArtifact };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const { evidence, evidenceArtifact } = executeDrill(options);
  if (evidenceArtifact) {
    process.stdout.write(`PULSO_POSTGRES_RECOVERY_EVIDENCE_OUTPUT=${evidenceArtifact.path}\n`);
    process.stdout.write(`PULSO_POSTGRES_RECOVERY_EVIDENCE_BUNDLE=${evidenceArtifact.bundlePath}\n`);
    process.stdout.write(`PULSO_POSTGRES_RECOVERY_EVIDENCE_SHA256=${evidenceArtifact.sha256}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }
  process.stdout.write("PULSO_POSTGRES_RECOVERY_DRILL_VERIFIED=true\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
