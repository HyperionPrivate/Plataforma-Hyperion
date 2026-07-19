import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DOCKER_ROUTING_OVERRIDE_VARIABLES,
  DRILL_CONFIRMATION,
  REAL_DRILL_FLAG,
  approvedSnapshotImages,
  assertApprovedSnapshotImage,
  assertDefaultDockerRouting,
  assertDockerInventoryPreserved,
  assertDrillOptions,
  assertInventoryEquals,
  assertRealDrillEnabled,
  captureDockerInventory,
  createInterruptionGuard,
  expectedDrillResources,
  inventoryForDirectory,
  parseArguments,
  parseKeyValueOutput,
  resolveDockerIdentity,
  writeSyntheticFixture
} from "./run-pulso-whatsapp-recovery-drill.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const approvedImage = "alpine@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40";

test("requires both the exact confirmation and the explicit real-Docker flag", () => {
  const options = parseArguments(["--confirm", DRILL_CONFIRMATION], new Date("2026-07-18T12:34:56.000Z"), "deadbeef");
  assert.equal(options.operationId, "20260718T123456Z");
  assert.equal(options.drillId, "20260718t123456z-deadbeef");
  assert.match(options.sourceProject, /^hyperion-pulso-whatsapp-test-s-/);
  assert.match(options.targetProject, /^hyperion-pulso-whatsapp-test-t-/);
  assert.notEqual(options.sourceProject, options.targetProject);
  assert.equal(options.sourceVolume, `${options.sourceProject}_pulso_whatsapp_sessions`);
  assert.equal(options.targetVolume, `${options.targetProject}_pulso_whatsapp_sessions`);
  assert.throws(() => parseArguments(["--confirm", "yes"]), /must equal/);
  assert.throws(() => parseArguments([]), /usage requires/);
  assert.throws(() => assertRealDrillEnabled({}), new RegExp(REAL_DRILL_FLAG));
  assert.doesNotThrow(() => assertRealDrillEnabled({ [REAL_DRILL_FLAG]: "1" }));
});

