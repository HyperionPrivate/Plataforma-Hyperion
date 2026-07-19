#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const standaloneCompose = path.join(repositoryRoot, "infra", "docker-compose.lumen.yml");
const environmentExample = path.join(repositoryRoot, "infra", "lumen.env.example");
const backupWrapper = path.join(scriptDirectory, "lumen-postgres-backup.sh");
const restoreWrapper = path.join(scriptDirectory, "lumen-postgres-restore.sh");

export const DRILL_CONFIRMATION = "RUN ISOLATED LUMEN POSTGRES RECOVERY DRILL";
export const PROJECT_PREFIX = "hyperion-lumen-recovery-acceptance";
export const EXPECTED_MIGRATIONS = ["001-lumen-autonomous-baseline.sql", "002-lumen-runtime-role.sql"];
export const EXPECTED_SCHEMA_VERSION = "40\t002-lumen-runtime-role.sql";
export const EXPECTED_OWNER_STATE = "hyperion_lumen_migrator\t0\t0";
export const EXPECTED_ACL_STATE = "f\tf\tf\tt\tf\tf\tt\tt\tt\tf\tt\tf";

const PROJECT_PATTERN = /^hyperion-lumen-recovery-acceptance(?:-[a-z0-9][a-z0-9-]{0,29})?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_DATABASE = "hyperion_lumen";
const RESTORE_DATABASE = "hyperion_lumen_restore_drill";
const MIGRATOR_ROLE = "hyperion_lumen_migrator";
const RUNTIME_ROLE = "hyperion_lumen";
const POSTGRES_ADMIN_USER = "hyperion_lumen_admin";
const MAX_BUFFER = 64 * 1024 * 1024;

