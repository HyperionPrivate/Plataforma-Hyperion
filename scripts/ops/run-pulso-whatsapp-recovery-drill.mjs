#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
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
const snapshotWrapper = path.join(scriptDirectory, "pulso-whatsapp-sessions-snapshot.sh");
const snapshotImageCatalog = path.join(repositoryRoot, "infra", "pulso-whatsapp-snapshot-images.v1.txt");
const MAX_BUFFER = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_PATTERN = /^hyperion-pulso-whatsapp-test-[a-z0-9][a-z0-9-]{0,30}$/;
const LOGICAL_VOLUME = "pulso_whatsapp_sessions";
const RECOVERY_KIND = "pulso-whatsapp";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const SPOOL_TENANT = createHash("sha256").update("synthetic-tenant").digest("hex");
const MUTATED_CREDS = '{"registered":false,"syntheticMutation":true}\n';
const MUTATION_MARKER = "synthetic-mutation-after-export\n";

export const DRILL_CONFIRMATION = "RUN ISOLATED PULSO WHATSAPP RECOVERY DRILL";
export const REAL_DRILL_FLAG = "HYPERION_RUN_REAL_PULSO_WHATSAPP_DRILL";
export const PROJECT_PREFIX = "hyperion-pulso-whatsapp-test";
export const DOCKER_ROUTING_OVERRIDE_VARIABLES = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY"
];

let sealedDockerEndpoint;

export function createInterruptionGuard(signalTarget = process) {
  let closed = false;
  let interruptedSignal;
  let interruptionReported = false;
  const handlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => {
        interruptedSignal ??= signal;
      }
    ])
  );
  for (const [signal, handler] of handlers) signalTarget.on(signal, handler);

  return {
    async checkpoint() {
      await new Promise((resolve) => setImmediate(resolve));
      if (interruptedSignal && !interruptionReported) {
        interruptionReported = true;
        const error = new Error(`WhatsApp recovery drill interrupted by ${interruptedSignal}; exact cleanup required`);
        error.signal = interruptedSignal;
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [signal, handler] of handlers) signalTarget.off(signal, handler);
    }
  };
}

export function parseArguments(argv, now = new Date(), randomSuffix = randomBytes(4).toString("hex")) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.length !== 2 || argv[0] !== "--confirm") {
    throw new Error(`usage requires --confirm '${DRILL_CONFIRMATION}'`);
  }
  if (argv[1] !== DRILL_CONFIRMATION) throw new Error(`--confirm must equal '${DRILL_CONFIRMATION}'`);
  if (!/^[a-f0-9]{8}$/.test(randomSuffix)) throw new Error("random drill suffix must be eight lowercase hex digits");
  const operationId = compactUtc(now);
  const compactOperation = operationId.toLowerCase();
  const sourceProject = `${PROJECT_PREFIX}-s-${compactOperation}-${randomSuffix}`;
  const targetProject = `${PROJECT_PREFIX}-t-${compactOperation}-${randomSuffix}`;
  assertSafeProject(sourceProject);
  assertSafeProject(targetProject);
  return {
    operationId,
    drillId: `${compactOperation}-${randomSuffix}`,
    sourceProject,
    sourceVolume: `${sourceProject}_${LOGICAL_VOLUME}`,
    targetProject,
    targetVolume: `${targetProject}_${LOGICAL_VOLUME}`
  };
}

export function assertRealDrillEnabled(environment = process.env) {
  if (environment[REAL_DRILL_FLAG] !== "1") {
    throw new Error(`${REAL_DRILL_FLAG}=1 is required in addition to the exact confirmation`);
  }
}

export function assertDefaultDockerRouting(environment = process.env) {
  const configured = DOCKER_ROUTING_OVERRIDE_VARIABLES.filter((name) =>
    Object.prototype.hasOwnProperty.call(environment, name)
  );
  if (configured.length > 0) {
    throw new Error(`WhatsApp recovery requires default Docker routing through HOME; unset: ${configured.join(", ")}`);
  }
}