test("defers SIGINT and SIGTERM to an idempotent exact-cleanup checkpoint", async () => {
  const signals = new EventEmitter();
  const guard = createInterruptionGuard(signals);
  assert.equal(signals.listenerCount("SIGINT"), 1);
  assert.equal(signals.listenerCount("SIGTERM"), 1);
  signals.emit("SIGTERM");
  await assert.rejects(
    guard.checkpoint(),
    (error) => error.signal === "SIGTERM" && /exact cleanup required/.test(error.message)
  );
  await assert.doesNotReject(guard.checkpoint());
  guard.close();
  guard.close();
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("generates only narrow names for two isolated projects, volumes and helper containers", () => {
  const options = parseArguments(["--confirm", DRILL_CONFIRMATION], new Date("2026-07-18T12:34:56.000Z"), "deadbeef");
  const resources = expectedDrillResources(options);
  assert.deepEqual(resources.projects, [options.sourceProject, options.targetProject]);
  assert.deepEqual(resources.volumes, [options.sourceVolume, options.targetVolume]);
  assert.equal(new Set(resources.containerNames).size, resources.containerNames.length);
  for (const name of resources.containerNames) assert.match(name, /^hyperion-pulso-wa-[a-z0-9-]+$/);
  assert.ok(resources.containerNames.includes(`hyperion-pulso-wa-${options.drillId}-wrapper`));
  assert.throws(
    () => assertDrillOptions({ ...options, targetVolume: options.sourceVolume }),
    /target drill volume does not belong/
  );
  assert.throws(() => assertDrillOptions({ ...options, targetProject: options.sourceProject }), /projects must differ/);
});

test("rejects every ambient Docker routing override and seals only local endpoints", () => {
  for (const variable of DOCKER_ROUTING_OVERRIDE_VARIABLES) {
    assert.throws(() => assertDefaultDockerRouting({ [variable]: "" }), new RegExp(variable));
  }
  assert.deepEqual(
    resolveDockerIdentity(
      (args) => (args[1] === "show" ? "desktop-linux\n" : "npipe:////./pipe/dockerDesktopLinuxEngine\n"),
      "win32"
    ),
    { context: "desktop-linux", endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine" }
  );
  assert.deepEqual(
    resolveDockerIdentity((args) => (args[1] === "show" ? "default\n" : "unix:///var/run/docker.sock\n"), "linux"),
    { context: "default", endpoint: "unix:///var/run/docker.sock" }
  );
  assert.throws(
    () => resolveDockerIdentity((args) => (args[1] === "show" ? "remote" : "ssh://example/run/docker.sock"), "linux"),
    /requires a local/
  );
});

test("accepts only the versioned digest-pinned local helper", () => {
  const catalog = readFileSync(path.join(repositoryRoot, "infra", "pulso-whatsapp-snapshot-images.v1.txt"), "utf8");
  assert.deepEqual(approvedSnapshotImages(catalog), [approvedImage]);
  assert.doesNotThrow(() => assertApprovedSnapshotImage(approvedImage, catalog));
  assert.throws(() => assertApprovedSnapshotImage("alpine:latest", catalog), /pinned by digest/);
  assert.throws(
    () => assertApprovedSnapshotImage(`alpine@sha256:${"b".repeat(64)}`, catalog),
    /absent from the approved catalog/
  );
});

test("builds a Baileys-shaped synthetic fixture and a non-sensitive spool marker", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperion-pulso-whatsapp-fixture-test."));
  try {
    const fixture = writeSyntheticFixture(root);
    const credentials = JSON.parse(readFileSync(path.join(root, fixture.tenantId, "creds.json"), "utf8"));
    assert.equal(credentials.registered, true);
    assert.match(credentials.me.id, /@s\.whatsapp\.net$/);
    assert.match(fixture.spoolDirectory, /^\.channel-event-spool\/tenant-[a-f0-9]{64}$/);
    const spool = readFileSync(path.join(root, fixture.spoolDirectory, `${fixture.tenantId}.evt`), "utf8");
    assert.equal(spool, "synthetic-non-sensitive-spool-record-v1\n");
    assert.equal(fixture.inventory, inventoryForDirectory(root));
    assert.equal(fixture.inventory.trim().split("\n").length, 3);
    assert.doesNotMatch(fixture.inventory, /\.wwebjs_auth/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes exact inventories and rejects malformed or changed evidence", () => {
  const digest = "a".repeat(64);
  const inventory = `${digest}  ./tenant/creds.json\n`;
  assert.doesNotThrow(() => assertInventoryEquals(inventory, inventory.replaceAll("\n", "\r\n")));
  assert.throws(() => assertInventoryEquals(inventory, `${"b".repeat(64)}  ./tenant/creds.json\n`), /differs/);
  assert.throws(() => assertInventoryEquals(inventory, `${digest}  ../escape\n`), /invalid entry/);
});

test("parses unambiguous wrapper evidence and rejects duplicate keys", () => {
  const values = parseKeyValueOutput("A=one\nB=two=three\n");
  assert.equal(values.get("A"), "one");
  assert.equal(values.get("B"), "two=three");
  assert.throws(() => parseKeyValueOutput("A=one\nA=two\n"), /duplicate/);
});

test("compares sorted Docker resource rosters rather than only drill labels", () => {
  const docker = (args) => {
    if (args[0] === "ps") return "container-b|b|image\ncontainer-a|a|image\n";
    if (args[0] === "image") return "image-a|repo|tag|digest\n";
    if (args[0] === "network") return "network-a|bridge\n";
    if (args[0] === "volume") return "volume-b\nvolume-a\n";
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  const inventory = captureDockerInventory(docker);
  assert.deepEqual(inventory.volumes, ["volume-a", "volume-b"]);
  assert.doesNotThrow(() => assertDockerInventoryPreserved(inventory, structuredClone(inventory)));
  assert.throws(
    () => assertDockerInventoryPreserved(inventory, { ...inventory, volumes: ["volume-a"] }),
    /volumes inventory changed/
  );
});

test("runner and wrapper keep real Docker opt-in, test-only restore-as and two-phase rollback", () => {
  const runner = readFileSync(
    path.join(repositoryRoot, "scripts", "ops", "run-pulso-whatsapp-recovery-drill.mjs"),
    "utf8"
  );
  const wrapper = readFileSync(
    path.join(repositoryRoot, "scripts", "ops", "pulso-whatsapp-sessions-snapshot.sh"),
    "utf8"
  );

  const drillBody = runner.slice(runner.indexOf("export async function runDrill"));
  assert.ok(drillBody.indexOf("assertRealDrillEnabled(process.env)") < drillBody.indexOf("runDockerBootstrap"));
  assert.match(runner, /\["--host", sealedDockerEndpoint, \.\.\.args\]/);
  assert.doesNotMatch(runner, /docker["']?,\s*\[["']pull|\["pull"/);
  assert.match(runner, /com\.hyperion\.recovery-drill/);
  assert.match(runner, /assertDockerInventoryPreserved/);
  assert.match(runner, /PULSO_WHATSAPP_DRILL_ID/);
  assert.match(runner, /MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "\*"/);
  assert.match(runner, /export async function runDrill/);
  assert.match(runner, /cleanupDockerResources\(\);[\s\S]*finally \{[\s\S]*cleanupDockerResources\(\);/);

  assert.match(wrapper, /restore-as is forbidden outside test\/drill mode/);
  assert.match(wrapper, /restore-as target project must differ from the bundle source project/);
  assert.match(wrapper, /Docker endpoint changed after the drill runner sealed it/);
  assert.match(wrapper, /rollback_restore_volume/);
  assert.match(wrapper, /MSYS_NO_PATHCONV=1/);
  assert.match(wrapper, /\{\{\.Driver\}\}\|\{\{\.Scope\}\}\|\{\{json \.Options\}\}/);
  assert.match(wrapper, /expected_volume_identity=.*\|local\|local\|null/);
  assert.match(wrapper, /rollback_mode=external/);
  assert.match(wrapper, /trap 'exit 143' TERM/);
  assert.match(wrapper, /com\.hyperion\.recovery-drill/);
  assert.match(wrapper, /lock=\/sessions\/\.hyperion-restore-lock/);
  assert.match(wrapper, /"\$lock\/transaction"/);
  assert.match(wrapper, /"\$lock\/phase"/);
  assert.doesNotMatch(wrapper, /\|\| true/);
  const preserveBody = wrapper.slice(
    wrapper.indexOf("preserve_failed_transaction()"),
    wrapper.indexOf("set_phase()", wrapper.indexOf("preserve_failed_transaction()"))
  );
  assert.doesNotMatch(preserveBody, /\b(?:rm|mv)\b/, "failed helper mutates its retained rollback copy");
  const armedIndex = wrapper.indexOf("restore_transaction_active=1");
  const destructiveIndex = wrapper.indexOf("phase=initializing", armedIndex);
  assert.ok(armedIndex > 0 && destructiveIndex > armedIndex, "host rollback is not armed before destructive work");
  const compareIndex = wrapper.indexOf('if ! cmp -s -- "${inventory}" "${observed_inventory}"');
  const discardIndex = wrapper.indexOf("retained previous state could not be discarded safely");
  assert.ok(compareIndex > 0 && discardIndex > compareIndex, "previous state discard is not gated by inventory");
});