export function parseArguments(argv, now = new Date(), randomSuffix = randomBytes(4).toString("hex")) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") {
      options.help = true;
      continue;
    }
    if (name !== "--confirm" && name !== "--project") throw new Error(`Unknown argument: ${name}`);
    const key = name.slice(2);
    if (options[key] !== undefined) throw new Error(`Duplicate argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[key] = value;
  }
  if (options.help) return options;
  if (options.confirm !== DRILL_CONFIRMATION) {
    throw new Error(`--confirm must equal '${DRILL_CONFIRMATION}'`);
  }
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

export function assertProjectAbsent(resources, project) {
  const occupied = Object.entries(resources).filter(([, values]) => values.length > 0);
  if (occupied.length > 0) {
    const summary = occupied.map(([kind, values]) => `${kind}=${values.join(",")}`).join("; ");
    throw new Error(`isolated Docker project ${project} already has resources; refusing to reuse it: ${summary}`);
  }
}

export function expectedMigrationFiles(root = repositoryRoot) {
  return readdirSync(path.join(root, "packages", "lumen-migrations", "sql"))
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

export function isExpectedRuntimeDdlDenial(message) {
  return /ERROR:\s+permission denied (?:to create schema|for database)/i.test(String(message));
}

export function assertLumenCatalogEvidence({
  aclState,
  ledger,
  ownerState,
  runtimeState,
  schemaVersion,
  siblingSchemas
}) {
  assertLedgerMatchesFiles(ledger, EXPECTED_MIGRATIONS);
  if (schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(`LUMEN schema version mismatch: ${schemaVersion}`);
  }
  if (ownerState !== EXPECTED_OWNER_STATE) {
    throw new Error(`LUMEN schema/object ownership mismatch: ${ownerState}`);
  }
  if (aclState !== EXPECTED_ACL_STATE) {
    throw new Error(`LUMEN database/schema ACL mismatch: ${aclState}`);
  }
  // Boolean values concatenated into PostgreSQL text render as `true`/`false`,
  // unlike the compact `t`/`f` representation returned by a bare boolean column.
  const expectedRuntime = `${RUNTIME_ROLE}\t${RESTORE_DATABASE}\t40\t002-lumen-runtime-role.sql\ttrue\tfalse`;
  if (runtimeState !== expectedRuntime) {
    throw new Error(`LUMEN runtime access mismatch: ${runtimeState}`);
  }
  if (siblingSchemas !== "") throw new Error(`restored LUMEN database contains sibling schemas: ${siblingSchemas}`);
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
  pnpm ops:lumen:postgres:recovery:drill --confirm "${DRILL_CONFIRMATION}" [--project ${PROJECT_PREFIX}-<id>]

This opt-in drill creates only a fresh, isolated Docker Compose project, performs a real
PostgreSQL backup and restore, verifies the provider ledger, v40 catalog, ownership,
PUBLIC/runtime database ACL and a real runtime-role connection, then removes only that
project's containers, networks, volumes and locally tagged build images.
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
  return run("docker", args, options);
}

function composeArgs(project, environmentFile) {
  return ["compose", "-p", project, "--env-file", environmentFile, "-f", standaloneCompose];
}

function listProjectResources(project) {
  assertSafeProjectName(project);
  const capture = (args) =>
    runDocker(args)
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  return {
    containers: capture(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"]),
    networks: capture([
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.ID}}"
    ]),
    volumes: capture([
      "volume",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.Name}}"
    ]),
    images: capture(["image", "ls", "--filter", `reference=${project}-*`, "--format", "{{.Repository}}:{{.Tag}}"])
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
  throw new Error("Bash 4+ is required for the LUMEN backup and restore wrappers");
}

function toBashPath(bash, filePath) {
  if (process.platform !== "win32") return filePath;
  return run(bash, ["-lc", 'cygpath -u "$1"', "hyperion-cygpath", filePath]).trim();
}

function prepareEnvironment(target) {
  const credentials = {
    admin: randomBytes(24).toString("base64url"),
    migrator: randomBytes(24).toString("base64url"),
    runtime: randomBytes(24).toString("base64url")
  };
  let contents = readFileSync(environmentExample, "utf8");
  const replacements = new Map([
    ["LUMEN_POSTGRES_ADMIN_PASSWORD", credentials.admin],
    ["LUMEN_MIGRATOR_DATABASE_PASSWORD", credentials.migrator],
    ["LUMEN_DATABASE_PASSWORD", credentials.runtime],
    ["LUMEN_POSTGRES_DB", SOURCE_DATABASE]
  ]);
  for (const [name, value] of replacements) {
    const pattern = new RegExp(`^${name}=.*$`, "m");
    if (!pattern.test(contents)) throw new Error(`LUMEN environment example is missing ${name}`);
    contents = contents.replace(pattern, `${name}=${value}`);
  }
  writeFileSync(target, contents, { mode: 0o600 });
  return credentials;
}

function writeOpsFiles(root, project) {
  const composeFile = path.join(root, "docker-compose.lumen-ops.yml");
  const environmentFile = path.join(root, ".env.lumen-ops");
  writeFileSync(
    composeFile,
    `name: ${project}\nservices:\n  postgres:\n    image: postgres:16-alpine\n    profiles: ["lumen-ops"]\n`,
    { mode: 0o600 }
  );
  writeFileSync(environmentFile, `LUMEN_POSTGRES_DB=${SOURCE_DATABASE}\n`, { mode: 0o600 });
  return { composeFile, environmentFile };
}

function wrapperEnvironment(bash, root, opsFiles, additions) {
  return {
    ...process.env,
    LUMEN_OPS_TEST_MODE: "1",
    LUMEN_OPS_TEST_ROOT: toBashPath(bash, root),
    LUMEN_OPS_COMPOSE_FILE: toBashPath(bash, opsFiles.composeFile),
    LUMEN_OPS_ENV_FILE: toBashPath(bash, opsFiles.environmentFile),
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

function runtimePsql(compose, database, password, sql) {
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
    RUNTIME_ROLE,
    "-d",
    database,
    "-c",
    sql
  ];
  return runDocker(args, { env: { ...process.env, PGPASSWORD: password } }).trim();
}

function assertRuntimeDdlDenied(compose, database, password) {
  try {
    runtimePsql(compose, database, password, "create schema lumen_recovery_forbidden");
  } catch (error) {
    if (isExpectedRuntimeDdlDenial(error instanceof Error ? error.message : String(error))) return;
    throw new Error("LUMEN runtime DDL probe failed for an unexpected reason", { cause: error });
  }
  throw new Error("LUMEN runtime unexpectedly created a schema after restore");
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
  return dockerPsql(compose, database, "select name || E'\\t' || checksum from lumen.migration_ledger order by name");
}

function schemaVersion(compose, database) {
  return dockerPsql(
    compose,
    database,
    "select current_version || E'\\t' || migration_name from lumen.schema_version where service_name = 'lumen'"
  );
}

function ownershipState(compose, database) {
  return dockerPsql(
    compose,
    database,
    `select pg_get_userbyid(namespace.nspowner) || E'\\t' ||
            (select count(*) from pg_class relation
              where relation.relnamespace = namespace.oid
                and relation.relkind in ('r','p','v','m','S','f')
                and pg_get_userbyid(relation.relowner) <> '${MIGRATOR_ROLE}') || E'\\t' ||
            (select count(*) from pg_proc procedure
              where procedure.pronamespace = namespace.oid
                and pg_get_userbyid(procedure.proowner) <> '${MIGRATOR_ROLE}')
       from pg_namespace namespace where namespace.nspname = 'lumen'`
  );
}

function aclState(compose, database) {
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
      has_database_privilege('${RUNTIME_ROLE}', current_database(), 'CONNECT'),
      has_database_privilege('${RUNTIME_ROLE}', current_database(), 'CREATE'),
      has_database_privilege('${RUNTIME_ROLE}', current_database(), 'TEMPORARY'),
      has_database_privilege('${MIGRATOR_ROLE}', current_database(), 'CONNECT'),
      has_database_privilege('${MIGRATOR_ROLE}', current_database(), 'CREATE'),
      has_database_privilege('${MIGRATOR_ROLE}', current_database(), 'TEMPORARY'),
      (select coalesce(bool_or(grantee = 0 and privilege_type = 'CREATE'), false)
         from pg_namespace namespace_state,
              lateral aclexplode(coalesce(namespace_state.nspacl, acldefault('n', namespace_state.nspowner)))
        where namespace_state.nspname = 'lumen'),
      has_schema_privilege('${RUNTIME_ROLE}', 'lumen', 'USAGE'),
      has_schema_privilege('${RUNTIME_ROLE}', 'lumen', 'CREATE'))`
  );
}

