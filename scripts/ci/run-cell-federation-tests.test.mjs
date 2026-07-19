import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CELL_FEDERATION_TESTS,
  COMMON_FEDERATION_TESTS,
  federationTestsForCell,
  parseCellFederationArguments,
  runCellFederationTests
} from "./run-cell-federation-tests.mjs";

test("selects common controls plus only the owning cell federation tests", () => {
  for (const cell of ["platform", "nova", "lumen", "pulso"]) {
    assert.deepEqual(federationTestsForCell(cell), [...COMMON_FEDERATION_TESTS, ...CELL_FEDERATION_TESTS[cell]]);
  }
  for (const cell of ["platform", "lumen", "pulso"]) {
    assert.equal(
      federationTestsForCell(cell).some((file) => /(?:^|[/-])nova(?:[/-]|\.)/i.test(file)),
      false,
      `${cell} must not execute NOVA federation tests`
    );
  }
  assert.ok(federationTestsForCell("nova").some((file) => file.endsWith("nova-standalone-compose.test.mjs")));
  assert.ok(federationTestsForCell("platform").some((file) => file.endsWith("platform-standalone-compose.test.mjs")));
});

test("passes the exact selected files to the Node test runner", async () => {
  let invocation;
  const spawn = (executable, arguments_, options) => {
    invocation = { executable, arguments_, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const selected = await runCellFederationTests("lumen", { spawn });
  assert.deepEqual(invocation.arguments_, ["--test", ...selected]);
  assert.equal(invocation.options.stdio, "inherit");
});

test("fails closed for invalid arguments and child failures", async () => {
  assert.throws(() => parseCellFederationArguments([]), /--cell is required/);
  assert.throws(() => parseCellFederationArguments(["--cell", "other"]), /Unknown cell/);
  assert.deepEqual(parseCellFederationArguments(["--", "--cell", "pulso", "--list"]), {
    cell: "pulso",
    list: true
  });

  const spawn = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 9, null));
    return child;
  };
  await assert.rejects(runCellFederationTests("pulso", { spawn }), /exit code 9/);
});
