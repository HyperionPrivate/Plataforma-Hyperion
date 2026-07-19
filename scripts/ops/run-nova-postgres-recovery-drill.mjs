#!/usr/bin/env node

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
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const standaloneCompose = path.join(repositoryRoot, "infra", "docker-compose.nova.yml");
const environmentExample = path.join(repositoryRoot, "infra", "nova.env.example");
const backupWrapper = path.join(scriptDirectory, "nova-postgres-backup.sh");
const restoreWrapper = path.join(scriptDirectory, "nova-postgres-restore.sh");

export const DRILL_CONFIRMATION = "RUN ISOLATED NOVA POSTGRES RECOVERY DRILL";
export const PROJECT_PREFIX = "hyperion-nova-recovery-acceptance";
const PROJECT_PATTERN = /^hyperion-nova-recovery-acceptance(?:-[a-z0-9][a-z0-9-]{0,30})?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_DATABASE = "hyperion_nova";
const RESTORE_DATABASE = "hyperion_nova_restore_drill";
const POSTGRES_ADMIN_USER = "hyperion_nova_admin";
const EXPECTED_RESTORED_DATABASE_ACL = [
  "t", // PUBLIC cannot CONNECT
  "t",
  "t",
  "t", // migrator: CONNECT, CREATE, TEMPORARY
  ...Array.from({ length: 4 }, () => ["t", "f", "f"]).flat() // runtimes: CONNECT only
].join("\t");

export function assertRestoredDatabaseAcl(value) {
  if (value !== EXPECTED_RESTORED_DATABASE_ACL) {
    throw new Error("restored NOVA database ACL does not match the least-privilege provider boundary");
  }
}
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
  return readdirSync(path.join(root, "packages", "nova-migrations", "sql"))
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
      // Supported PostgreSQL branches emit a fresh psql restriction token for
      // every pg_dump invocation. It is transport hardening, not schema state.
      .replace(/^\\restrict\s+\S+$/gm, "\\restrict <normalized>")
      .replace(/^\\unrestrict\s+\S+$/gm, "\\unrestrict <normalized>")
      .trimEnd() + "\n"
  );
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
  pnpm ops:nova:postgres:recovery:drill --confirm "${DRILL_CONFIRMATION}" [--project ${PROJECT_PREFIX}-<id>]

This opt-in drill creates only a fresh, isolated Docker Compose project, performs a real
PostgreSQL backup and restore, verifies schema/ledger/data equivalence, and removes the
project's containers, networks, volumes and locally tagged build images afterward.
It does not exercise the NOVA Documents/MinIO recovery procedure.
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
  throw new Error("Bash 4+ is required for the NOVA backup and restore wrappers");
}

function toBashPath(bash, filePath) {
  if (process.platform !== "win32") return filePath;
  return run(bash, ["-lc", 'cygpath -u "$1"', "hyperion-cygpath", filePath]).trim();
}

function writeOpsFiles(root, project) {
  const composeFile = path.join(root, "docker-compose.nova-ops.yml");
  const environmentFile = path.join(root, ".env.nova-ops");
  writeFileSync(
    composeFile,
    `name: ${project}\nservices:\n  postgres:\n    image: postgres:16-alpine\n    profiles: ["nova-ops"]\n`,
    { mode: 0o600 }
  );
  writeFileSync(environmentFile, `NOVA_POSTGRES_DB=${SOURCE_DATABASE}\n`, { mode: 0o600 });
  return { composeFile, environmentFile };
}

function wrapperEnvironment(bash, root, opsFiles, additions) {
  return {
    ...process.env,
    NOVA_OPS_TEST_MODE: "1",
    NOVA_OPS_TEST_ROOT: toBashPath(bash, root),
    NOVA_OPS_COMPOSE_FILE: toBashPath(bash, opsFiles.composeFile),
    NOVA_OPS_ENV_FILE: toBashPath(bash, opsFiles.environmentFile),
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
  return dockerPsql(compose, database, "select name || E'\\t' || checksum from nova.migration_ledger order by name");
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
    throw new Error(`source migration ledger differs from provider SQL files: ${names.join(", ")}`);
  }
  if (rows.some((row) => !/^\d{3}-.+\.sql\t[a-f0-9]{64}$/.test(row))) {
    throw new Error("source migration ledger contains an invalid name or checksum");
  }
}