function runtimeState(compose, database, runtimePassword) {
  return runtimePsql(
    compose,
    database,
    runtimePassword,
    `select current_user || E'\\t' || current_database() || E'\\t' || current_version || E'\\t' ||
            migration_name || E'\\t' ||
            has_table_privilege(current_user, 'lumen.clinical_records', 'INSERT') || E'\\t' ||
            has_schema_privilege(current_user, 'lumen', 'CREATE')
       from lumen.schema_version where service_name = 'lumen'`
  );
}

function siblingSchemas(compose, database) {
  return dockerPsql(
    compose,
    database,
    "select schema_name from information_schema.schemata where schema_name in ('platform','pulso_iris','nova','voice','liwa','documents') order by schema_name"
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
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
    throw new Error(`LUMEN migration ledger differs from provider SQL files: ${names.join(", ")}`);
  }
  if (rows.some((row) => !/^\d{3}-.+\.sql\t[a-f0-9]{64}$/.test(row))) {
    throw new Error("LUMEN migration ledger contains an invalid name or checksum");
  }
}

function verifyBackupOutput(output, operationId) {
  const values = parseKeyValueOutput(output);
  const expectedFile = `lumen-${operationId}.dump.gz`;
  if (values.get("BACKUP_FILE") !== expectedFile) throw new Error("backup wrapper reported an unexpected archive");
  if (values.get("BACKUP_PROFILE") !== "lumen" || values.get("BACKUP_DATABASE") !== SOURCE_DATABASE) {
    throw new Error("backup wrapper did not report the exact LUMEN source database");
  }
  const digest = values.get("BACKUP_SHA256") ?? "";
  if (!SHA256_PATTERN.test(digest)) throw new Error("backup wrapper did not report a valid SHA-256");
  return { digest, expectedFile };
}

