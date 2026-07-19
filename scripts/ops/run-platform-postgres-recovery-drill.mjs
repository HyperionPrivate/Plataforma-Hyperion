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
import { getPlatformRecoveryProvider } from "./platform-postgres-recovery-manifest.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const POSTGRES_IMAGE = "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const ADMIN_USER = "hyperion_platform_admin";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_PATTERN = /^hyperion-(access|audit)-recovery-acceptance(?:-[a-z0-9][a-z0-9-]{0,28})?$/;
const MAX_BUFFER = 64 * 1024 * 1024;

export const DRILL_CONFIRMATIONS = Object.freeze({
  access: "RUN ISOLATED ACCESS POSTGRES RECOVERY DRILL",
  audit: "RUN ISOLATED AUDIT POSTGRES RECOVERY DRILL"
});

export function parseArguments(argv, now = new Date(), randomSuffix = randomBytes(4).toString("hex")) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") {
      options.help = true;
      continue;
    }
    if (!["--provider", "--confirm", "--project"].includes(name)) throw new Error(`Unknown argument: ${name}`);
    const key = name.slice(2);
    if (options[key] !== undefined) throw new Error(`Duplicate argument: ${name}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    options[key] = value;
  }
  if (options.help) return options;
  if (!DRILL_CONFIRMATIONS[options.provider]) throw new Error("--provider must be access or audit");
  if (options.confirm !== DRILL_CONFIRMATIONS[options.provider]) {
    throw new Error(`--confirm must equal '${DRILL_CONFIRMATIONS[options.provider]}'`);
  }
  const operationId = compactUtc(now);
  const project =
    options.project ?? `hyperion-${options.provider}-recovery-acceptance-${operationId.toLowerCase()}-${randomSuffix}`;
  assertSafeProjectName(project, options.provider);
  return { ...options, operationId, project };
}

export function assertSafeProjectName(project, provider) {
  if (
    typeof project !== "string" ||
    !PROJECT_PATTERN.test(project) ||
    !project.startsWith(`hyperion-${provider}-recovery-acceptance`) ||
    project.length > 63
  ) {
    throw new Error(`--project must be an isolated ${provider} recovery project and contain at most 63 characters`);
  }
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

export function canonicalizeSchemaDump(value) {
  return normalizeSchemaDump(value)
    .split("\n")
    .filter((line) => !line.startsWith("--") && line.length > 0)
    .join("")
    .replace(/[\s()]+/g, "");
}

export function assertProviderRecoveryManifest(provider, root = repositoryRoot) {
  const manifest = getPlatformRecoveryProvider(provider);
  const migrationDirectory = path.join(root, manifest.migrationDirectory);
  const files = readdirSync(migrationDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const expected = manifest.migrationLedger.map(({ name }) => name);
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`${manifest.displayName} recovery manifest differs from provider SQL files`);
  }
  for (const migration of manifest.migrationLedger) {
    const sql = readFileSync(path.join(migrationDirectory, migration.name), "utf8").replaceAll("\r\n", "\n");
    if (sha256(sql) !== migration.checksum) {
      throw new Error(`${manifest.displayName} recovery manifest checksum drifted for ${migration.name}`);
    }
  }
  return manifest;
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
  node scripts/ops/run-platform-postgres-recovery-drill.mjs \\
    --provider access|audit --confirm "<exact provider confirmation>" [--project <isolated-project>]

Confirmations:
  ${DRILL_CONFIRMATIONS.access}
  ${DRILL_CONFIRMATIONS.audit}

The drill creates a fresh PostgreSQL-only Docker project, runs only the selected provider's
bootstrap/migrations/roles, exercises its production backup and restore wrappers, verifies the
exact ledger, schema, table inventory, marker data, owner and runtime database ACL, then removes
only resources carrying that isolated Compose project label.
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

function composeArgs(project, composeFile, environmentFile, composeProfile) {
  return ["compose", "-p", project, "--env-file", environmentFile, "-f", composeFile, "--profile", composeProfile];
}

function listProjectResources(project) {
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
    ])
  };
}

function assertProjectAbsent(resources, project) {
  const occupied = Object.entries(resources).filter(([, values]) => values.length > 0);
  if (occupied.length > 0) {
    throw new Error(
      `isolated Docker project ${project} already has resources: ${occupied
        .map(([kind, values]) => `${kind}=${values.join(",")}`)
        .join("; ")}`
    );
  }
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
  throw new Error("Bash 4+ is required for the platform backup and restore wrappers");
}

function toBashPath(bash, filePath) {
  if (process.platform !== "win32") return filePath;
  return run(bash, ["-lc", 'cygpath -u "$1"', "hyperion-cygpath", filePath]).trim();
}

function writeOpsFiles(root, project, provider, credentials) {
  const manifest = getPlatformRecoveryProvider(provider);
  const composeFile = path.join(root, `docker-compose.${provider}-ops.yml`);
  const environmentFile = path.join(root, `.${provider}-ops.env`);
  writeFileSync(
    composeFile,
    `name: ${project}\nservices:\n  postgres:\n    image: ${POSTGRES_IMAGE}\n    profiles: ["${manifest.composeProfile}"]\n    environment:\n      POSTGRES_USER: \${PLATFORM_POSTGRES_ADMIN_USER}\n      POSTGRES_PASSWORD: \${PLATFORM_POSTGRES_ADMIN_PASSWORD}\n      POSTGRES_DB: postgres\n    ports:\n      - "127.0.0.1::5432"\n    volumes:\n      - platform_recovery_data:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U \${PLATFORM_POSTGRES_ADMIN_USER} -d postgres"]\n      interval: 2s\n      timeout: 3s\n      retries: 30\nvolumes:\n  platform_recovery_data:\n`,
    { mode: 0o600 }
  );
  writeFileSync(
    environmentFile,
    `PLATFORM_POSTGRES_ADMIN_USER=${ADMIN_USER}\nPLATFORM_POSTGRES_ADMIN_PASSWORD=${credentials.admin}\n${provider.toUpperCase()}_POSTGRES_DB=${manifest.sourceDatabase}\n`,
    { mode: 0o600 }
  );
  return { composeFile, environmentFile };
}