export function resolveDockerIdentity(docker, platform = process.platform) {
  const context = docker(["context", "show"]).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context)) {
    throw new Error(`Docker returned an unsafe active context: ${context || "<empty>"}`);
  }
  const endpoint = docker(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]).trim();
  const localScheme = platform === "win32" ? "npipe://" : "unix://";
  if (!endpoint.startsWith(localScheme) || endpoint.length > 2048 || /[\r\n\0]/.test(endpoint)) {
    throw new Error(`WhatsApp recovery requires a local ${localScheme} Docker endpoint`);
  }
  return { context, endpoint };
}

export function assertSafeProject(project) {
  if (!PROJECT_PATTERN.test(project) || project.length > 63) {
    throw new Error(`isolated WhatsApp project must match ${PROJECT_PATTERN} and fit the Docker name limit`);
  }
}

export function expectedDrillResources(options) {
  assertDrillOptions(options);
  return {
    containerNames: [
      `hyperion-pulso-wa-${options.operationId.toLowerCase()}-seed-source`,
      `hyperion-pulso-wa-${options.operationId.toLowerCase()}-seed-target`,
      `hyperion-pulso-wa-${options.operationId.toLowerCase()}-mutate-source`,
      `hyperion-pulso-wa-${options.operationId.toLowerCase()}-verify-source`,
      `hyperion-pulso-wa-${options.operationId.toLowerCase()}-verify-target`,
      `hyperion-pulso-wa-${options.drillId}-wrapper`
    ],
    projects: [options.sourceProject, options.targetProject],
    volumes: [options.sourceVolume, options.targetVolume]
  };
}

export function assertDrillOptions(options) {
  assertSafeProject(options.sourceProject);
  assertSafeProject(options.targetProject);
  if (options.sourceProject === options.targetProject) throw new Error("source and target drill projects must differ");
  if (options.sourceVolume !== `${options.sourceProject}_${LOGICAL_VOLUME}`) {
    throw new Error("source drill volume does not belong exactly to its project");
  }
  if (options.targetVolume !== `${options.targetProject}_${LOGICAL_VOLUME}`) {
    throw new Error("target drill volume does not belong exactly to its project");
  }
  if (!/^\d{8}T\d{6}Z$/.test(options.operationId ?? "")) throw new Error("invalid drill operation id");
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(options.drillId ?? "")) throw new Error("invalid drill resource id");
}