function verifyBackupOutput(output, operationId) {
  const values = parseKeyValueOutput(output);
  const expectedFile = `nova-${operationId}.dump.gz`;
  if (values.get("BACKUP_FILE") !== expectedFile) throw new Error("backup wrapper reported an unexpected archive");
  if (values.get("BACKUP_PROFILE") !== "nova" || values.get("BACKUP_DATABASE") !== SOURCE_DATABASE) {
    throw new Error("backup wrapper did not report the exact NOVA source database");
  }
  const digest = values.get("BACKUP_SHA256") ?? "";
  if (!SHA256_PATTERN.test(digest)) throw new Error("backup wrapper did not report a valid SHA-256");
  return { digest, expectedFile, values };
}

function verifyRestoreOutput(output, expectedDigest) {
  const values = parseKeyValueOutput(output);
  if (
    values.get("RESTORE_PROFILE") !== "nova" ||
    values.get("RESTORE_DATABASE") !== RESTORE_DATABASE ||
    values.get("RESTORE_OWNER") !== "hyperion_nova_migrator" ||
    values.get("RESTORE_SHA256") !== expectedDigest
  ) {
    throw new Error("restore wrapper did not report the exact NOVA restore target and digest");
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
    runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-nova-recovery-runtime."));
    backupRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-backup-test."));
    restoreRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-restore-test."));
    const mainEnvironment = path.join(runtimeRoot, "nova.env");
    copyFileSync(environmentExample, mainEnvironment);
    const backupOps = writeOpsFiles(backupRoot, project);
    const restoreOps = writeOpsFiles(restoreRoot, project);
    compose = composeArgs(project, mainEnvironment);
    const bash = resolveBash();
    run(
      process.execPath,
      [path.join(repositoryRoot, "scripts", "docker", "generate-cell-contexts.mjs"), "--cell", "nova"],
      {
        inherit: true
      }
    );
    ownsProject = true;
    runDocker([...compose, "build", "nova-database-bootstrap", "nova-migrations", "nova-role-bootstrap"], {
      inherit: true
    });
    runDocker([...compose, "up", "--detach", "--wait", "postgres"], { inherit: true });
    for (const service of ["nova-database-bootstrap", "nova-migrations", "nova-role-bootstrap"]) {
      runDocker([...compose, "run", "--rm", "--no-deps", service], { inherit: true });
    }

    const marker = sha256(`${project}:${operationId}:${randomBytes(16).toString("hex")}`);
    dockerPsql(
      compose,
      SOURCE_DATABASE,
      `set role hyperion_nova_migrator;
       create table nova.recovery_drill_probe (
         operation_id text primary key,
         marker_sha256 text not null check (marker_sha256 ~ '^[a-f0-9]{64}$')
       );
       insert into nova.recovery_drill_probe(operation_id, marker_sha256)
       values (${sqlLiteral(operationId)}, ${sqlLiteral(marker)});`
    );

    const sourceLedger = migrationLedger(compose, SOURCE_DATABASE);
    const expectedMigrations = expectedMigrationFiles();
    assertLedgerMatchesFiles(sourceLedger, expectedMigrations);
    const sourceSchema = schemaDump(compose, SOURCE_DATABASE);
    const sourceSchemaSha256 = sha256(sourceSchema);

    const backupDirectory = path.join(backupRoot, "backups", "nova");
    const backupOutput = run(bash, [backupWrapper], {
      env: wrapperEnvironment(bash, backupRoot, backupOps, {
        NOVA_BACKUP_DIR: toBashPath(bash, backupDirectory),
        NOVA_BACKUP_TIMESTAMP: operationId,
        NOVA_POSTGRES_DB: SOURCE_DATABASE
      })
    });
    const backup = verifyBackupOutput(backupOutput, operationId);
    const backupArchive = path.join(backupDirectory, backup.expectedFile);
    if (!existsSync(backupArchive) || sha256(readFileSync(backupArchive)) !== backup.digest) {
      throw new Error("published backup archive does not match the wrapper SHA-256");
    }

    const restoreDirectory = path.join(restoreRoot, "backups", "nova");
    mkdirSync(restoreDirectory, { recursive: true, mode: 0o700 });
    const restoreArchive = path.join(restoreDirectory, backup.expectedFile);
    copyFileSync(backupArchive, restoreArchive);
    const restoreConfirmation = `RESTORE NOVA ${RESTORE_DATABASE} SHA256 ${backup.digest}`;
    const restoreOutput = run(bash, [restoreWrapper], {
      env: wrapperEnvironment(bash, restoreRoot, restoreOps, {
        NOVA_BACKUP_DIR: toBashPath(bash, restoreDirectory),
        NOVA_RESTORE_ARCHIVE: toBashPath(bash, restoreArchive),
        NOVA_RESTORE_DATABASE: RESTORE_DATABASE,
        NOVA_RESTORE_SHA256: backup.digest,
        NOVA_RESTORE_CONFIRM: restoreConfirmation
      })
    });
    verifyRestoreOutput(restoreOutput, backup.digest);

    const restoredMarker = dockerPsql(
      compose,
      RESTORE_DATABASE,
      `select marker_sha256 from nova.recovery_drill_probe where operation_id = ${sqlLiteral(operationId)}`
    );
    if (restoredMarker !== marker) throw new Error("restored recovery marker differs from the source marker");
    const restoredLedger = migrationLedger(compose, RESTORE_DATABASE);
    if (restoredLedger !== sourceLedger) throw new Error("restored migration ledger differs from the source ledger");
    const restoredSchema = schemaDump(compose, RESTORE_DATABASE);
    const restoredSchemaSha256 = sha256(restoredSchema);
    if (restoredSchemaSha256 !== sourceSchemaSha256) {
      throw new Error("restored schema dump differs from the source schema dump");
    }
    const restoredOwner = dockerPsql(
      compose,
      "postgres",
      `select pg_get_userbyid(datdba) from pg_database where datname = ${sqlLiteral(RESTORE_DATABASE)}`
    );
    if (restoredOwner !== "hyperion_nova_migrator") {
      throw new Error(`restored database has unexpected owner: ${restoredOwner}`);
    }
    const restoredAcl = dockerPsql(
      compose,
      RESTORE_DATABASE,
      `select concat_ws(E'\\t',
         not exists (
           select 1
             from pg_database database_entry,
                  aclexplode(coalesce(database_entry.datacl, acldefault('d', database_entry.datdba))) privilege
            where database_entry.datname = current_database()
              and privilege.grantee = 0
              and privilege.privilege_type = 'CONNECT'
         ),
         has_database_privilege('hyperion_nova_migrator', current_database(), 'CONNECT'),
         has_database_privilege('hyperion_nova_migrator', current_database(), 'CREATE'),
         has_database_privilege('hyperion_nova_migrator', current_database(), 'TEMPORARY'),
         has_database_privilege('hyperion_nova', current_database(), 'CONNECT'),
         has_database_privilege('hyperion_nova', current_database(), 'CREATE'),
         has_database_privilege('hyperion_nova', current_database(), 'TEMPORARY'),
         has_database_privilege('hyperion_voice', current_database(), 'CONNECT'),
         has_database_privilege('hyperion_voice', current_database(), 'CREATE'),
         has_database_privilege('hyperion_voice', current_database(), 'TEMPORARY'),
         has_database_privilege('hyperion_liwa', current_database(), 'CONNECT'),
         has_database_privilege('hyperion_liwa', current_database(), 'CREATE'),
         has_database_privilege('hyperion_liwa', current_database(), 'TEMPORARY'),
         has_database_privilege('hyperion_documents', current_database(), 'CONNECT'),
         has_database_privilege('hyperion_documents', current_database(), 'CREATE'),
         has_database_privilege('hyperion_documents', current_database(), 'TEMPORARY'))`
    );
    assertRestoredDatabaseAcl(restoredAcl);

    result = {
      schemaVersion: 1,
      cell: "nova",
      scope: "postgres-only",
      operationId,
      project,
      sourceDatabase: SOURCE_DATABASE,
      restoreDatabase: RESTORE_DATABASE,
      restoreOwner: restoredOwner,
      backupSha256: backup.digest,
      schemaSha256: sourceSchemaSha256,
      ledgerSha256: sha256(`${sourceLedger}\n`),
      migrationCount: expectedMigrations.length,
      markerSha256: marker
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
        [runtimeRoot, "hyperion-nova-recovery-runtime."],
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
  process.stdout.write("NOVA_POSTGRES_RECOVERY_DRILL_VERIFIED=true\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