function providerProcessEnvironment(provider, port, credentials) {
  const manifest = getPlatformRecoveryProvider(provider);
  const preserve = ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"];
  const environment = Object.fromEntries(
    preserve.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  );
  const adminUrl = postgresUrl(ADMIN_USER, credentials.admin, port, "postgres");
  const migratorUrl = postgresUrl(manifest.migratorRole, credentials.migrator, port, manifest.sourceDatabase);
  Object.assign(environment, { NODE_ENV: "development", HYPERION_ENVIRONMENT: "recovery-drill" });
  if (provider === "access") {
    Object.assign(environment, {
      ACCESS_POSTGRES_ADMIN_URL: adminUrl,
      ACCESS_POSTGRES_DB: manifest.sourceDatabase,
      ACCESS_MIGRATOR_DATABASE_URL: migratorUrl,
      ACCESS_MIGRATOR_DATABASE_PASSWORD: credentials.migrator,
      IDENTITY_DATABASE_PASSWORD: credentials.runtime[0],
      TENANT_DATABASE_PASSWORD: credentials.runtime[1]
    });
  } else {
    Object.assign(environment, {
      AUDIT_POSTGRES_ADMIN_URL: adminUrl,
      AUDIT_POSTGRES_DB: manifest.sourceDatabase,
      AUDIT_MIGRATOR_DATABASE_URL: migratorUrl,
      AUDIT_MIGRATOR_DATABASE_PASSWORD: credentials.migrator,
      AUDIT_DATABASE_PASSWORD: credentials.runtime[0]
    });
  }
  return environment;
}

function postgresUrl(user, password, port, database) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

function runProviderBootstrap(provider, port, credentials) {
  const manifest = getPlatformRecoveryProvider(provider);
  const packageDirectory = path.join(repositoryRoot, "packages", `${provider}-migrations`);
  const environment = providerProcessEnvironment(provider, port, credentials);
  run("pnpm", ["--filter", manifest.migrationPackage, "build"], { inherit: true });
  for (const entrypoint of ["bootstrap-database.js", "index.js", "bootstrap-roles.js"]) {
    run(process.execPath, [path.join(packageDirectory, "dist", entrypoint)], { env: environment, inherit: true });
  }
}