function verifyRestoreOutput(output, expectedDigest) {
  const values = parseKeyValueOutput(output);
  if (
    values.get("RESTORE_PROFILE") !== "lumen" ||
    values.get("RESTORE_DATABASE") !== RESTORE_DATABASE ||
    values.get("RESTORE_OWNER") !== MIGRATOR_ROLE ||
    values.get("RESTORE_SHA256") !== expectedDigest
  ) {
    throw new Error("restore wrapper did not report the exact LUMEN restore target and digest");
  }
}

export function runDrill(options) {
  const { operationId, project } = options;
  assertSafeProjectName(project);
  if (!/^\d{8}T\d{6}Z$/.test(operationId)) throw new Error("operationId must be a compact UTC timestamp");
  runDocker(["version", "--format", "{{.Server.Version}}"]);
  runDocker(["compose", "version", "--short"]);
  assertProjectAbsent(listProjectResources(project), project);

  let runtimeRoot;
  let backupRoot;
  let restoreRoot;
  let compose;
  let ownsProject = false;
  let dockerCleanupComplete = false;
  let result;
  let drillError;

  try {
    runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-lumen-recovery-runtime."));
    backupRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-backup-test."));
    restoreRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-restore-test."));
    const mainEnvironment = path.join(runtimeRoot, "lumen.env");
    const credentials = prepareEnvironment(mainEnvironment);
    const backupOps = writeOpsFiles(backupRoot, project);
    const restoreOps = writeOpsFiles(restoreRoot, project);
    compose = composeArgs(project, mainEnvironment);
    const bash = resolveBash();

    run(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "docker", "generate-cell-contexts.mjs"), "--cell", "lumen"],
      { inherit: true }
    );
    ownsProject = true;
    runDocker([...compose, "build", "lumen-database-bootstrap", "lumen-migrations", "lumen-role-bootstrap"], {
      inherit: true
    });
    runDocker([...compose, "up", "--detach", "--wait", "postgres"], { inherit: true });
    for (const service of ["lumen-database-bootstrap", "lumen-migrations", "lumen-role-bootstrap"]) {
      runDocker([...compose, "run", "--rm", "--no-deps", service], { inherit: true });
    }

    const marker = sha256(`${project}:${operationId}:${randomBytes(16).toString("hex")}`);
    dockerPsql(
      compose,
      SOURCE_DATABASE,
      `set role ${MIGRATOR_ROLE};
       create table lumen.recovery_drill_probe (
         operation_id text primary key,
         marker_sha256 text not null check (marker_sha256 ~ '^[a-f0-9]{64}$')
       );
       insert into lumen.recovery_drill_probe(operation_id, marker_sha256)
       values (${sqlLiteral(operationId)}, ${sqlLiteral(marker)});`
    );

    const sourceLedger = migrationLedger(compose, SOURCE_DATABASE);
    const expectedMigrations = expectedMigrationFiles();
    if (JSON.stringify(expectedMigrations) !== JSON.stringify(EXPECTED_MIGRATIONS)) {
      throw new Error(`unexpected provider migration files: ${expectedMigrations.join(", ")}`);
    }
    assertLedgerMatchesFiles(sourceLedger, expectedMigrations);
    if (schemaVersion(compose, SOURCE_DATABASE) !== EXPECTED_SCHEMA_VERSION) {
      throw new Error("source LUMEN schema is not at provider version 40 / 002");
    }
    const sourceSchema = schemaDump(compose, SOURCE_DATABASE);
    const sourceSchemaSha256 = sha256(sourceSchema);

    const backupDirectory = path.join(backupRoot, "backups", "lumen");
    const backupOutput = run(bash, [backupWrapper], {
      env: wrapperEnvironment(bash, backupRoot, backupOps, {
        LUMEN_BACKUP_DIR: toBashPath(bash, backupDirectory),
        LUMEN_BACKUP_TIMESTAMP: operationId,
        LUMEN_POSTGRES_DB: SOURCE_DATABASE
      })
    });
    const backup = verifyBackupOutput(backupOutput, operationId);
    const backupArchive = path.join(backupDirectory, backup.expectedFile);
    if (!existsSync(backupArchive) || sha256(readFileSync(backupArchive)) !== backup.digest) {
      throw new Error("published backup archive does not match the wrapper SHA-256");
    }

    const restoreDirectory = path.join(restoreRoot, "backups", "lumen");
    mkdirSync(restoreDirectory, { recursive: true, mode: 0o700 });
    const restoreArchive = path.join(restoreDirectory, backup.expectedFile);
    copyFileSync(backupArchive, restoreArchive);
    const restoreOutput = run(bash, [restoreWrapper], {
      env: wrapperEnvironment(bash, restoreRoot, restoreOps, {
        LUMEN_BACKUP_DIR: toBashPath(bash, restoreDirectory),
        LUMEN_RESTORE_ARCHIVE: toBashPath(bash, restoreArchive),
        LUMEN_RESTORE_DATABASE: RESTORE_DATABASE,
        LUMEN_RESTORE_SHA256: backup.digest,
        LUMEN_RESTORE_CONFIRM: `RESTORE LUMEN ${RESTORE_DATABASE} SHA256 ${backup.digest}`
      })
    });
    verifyRestoreOutput(restoreOutput, backup.digest);

    const restoredMarker = dockerPsql(
      compose,
      RESTORE_DATABASE,
      `select marker_sha256 from lumen.recovery_drill_probe where operation_id = ${sqlLiteral(operationId)}`
    );
    if (restoredMarker !== marker) throw new Error("restored recovery marker differs from the source marker");
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

    const catalogEvidence = {
      aclState: aclState(compose, RESTORE_DATABASE),
      ledger: restoredLedger,
      ownerState: ownershipState(compose, RESTORE_DATABASE),
      runtimeState: runtimeState(compose, RESTORE_DATABASE, credentials.runtime),
      schemaVersion: schemaVersion(compose, RESTORE_DATABASE),
      siblingSchemas: siblingSchemas(compose, RESTORE_DATABASE)
    };
    assertLumenCatalogEvidence(catalogEvidence);
    assertRuntimeDdlDenied(compose, RESTORE_DATABASE, credentials.runtime);

    result = {
      schemaVersion: 1,
      cell: "lumen",
      scope: "postgres-only",
      operationId,
      project,
      sourceDatabase: SOURCE_DATABASE,
      restoreDatabase: RESTORE_DATABASE,
      restoreOwner: restoredOwner,
      backupSha256: backup.digest,
      schemaSha256: sourceSchemaSha256,
      ledgerSha256: sha256(`${sourceLedger}\n`),
      aclSha256: sha256(`${catalogEvidence.aclState}\n${catalogEvidence.runtimeState}\n`),
      migrationCount: expectedMigrations.length,
      schemaVersionValue: 40,
      markerSha256: marker,
      runtimeRoleVerified: true,
      publicDatabasePrivilegesRevoked: true
    };
  } catch (error) {
    drillError = error;
  } finally {
    try {
      if (ownsProject) {
        runDocker([...compose, "down", "--volumes", "--rmi", "local", "--timeout", "10"], { inherit: true });
        assertProjectAbsent(listProjectResources(project), project);
      }
      dockerCleanupComplete = true;
    } catch (error) {
      drillError = drillError
        ? new AggregateError([drillError, error], "drill failed and isolated Docker cleanup also failed")
        : error;
    }
    if (dockerCleanupComplete) {
      for (const [root, prefix] of [
        [runtimeRoot, "hyperion-lumen-recovery-runtime."],
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
  }

  if (drillError) throw drillError;
  return { ...result, cleanupVerified: true };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const evidence = runDrill(options);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write("LUMEN_POSTGRES_RECOVERY_DRILL_VERIFIED=true\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