export function parseKeyValueOutput(output) {
  const values = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (values.has(key)) throw new Error(`duplicate wrapper output key: ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

export function approvedSnapshotImages(contents = readFileSync(snapshotImageCatalog, "utf8")) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function assertApprovedSnapshotImage(image, contents) {
  if (!/^alpine@sha256:[a-f0-9]{64}$/.test(image ?? "")) {
    throw new Error("PULSO_WHATSAPP_SNAPSHOT_IMAGE must be an Alpine reference pinned by digest");
  }
  if (!approvedSnapshotImages(contents).includes(image)) {
    throw new Error("PULSO_WHATSAPP_SNAPSHOT_IMAGE is absent from the approved catalog");
  }
}

export function writeSyntheticFixture(root) {
  const tenantDirectory = path.join(root, TENANT_ID);
  const spoolDirectory = path.join(root, ".channel-event-spool", `tenant-${SPOOL_TENANT}`);
  mkdirSync(tenantDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(spoolDirectory, { recursive: true, mode: 0o700 });
  writePrivateJson(path.join(tenantDirectory, "creds.json"), {
    registered: true,
    me: { id: "synthetic:1@s.whatsapp.net", name: "PULSO recovery canary" },
    account: { details: "synthetic-non-production" }
  });
  writePrivateJson(path.join(tenantDirectory, "app-state-sync-key-synthetic.json"), {
    keyData: "c3ludGhldGljLW5vbi1zZWNyZXQ="
  });
  writeFileSync(path.join(spoolDirectory, `${TENANT_ID}.evt`), "synthetic-non-sensitive-spool-record-v1\n", {
    mode: 0o600
  });
  return {
    inventory: inventoryForDirectory(root),
    spoolDirectory: `.channel-event-spool/tenant-${SPOOL_TENANT}`,
    tenantId: TENANT_ID
  };
}

export function inventoryForDirectory(root) {
  const files = [];
  collectFiles(root, "", files);
  return files
    .map((relativePath) => {
      const digest = createHash("sha256")
        .update(readFileSync(path.join(root, relativePath)))
        .digest("hex");
      return `${digest}  ./${relativePath.replaceAll(path.sep, "/")}`;
    })
    .sort()
    .join("\n")
    .concat(files.length > 0 ? "\n" : "");
}

export function assertInventoryEquals(expected, observed, label = "restored target") {
  if (normalizeInventory(expected) !== normalizeInventory(observed)) {
    throw new Error(`${label} inventory differs from the exported bundle`);
  }
}

export function captureDockerInventory(docker) {
  return {
    containers: captureLines(docker(["ps", "-a", "--no-trunc", "--format", "{{.ID}}|{{.Names}}|{{.Image}}"])),
    images: captureLines(
      docker(["image", "ls", "--no-trunc", "--digests", "--format", "{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Digest}}"])
    ),
    networks: captureLines(docker(["network", "ls", "--no-trunc", "--format", "{{.ID}}|{{.Name}}"])),
    volumes: captureLines(docker(["volume", "ls", "--format", "{{.Name}}"]))
  };
}

export function assertDockerInventoryPreserved(before, after) {
  for (const kind of ["containers", "images", "networks", "volumes"]) {
    if (JSON.stringify(before[kind]) !== JSON.stringify(after[kind])) {
      throw new Error(`preexisting Docker ${kind} inventory changed during the isolated drill`);
    }
  }
}

function compactUtc(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("invalid drill timestamp");
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

function writePrivateJson(target, value) {
  writeFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function collectFiles(root, relativeDirectory, output) {
  const directory = path.join(root, relativeDirectory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`synthetic fixture contains a symbolic link: ${relativePath}`);
    if (entry.isDirectory()) collectFiles(root, relativePath, output);
    else if (entry.isFile()) output.push(relativePath);
    else throw new Error(`synthetic fixture contains an unsupported entry: ${relativePath}`);
  }
}

function normalizeInventory(value) {
  const lines = String(value).replaceAll("\r\n", "\n").split("\n").filter(Boolean);
  if (lines.some((line) => !/^[a-f0-9]{64} {2}\.\/[A-Za-z0-9._/-]+$/.test(line))) {
    throw new Error("inventory contains an invalid entry");
  }
  return `${[...lines].sort().join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

function captureLines(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: MAX_BUFFER,
    stdio: options.inherit ? "inherit" : "pipe",
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.error) throw new Error(`could not execute ${command}: ${result.error.message}`, { cause: result.error });
  if ((result.status ?? 1) !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function runDockerBootstrap(args) {
  return run("docker", args);
}

function runDocker(args, options) {
  if (!sealedDockerEndpoint) throw new Error("Docker endpoint is not sealed");
  return run("docker", ["--host", sealedDockerEndpoint, ...args], options);
}

function tryDocker(args) {
  try {
    return runDocker(args);
  } catch (error) {
    if (/no such (?:container|volume|object)|not found/i.test(String(error.message))) return null;
    throw error;
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
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("Bash 4+ is required for the WhatsApp recovery wrapper");
}

function toBashPath(bash, filePath) {
  if (process.platform !== "win32") return filePath;
  return run(bash, ["-lc", 'cygpath -u "$1"', "hyperion-cygpath", filePath]).trim();
}

function assertImagePresent(image) {
  const digests = runDocker(["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", image]);
  if (!captureLines(digests).includes(image)) throw new Error("local helper image does not expose the approved digest");
}

function listProjectResources(project) {
  return {
    containers: captureLines(
      runDocker(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"])
    ),
    networks: captureLines(
      runDocker(["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"])
    ),
    volumes: captureLines(
      runDocker(["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"])
    )
  };
}

function assertDrillResourcesAbsent(options) {
  const resources = expectedDrillResources(options);
  for (const project of resources.projects) {
    const found = listProjectResources(project);
    for (const [kind, names] of Object.entries(found)) {
      if (names.length > 0) throw new Error(`isolated ${project} already owns ${kind}: ${names.join(", ")}`);
    }
  }
  for (const name of resources.containerNames) {
    if (tryDocker(["container", "inspect", name, "--format", "{{.Name}}"]) !== null) {
      throw new Error(`isolated helper container name already exists: ${name}`);
    }
  }
  for (const name of resources.volumes) {
    if (tryDocker(["volume", "inspect", name, "--format", "{{.Name}}"]) !== null) {
      throw new Error(`isolated recovery volume name already exists: ${name}`);
    }
  }
  const labelledContainers = captureLines(
    runDocker([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=com.hyperion.recovery-drill=${options.drillId}`,
      "--filter",
      `label=com.hyperion.recovery-kind=${RECOVERY_KIND}`,
      "--format",
      "{{.ID}}|{{.Names}}"
    ])
  );
  if (labelledContainers.length > 0) {
    throw new Error(`isolated recovery drill identity already owns containers: ${labelledContainers.join(", ")}`);
  }
}

function createDrillVolume(project, volume, drillId) {
  return runDocker([
    "volume",
    "create",
    "--driver",
    "local",
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `com.docker.compose.volume=${LOGICAL_VOLUME}`,
    "--label",
    `com.hyperion.recovery-drill=${drillId}`,
    "--label",
    `com.hyperion.recovery-kind=${RECOVERY_KIND}`,
    volume
  ]).trim();
}

function assertVolumeIdentity(project, volume, drillId) {
  const identity = runDocker([
    "volume",
    "inspect",
    volume,
    "--format",
    '{{.Name}}|{{.Driver}}|{{.Scope}}|{{json .Options}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}|{{index .Labels "com.hyperion.recovery-drill"}}|{{index .Labels "com.hyperion.recovery-kind"}}'
  ]).trim();
  const expected = `${volume}|local|local|null|${project}|${LOGICAL_VOLUME}|${drillId}|${RECOVERY_KIND}`;
  if (identity !== expected) throw new Error(`isolated recovery volume identity mismatch: ${identity}`);
}

function helperBase(name, project, drillId, image) {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `com.hyperion.recovery-drill=${drillId}`,
    "--label",
    `com.hyperion.recovery-kind=${RECOVERY_KIND}`,
    "--pull=never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--entrypoint",
    "/bin/sh",
    image
  ];
}

function seedVolume({ drillId, fixture, image, name, project, volume }) {
  const bindSource = path.resolve(fixture);
  if (/[\r\n,]/.test(bindSource)) throw new Error("synthetic fixture path is unsafe for a Docker bind mount");
  const args = helperBase(name, project, drillId, image);
  args.splice(
    args.length - 3,
    0,
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--mount",
    `type=bind,src=${bindSource},dst=/fixture,readonly`,
    "--mount",
    `type=volume,src=${volume},dst=/sessions`
  );
  runDocker([...args, "-eu", "-c", "cp -a /fixture/. /sessions/; chown -R 1000:1000 /sessions; sync"]);
}

function mutateSource({ drillId, image, name, project, volume }) {
  const args = helperBase(name, project, drillId, image);
  args.splice(args.length - 3, 0, "--cap-add", "DAC_OVERRIDE", "--mount", `type=volume,src=${volume},dst=/sessions`);
  runDocker([
    ...args,
    "-eu",
    "-c",
    `printf '%s' '${MUTATED_CREDS}' > /sessions/${TENANT_ID}/creds.json; printf '%s' '${MUTATION_MARKER}' > /sessions/source-mutated-after-export.txt; sync`
  ]);
}

function volumeInventory({ drillId, image, name, project, volume }) {
  const args = helperBase(name, project, drillId, image);
  args.splice(args.length - 3, 0, "--user", "1000:1000", "--mount", `type=volume,src=${volume},dst=/sessions,readonly`);
  return runDocker([
    ...args,
    "-eu",
    "-c",
    "cd /sessions; test ! -e .hyperion-restore-staging; test ! -e .hyperion-restore-previous; find . -mindepth 1 -type f -exec sha256sum {} \\; | LC_ALL=C sort"
  ]);
}

function wrapperEnvironment(bash, root, image, sourceProject, additions = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("PULSO_WHATSAPP_") && !name.startsWith("PULSO_OPS_")
    )
  );
  return {
    ...inherited,
    ...(process.platform === "win32" ? { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } : {}),
    PULSO_OPS_TEST_MODE: "1",
    PULSO_OPS_TEST_ROOT: toBashPath(bash, root),
    PULSO_WHATSAPP_BACKUP_DIR: toBashPath(bash, path.join(root, "backups", "pulso", "whatsapp-sessions")),
    PULSO_WHATSAPP_COMPOSE_PROJECT: sourceProject,
    PULSO_WHATSAPP_DRILL_ID: additions.PULSO_WHATSAPP_DRILL_ID,
    PULSO_WHATSAPP_EXPECTED_DOCKER_ENDPOINT: sealedDockerEndpoint,
    PULSO_WHATSAPP_SNAPSHOT_IMAGE: image,
    ...additions
  };
}

function verifyExportOutput(output, options) {
  const values = parseKeyValueOutput(output);
  if (
    values.get("WHATSAPP_SESSIONS_PROJECT") !== options.sourceProject ||
    values.get("WHATSAPP_SESSIONS_VOLUME") !== options.sourceVolume
  ) {
    throw new Error("snapshot wrapper reported an unexpected source identity");
  }
  for (const key of [
    "WHATSAPP_SESSIONS_ARCHIVE_SHA256",
    "WHATSAPP_SESSIONS_INVENTORY_SHA256",
    "WHATSAPP_SESSIONS_BUNDLE_SHA256"
  ]) {
    if (!SHA256_PATTERN.test(values.get(key) ?? "")) throw new Error(`snapshot wrapper reported invalid ${key}`);
  }
  return values;
}

function verifyRestoreOutput(output, options, bundleSha) {
  const values = parseKeyValueOutput(output);
  const expected = new Map([
    ["WHATSAPP_SESSIONS_PROJECT", options.targetProject],
    ["WHATSAPP_SESSIONS_VOLUME", options.targetVolume],
    ["WHATSAPP_SESSIONS_SOURCE_PROJECT", options.sourceProject],
    ["WHATSAPP_SESSIONS_SOURCE_VOLUME", options.sourceVolume],
    ["WHATSAPP_SESSIONS_RESTORE_AS", "true"],
    ["WHATSAPP_SESSIONS_BUNDLE_SHA256", bundleSha]
  ]);
  for (const [key, value] of expected) {
    if (values.get(key) !== value) throw new Error(`restore-as wrapper reported unexpected ${key}`);
  }
}

function removeOwnedContainer(name, drillId) {
  const identity = tryDocker([
    "container",
    "inspect",
    name,
    "--format",
    '{{.Name}}|{{index .Config.Labels "com.hyperion.recovery-drill"}}|{{index .Config.Labels "com.hyperion.recovery-kind"}}'
  ]);
  if (identity === null) return;
  if (identity.trim() !== `/${name}|${drillId}|${RECOVERY_KIND}`) {
    throw new Error(`refusing to remove helper container with mismatched identity: ${name}`);
  }
  runDocker(["container", "rm", "--force", name]);
}

function removeOwnedRecoveryContainers(options) {
  const expectedNames = new Set(expectedDrillResources(options).containerNames);
  const candidates = captureLines(
    runDocker([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=com.hyperion.recovery-drill=${options.drillId}`,
      "--filter",
      `label=com.hyperion.recovery-kind=${RECOVERY_KIND}`,
      "--format",
      "{{.ID}}"
    ])
  );
  for (const id of candidates) {
    const identity = runDocker([
      "container",
      "inspect",
      id,
      "--format",
      '{{.Id}}|{{.Name}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.hyperion.recovery-drill"}}|{{index .Config.Labels "com.hyperion.recovery-kind"}}'
    ]).trim();
    const [observedId, observedName, project, drillId, kind] = identity.split("|");
    if (
      observedId !== id ||
      !expectedNames.has(observedName.replace(/^\//, "")) ||
      ![options.sourceProject, options.targetProject].includes(project) ||
      drillId !== options.drillId ||
      kind !== RECOVERY_KIND
    ) {
      throw new Error(`refusing to remove a container with mismatched recovery identity: ${id}`);
    }
    runDocker(["container", "rm", "--force", id]);
  }
}

function removeOwnedVolume(project, volume, drillId) {
  const identity = tryDocker([
    "volume",
    "inspect",
    volume,
    "--format",
    '{{.Name}}|{{.Driver}}|{{.Scope}}|{{json .Options}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}|{{index .Labels "com.hyperion.recovery-drill"}}|{{index .Labels "com.hyperion.recovery-kind"}}'
  ]);
  if (identity === null) return;
  if (identity.trim() !== `${volume}|local|local|null|${project}|${LOGICAL_VOLUME}|${drillId}|${RECOVERY_KIND}`) {
    throw new Error(`refusing to remove recovery volume with mismatched identity: ${volume}`);
  }
  runDocker(["volume", "rm", volume]);
}

function safeRemoveTemporary(root) {
  const resolved = path.resolve(root);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(resolved) !== temporaryRoot ||
    !path.basename(resolved).startsWith("hyperion-pulso-whatsapp-test.") ||
    resolved === temporaryRoot
  ) {
    throw new Error(`refusing to remove unexpected recovery path: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

export async function runDrill(options) {
  assertRealDrillEnabled(process.env);
  assertDefaultDockerRouting(process.env);
  if (sealedDockerEndpoint) throw new Error("a WhatsApp recovery drill is already active in this process");
  const resources = expectedDrillResources(options);
  const image = process.env.PULSO_WHATSAPP_SNAPSHOT_IMAGE?.trim() ?? "";
  assertApprovedSnapshotImage(image);

  runDockerBootstrap(["version", "--format", "{{.Server.Version}}"]);
  const identity = resolveDockerIdentity(runDockerBootstrap);
  sealedDockerEndpoint = identity.endpoint;
  try {
    runDocker(["version", "--format", "{{.Server.Version}}"]);
    assertImagePresent(image);
  } catch (error) {
    sealedDockerEndpoint = undefined;
    throw error;
  }

  let temporaryRoot;
  let baseline;
  let dockerCleanupComplete = false;
  let ownsResourceNamespace = false;
  let result;
  let drillError;
  const createdVolumes = [];
  const interruptionGuard = createInterruptionGuard();
  const cleanupDockerResources = () => {
    if (!ownsResourceNamespace) {
      dockerCleanupComplete = true;
      return;
    }
    removeOwnedRecoveryContainers(options);
    for (const name of resources.containerNames) removeOwnedContainer(name, options.drillId);
    for (const [project, volume] of [...createdVolumes].reverse()) removeOwnedVolume(project, volume, options.drillId);
    createdVolumes.length = 0;
    assertDrillResourcesAbsent(options);
    if (baseline) assertDockerInventoryPreserved(baseline, captureDockerInventory(runDocker));
    dockerCleanupComplete = true;
  };

  try {
    assertDrillResourcesAbsent(options);
    ownsResourceNamespace = true;
    baseline = captureDockerInventory(runDocker);
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "hyperion-pulso-whatsapp-test."));
    chmodSync(temporaryRoot, 0o700);
    await interruptionGuard.checkpoint();
    const sourceFixture = path.join(temporaryRoot, "source-fixture");
    const targetFixture = path.join(temporaryRoot, "target-fixture");
    mkdirSync(sourceFixture, { mode: 0o700 });
    mkdirSync(targetFixture, { mode: 0o700 });
    const fixture = writeSyntheticFixture(sourceFixture);
    writeFileSync(path.join(targetFixture, "target-before-restore.txt"), "synthetic-target-state\n", { mode: 0o600 });

    createdVolumes.push([options.sourceProject, options.sourceVolume]);
    const createdSourceVolume = createDrillVolume(options.sourceProject, options.sourceVolume, options.drillId);
    if (createdSourceVolume !== options.sourceVolume) {
      throw new Error(`Docker created an unexpected source volume: ${createdSourceVolume}`);
    }
    assertVolumeIdentity(options.sourceProject, options.sourceVolume, options.drillId);
    await interruptionGuard.checkpoint();
    createdVolumes.push([options.targetProject, options.targetVolume]);
    const createdTargetVolume = createDrillVolume(options.targetProject, options.targetVolume, options.drillId);
    if (createdTargetVolume !== options.targetVolume) {
      throw new Error(`Docker created an unexpected target volume: ${createdTargetVolume}`);
    }
    assertVolumeIdentity(options.targetProject, options.targetVolume, options.drillId);
    await interruptionGuard.checkpoint();

    seedVolume({
      fixture: sourceFixture,
      image,
      name: resources.containerNames[0],
      drillId: options.drillId,
      project: options.sourceProject,
      volume: options.sourceVolume
    });
    await interruptionGuard.checkpoint();
    seedVolume({
      fixture: targetFixture,
      image,
      name: resources.containerNames[1],
      drillId: options.drillId,
      project: options.targetProject,
      volume: options.targetVolume
    });
    await interruptionGuard.checkpoint();

    const bash = resolveBash();
    const exportOutput = run(bash, [snapshotWrapper, "export"], {
      env: wrapperEnvironment(bash, temporaryRoot, image, options.sourceProject, {
        PULSO_WHATSAPP_DRILL_ID: options.drillId,
        PULSO_WHATSAPP_SNAPSHOT_TIMESTAMP: options.operationId
      })
    });
    await interruptionGuard.checkpoint();
    const exportValues = verifyExportOutput(exportOutput, options);
    const snapshotDirectory = path.join(
      temporaryRoot,
      "backups",
      "pulso",
      "whatsapp-sessions",
      `pulso-whatsapp-sessions-${options.operationId}`
    );
    const bundleInventory = readFileSync(path.join(snapshotDirectory, "inventory.tsv"), "utf8");
    assertInventoryEquals(fixture.inventory, bundleInventory, "synthetic source fixture");

    mutateSource({
      image,
      name: resources.containerNames[2],
      drillId: options.drillId,
      project: options.sourceProject,
      volume: options.sourceVolume
    });
    await interruptionGuard.checkpoint();

    const archiveSha = exportValues.get("WHATSAPP_SESSIONS_ARCHIVE_SHA256");
    const bundleSha = exportValues.get("WHATSAPP_SESSIONS_BUNDLE_SHA256");
    const confirmation =
      `RESTORE PULSO WHATSAPP ${options.sourceProject}/${options.sourceVolume} ` +
      `AS ${options.targetProject}/${options.targetVolume} BUNDLE SHA256 ${bundleSha}`;
    const restoreOutput = run(bash, [snapshotWrapper, "restore"], {
      env: wrapperEnvironment(bash, temporaryRoot, image, options.sourceProject, {
        PULSO_WHATSAPP_DRILL_ID: options.drillId,
        PULSO_WHATSAPP_ARCHIVE_SHA256: archiveSha,
        PULSO_WHATSAPP_BUNDLE_SHA256: bundleSha,
        PULSO_WHATSAPP_RESTORE_CONFIRM: confirmation,
        PULSO_WHATSAPP_RESTORE_TARGET_PROJECT: options.targetProject,
        PULSO_WHATSAPP_RESTORE_TARGET_VOLUME: options.targetVolume,
        PULSO_WHATSAPP_SNAPSHOT_DIRECTORY: toBashPath(bash, snapshotDirectory)
      })
    });
    await interruptionGuard.checkpoint();
    verifyRestoreOutput(restoreOutput, options, bundleSha);

    const targetInventory = volumeInventory({
      image,
      name: resources.containerNames[4],
      drillId: options.drillId,
      project: options.targetProject,
      volume: options.targetVolume
    });
    assertInventoryEquals(bundleInventory, targetInventory);
    await interruptionGuard.checkpoint();
    const sourceInventory = volumeInventory({
      image,
      name: resources.containerNames[3],
      drillId: options.drillId,
      project: options.sourceProject,
      volume: options.sourceVolume
    });
    await interruptionGuard.checkpoint();
    if (normalizeInventory(sourceInventory) === normalizeInventory(bundleInventory)) {
      throw new Error("source mutation after export was not preserved independently from restore-as");
    }
    for (const [relativePath, contents] of [
      [`${TENANT_ID}/creds.json`, MUTATED_CREDS],
      ["source-mutated-after-export.txt", MUTATION_MARKER]
    ]) {
      const expectedLine = `${createHash("sha256").update(contents).digest("hex")}  ./${relativePath}`;
      if (!normalizeInventory(sourceInventory).split("\n").includes(expectedLine)) {
        throw new Error(`source mutation evidence is missing ${relativePath}`);
      }
    }

    result = {
      operationId: options.operationId,
      drillId: options.drillId,
      scope: "synthetic-whatsapp-volume-only",
      dockerContext: identity.context,
      dockerEndpointSha256: createHash("sha256").update(identity.endpoint).digest("hex"),
      helperImage: image,
      sourceProject: options.sourceProject,
      sourceVolume: options.sourceVolume,
      targetProject: options.targetProject,
      targetVolume: options.targetVolume,
      archiveSha256: archiveSha,
      bundleSha256: bundleSha,
      inventorySha256: createHash("sha256").update(normalizeInventory(bundleInventory)).digest("hex"),
      fixtureFileCount: normalizeInventory(bundleInventory).trim().split("\n").filter(Boolean).length,
      sourceMutationPreserved: true,
      targetInventoryVerified: true,
      realWhatsAppSessionUsed: false,
      externalNetworkUsed: false
    };

    cleanupDockerResources();
    await interruptionGuard.checkpoint();
  } catch (error) {
    drillError = error;
  } finally {
    try {
      cleanupDockerResources();
    } catch (error) {
      drillError = drillError
        ? new AggregateError([drillError, error], "WhatsApp drill failed and exact Docker cleanup also failed")
        : error;
    }
    try {
      await interruptionGuard.checkpoint();
    } catch (error) {
      drillError = drillError
        ? new AggregateError([drillError, error], "WhatsApp drill was interrupted during exact cleanup")
        : error;
    }
    interruptionGuard.close();
    if (temporaryRoot && dockerCleanupComplete) safeRemoveTemporary(temporaryRoot);
    else if (temporaryRoot)
      process.stderr.write(`WhatsApp drill files retained for manual cleanup: ${temporaryRoot}\n`);
    sealedDockerEndpoint = undefined;
  }

  if (drillError) throw drillError;
  return { ...result, cleanupVerified: true };
}

function usage() {
  return `Usage:
  ${REAL_DRILL_FLAG}=1 PULSO_WHATSAPP_SNAPSHOT_IMAGE=<approved-local-digest> \\
    node scripts/ops/run-pulso-whatsapp-recovery-drill.mjs \\
    --confirm "${DRILL_CONFIRMATION}"

This opt-in drill never pulls an image and never reads a production session volume.
It creates two randomly named, labelled local volumes, writes only a synthetic Baileys-shaped
fixture and non-sensitive spool marker, exports the source, mutates it, restores the immutable
bundle into the second volume through test-only restore-as, verifies exact inventories, and
removes only resources whose names and labels match this operation.
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const evidence = await runDrill(options);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write("PULSO_WHATSAPP_SYNTHETIC_RECOVERY_DRILL_VERIFIED=true\n");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