function wrapperEnvironment(bash, root, opsFiles, provider, additions) {
  const prefix = provider.toUpperCase();
  return {
    ...process.env,
    [`${prefix}_OPS_TEST_MODE`]: "1",
    [`${prefix}_OPS_TEST_ROOT`]: toBashPath(bash, root),
    [`${prefix}_OPS_COMPOSE_FILE`]: toBashPath(bash, opsFiles.composeFile),
    [`${prefix}_OPS_ENV_FILE`]: toBashPath(bash, opsFiles.environmentFile),
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
    ADMIN_USER,
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

function describeFirstSchemaDifference(source, restored) {
  const sourceLines = source.split("\n");
  const restoredLines = restored.split("\n");
  const length = Math.max(sourceLines.length, restoredLines.length);
  for (let index = 0; index < length; index += 1) {
    if (sourceLines[index] !== restoredLines[index]) {
      return `line ${index + 1}: source=${JSON.stringify(sourceLines[index])} restored=${JSON.stringify(restoredLines[index])}`;
    }
  }
  return "unknown difference";
}

function verifyLedger(compose, database, manifest) {
  const output = dockerPsql(
    compose,
    database,
    `select name || E'\\t' || checksum from ${manifest.ledgerTable} order by name`
  );
  const expected = manifest.migrationLedger.map(({ name, checksum }) => `${name}\t${checksum}`).join("\n");
  if (output !== expected) throw new Error(`${manifest.displayName} migration ledger differs from recovery manifest`);
  return output;
}

function verifyInventory(compose, database, manifest) {
  const schemas = dockerPsql(
    compose,
    database,
    "select nspname from pg_namespace where nspname not like 'pg_%' and nspname not in ('information_schema', 'public') order by nspname"
  );
  if (schemas !== [...manifest.schemas].sort().join("\n")) {
    throw new Error(`${manifest.displayName} restore contains missing or foreign schemas: ${schemas}`);
  }
  const tables = dockerPsql(
    compose,
    database,
    `select n.nspname || '.' || c.relname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname = any(array[${manifest.schemas.map(sqlLiteral).join(",")}])
      order by 1`
  );
  if (tables !== [...manifest.tables].sort().join("\n")) {
    throw new Error(`${manifest.displayName} restore table inventory differs from provider manifest`);
  }
  const triggers = dockerPsql(
    compose,
    database,
    `select namespace.nspname || '.' || relation.relname || '.' || trigger_catalog.tgname || '|' ||
            trigger_catalog.tgenabled
       from pg_trigger trigger_catalog
       join pg_class relation on relation.oid = trigger_catalog.tgrelid
       join pg_namespace namespace on namespace.oid = relation.relnamespace
      where not trigger_catalog.tgisinternal
        and namespace.nspname = any(array[${manifest.schemas.map(sqlLiteral).join(",")}])
      order by 1`
  );
  const expectedTriggers = Object.entries(manifest.triggers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([trigger, enabled]) => `${trigger}|${enabled}`)
    .join("\n");
  if (triggers !== expectedTriggers) {
    throw new Error(`${manifest.displayName} restore trigger inventory or enabled state drifted`);
  }
}

function verifyRuntimeDatabaseAcl(compose, database, manifest) {
  const databaseOutput = dockerPsql(
    compose,
    "postgres",
    `select role.rolname || '|' || role.rolcanlogin || '|' ||
            has_database_privilege(role.rolname, ${sqlLiteral(database)}, 'CONNECT') || '|' ||
            has_database_privilege(role.rolname, ${sqlLiteral(database)}, 'CREATE') || '|' ||
            has_database_privilege(role.rolname, ${sqlLiteral(database)}, 'TEMPORARY')
       from pg_roles role
      where role.rolname = any(array[${manifest.runtimeRoles.map(sqlLiteral).join(",")}])
      order by role.rolname`
  );
  const expected = [...manifest.runtimeRoles]
    .sort()
    .map((role) => `${role}|true|true|false|false`)
    .join("\n");
  if (databaseOutput !== expected) {
    throw new Error(`${manifest.displayName} runtime database ACL is not least-privilege`);
  }

  const schemaOutput = dockerPsql(
    compose,
    database,
    `select runtime_role || '|' || namespace.nspname || '|' || pg_get_userbyid(namespace.nspowner) || '|' ||
            has_schema_privilege(runtime_role, namespace.oid, 'USAGE') || '|' ||
            has_schema_privilege(runtime_role, namespace.oid, 'CREATE')
       from unnest(array[${manifest.runtimeRoles.map(sqlLiteral).join(",")}]) as runtime_roles(runtime_role)
       cross join pg_namespace namespace
      where namespace.nspname = any(array[${manifest.schemas.map(sqlLiteral).join(",")}])
      order by runtime_role, namespace.nspname`
  );
  const expectedSchemas = [...manifest.runtimeRoles]
    .sort()
    .flatMap((role) =>
      [...manifest.schemas].sort().map((schema) => `${role}|${schema}|${manifest.migratorRole}|true|false`)
    )
    .join("\n");
  if (schemaOutput !== expectedSchemas) {
    throw new Error(`${manifest.displayName} restored schema ownership or runtime ACL drifted`);
  }

  const privilegeOrder = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  const tableOutput = dockerPsql(
    compose,
    database,
    `select runtime_role || '|' || namespace.nspname || '.' || relation.relname || '|' ||
            pg_get_userbyid(relation.relowner) || '|' ||
            array_to_string(array_remove(array[
              case when has_table_privilege(runtime_role, relation.oid, 'SELECT') then 'SELECT' end,
              case when has_table_privilege(runtime_role, relation.oid, 'INSERT') then 'INSERT' end,
              case when has_table_privilege(runtime_role, relation.oid, 'UPDATE') then 'UPDATE' end,
              case when has_table_privilege(runtime_role, relation.oid, 'DELETE') then 'DELETE' end,
              case when has_table_privilege(runtime_role, relation.oid, 'TRUNCATE') then 'TRUNCATE' end,
              case when has_table_privilege(runtime_role, relation.oid, 'REFERENCES') then 'REFERENCES' end,
              case when has_table_privilege(runtime_role, relation.oid, 'TRIGGER') then 'TRIGGER' end
            ], null), ',')
       from unnest(array[${manifest.runtimeRoles.map(sqlLiteral).join(",")}]) as runtime_roles(runtime_role)
       cross join pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
      where relation.relkind = 'r'
        and namespace.nspname = any(array[${manifest.schemas.map(sqlLiteral).join(",")}])
      order by runtime_role, namespace.nspname, relation.relname`
  );
  const expectedTables = Object.entries(manifest.runtimeTablePrivileges)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([role, privilegesByTable]) =>
      Object.entries(privilegesByTable)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([table, privileges]) => {
          const orderedPrivileges = privilegeOrder.filter((privilege) => privileges.includes(privilege));
          return `${role}|${table}|${manifest.migratorRole}|${orderedPrivileges.join(",")}`;
        })
    )
    .join("\n");
  if (tableOutput !== expectedTables) {
    throw new Error(`${manifest.displayName} restored table ownership or runtime ACL drifted`);
  }

  const publicSchemaOutput = dockerPsql(
    compose,
    database,
    `select runtime_role || '|' || has_schema_privilege(runtime_role, 'public', 'CREATE')
       from unnest(array[${manifest.runtimeRoles.map(sqlLiteral).join(",")}]) as runtime_roles(runtime_role)
      order by runtime_role`
  );
  const expectedPublicSchema = [...manifest.runtimeRoles]
    .sort()
    .map((role) => `${role}|false`)
    .join("\n");
  if (publicSchemaOutput !== expectedPublicSchema) {
    throw new Error(`${manifest.displayName} restored public schema CREATE fence drifted`);
  }

  const routines = Object.keys(manifest.runtimeRoutinePrivileges);
  if (routines.length > 0) {
    const routineOutput = dockerPsql(
      compose,
      database,
      `select runtime_role || '|' || signature || '|' || pg_get_userbyid(routine.proowner) || '|' ||
              has_function_privilege(runtime_role, routine.oid, 'EXECUTE')
         from unnest(array[${manifest.runtimeRoles.map(sqlLiteral).join(",")}]) as runtime_roles(runtime_role)
         cross join unnest(array[${routines.map(sqlLiteral).join(",")}]) as routine_signatures(signature)
         join pg_proc routine on routine.oid = to_regprocedure(signature)
        order by runtime_role, signature`
    );
    const expectedRoutines = [...manifest.runtimeRoles]
      .sort()
      .flatMap((role) =>
        routines
          .sort()
          .map(
            (signature) =>
              `${role}|${signature}|${manifest.migratorRole}|${manifest.runtimeRoutinePrivileges[signature].includes(role)}`
          )
      )
      .join("\n");
    if (routineOutput !== expectedRoutines) {
      throw new Error(`${manifest.displayName} restored routine ownership or runtime ACL drifted`);
    }
  }
}

function parseKeyValueOutput(output) {
  const values = new Map();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

export function runDrill(options) {
  const { provider, operationId, project } = options;
  assertSafeProjectName(project, provider);
  if (!/^\d{8}T\d{6}Z$/.test(operationId)) throw new Error("operationId must be a compact UTC timestamp");
  const manifest = assertProviderRecoveryManifest(provider);
  runDocker(["version", "--format", "{{.Server.Version}}"]);
  runDocker(["compose", "version", "--short"]);
  assertProjectAbsent(listProjectResources(project), project);

  const credentials = {
    admin: `admin-${randomBytes(24).toString("hex")}`,
    migrator: `migrator-${randomBytes(24).toString("hex")}`,
    runtime: manifest.runtimeRoles.map((_, index) => `runtime-${index}-${randomBytes(24).toString("hex")}`)
  };
  let runtimeRoot;
  let backupRoot;
  let restoreRoot;
  let compose;
  let ownsProject = false;
  let dockerCleanupComplete = false;
  let result;
  let drillError;

  try {
    runtimeRoot = mkdtempSync(path.join(os.tmpdir(), `hyperion-${provider}-recovery-runtime.`));
    backupRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-backup-test."));
    restoreRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-restore-test."));
    const runtimeOps = writeOpsFiles(runtimeRoot, project, provider, credentials);
    const backupOps = writeOpsFiles(backupRoot, project, provider, credentials);
    const restoreOps = writeOpsFiles(restoreRoot, project, provider, credentials);
    compose = composeArgs(project, runtimeOps.composeFile, runtimeOps.environmentFile, manifest.composeProfile);
    const bash = resolveBash();
    ownsProject = true;
    runDocker([...compose, "up", "--detach", "--wait", "postgres"], { inherit: true });
    const portOutput = runDocker([...compose, "port", "postgres", "5432"]).trim();
    const port = Number(portOutput.match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`could not resolve isolated PostgreSQL host port: ${portOutput}`);
    }
    runProviderBootstrap(provider, port, credentials);

    dockerPsql(compose, manifest.sourceDatabase, `set role ${manifest.migratorRole}; ${manifest.markerInsertSql}`);
    verifyInventory(compose, manifest.sourceDatabase, manifest);
    const sourceLedger = verifyLedger(compose, manifest.sourceDatabase, manifest);
    const sourceSchema = schemaDump(compose, manifest.sourceDatabase);
    const sourceCanonicalSchema = canonicalizeSchemaDump(sourceSchema);
    const sourceSchemaSha256 = sha256(sourceCanonicalSchema);

    const prefix = provider.toUpperCase();
    const backupDirectory = path.join(backupRoot, "backups", provider);
    const backupWrapper = path.join(scriptDirectory, `${provider}-postgres-backup.sh`);
    const backupOutput = run(bash, [backupWrapper], {
      env: wrapperEnvironment(bash, backupRoot, backupOps, provider, {
        [`${prefix}_BACKUP_DIR`]: toBashPath(bash, backupDirectory),
        [`${prefix}_BACKUP_TIMESTAMP`]: operationId,
        [`${prefix}_POSTGRES_DB`]: manifest.sourceDatabase
      })
    });
    const backupValues = parseKeyValueOutput(backupOutput);
    const backupFile = `${provider}-${operationId}.dump.gz`;
    const backupDigest = backupValues.get("BACKUP_SHA256") ?? "";
    if (
      backupValues.get("BACKUP_FILE") !== backupFile ||
      backupValues.get("BACKUP_PROFILE") !== provider ||
      backupValues.get("BACKUP_DATABASE") !== manifest.sourceDatabase ||
      !SHA256_PATTERN.test(backupDigest)
    ) {
      throw new Error(`${manifest.displayName} backup wrapper reported invalid evidence`);
    }
    const backupArchive = path.join(backupDirectory, backupFile);
    if (!existsSync(backupArchive) || sha256(readFileSync(backupArchive)) !== backupDigest) {
      throw new Error(`${manifest.displayName} backup archive differs from its reported SHA-256`);
    }

    const restoreDirectory = path.join(restoreRoot, "backups", provider);
    mkdirSync(restoreDirectory, { recursive: true, mode: 0o700 });
    const restoreArchive = path.join(restoreDirectory, backupFile);
    copyFileSync(backupArchive, restoreArchive);
    const confirmation = `RESTORE ${prefix} ${manifest.restoreDatabase} SHA256 ${backupDigest}`;
    const restoreWrapper = path.join(scriptDirectory, `${provider}-postgres-restore.sh`);
    const restoreOutput = run(bash, [restoreWrapper], {
      env: wrapperEnvironment(bash, restoreRoot, restoreOps, provider, {
        [`${prefix}_BACKUP_DIR`]: toBashPath(bash, restoreDirectory),
        [`${prefix}_RESTORE_ARCHIVE`]: toBashPath(bash, restoreArchive),
        [`${prefix}_RESTORE_DATABASE`]: manifest.restoreDatabase,
        [`${prefix}_RESTORE_SHA256`]: backupDigest,
        [`${prefix}_RESTORE_CONFIRM`]: confirmation
      })
    });
    const restoreValues = parseKeyValueOutput(restoreOutput);
    if (
      restoreValues.get("RESTORE_PROFILE") !== provider ||
      restoreValues.get("RESTORE_DATABASE") !== manifest.restoreDatabase ||
      restoreValues.get("RESTORE_OWNER") !== manifest.migratorRole ||
      restoreValues.get("RESTORE_SHA256") !== backupDigest
    ) {
      throw new Error(`${manifest.displayName} restore wrapper reported invalid evidence`);
    }

    if (dockerPsql(compose, manifest.restoreDatabase, manifest.markerCountSql) !== "1") {
      throw new Error(`${manifest.displayName} restored marker is missing or duplicated`);
    }
    verifyInventory(compose, manifest.restoreDatabase, manifest);
    const restoredLedger = verifyLedger(compose, manifest.restoreDatabase, manifest);
    if (restoredLedger !== sourceLedger) throw new Error(`${manifest.displayName} restored ledger differs from source`);
    const restoredSchema = schemaDump(compose, manifest.restoreDatabase);
    const restoredSchemaSha256 = sha256(canonicalizeSchemaDump(restoredSchema));
    if (restoredSchemaSha256 !== sourceSchemaSha256) {
      throw new Error(
        `${manifest.displayName} restored schema differs from source (${describeFirstSchemaDifference(sourceSchema, restoredSchema)})`
      );
    }
    const restoredOwner = dockerPsql(
      compose,
      "postgres",
      `select pg_get_userbyid(datdba) from pg_database where datname = ${sqlLiteral(manifest.restoreDatabase)}`
    );
    if (restoredOwner !== manifest.migratorRole) {
      throw new Error(`${manifest.displayName} restored database has unexpected owner: ${restoredOwner}`);
    }
    verifyRuntimeDatabaseAcl(compose, manifest.restoreDatabase, manifest);

    result = {
      schemaVersion: 1,
      cell: "platform",
      provider,
      scope: "postgres-only",
      operationId,
      project,
      sourceDatabase: manifest.sourceDatabase,
      restoreDatabase: manifest.restoreDatabase,
      restoreOwner: restoredOwner,
      backupSha256: backupDigest,
      schemaSha256: sourceSchemaSha256,
      ledgerSha256: sha256(`${sourceLedger}\n`),
      migrationCount: manifest.migrationLedger.length,
      runtimeRoles: manifest.runtimeRoles,
      environmentScope: `${provider}-only`
    };
  } catch (error) {
    drillError = error;
  } finally {
    try {
      if (ownsProject && compose) {
        runDocker([...compose, "down", "--volumes", "--remove-orphans", "--timeout", "10"], { inherit: true });
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
        [runtimeRoot, `hyperion-${provider}-recovery-runtime.`],
        [backupRoot, "hyperion-backup-test."],
        [restoreRoot, "hyperion-restore-test."]
      ]) {
        if (root) safeRemoveTemporary(root, prefix);
      }
    } else {
      process.stderr.write(
        `Platform recovery drill temporary files retained for exact cleanup: ${[runtimeRoot, backupRoot, restoreRoot]
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
  process.stdout.write(`${options.provider.toUpperCase()}_POSTGRES_RECOVERY_DRILL_VERIFIED=true\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
