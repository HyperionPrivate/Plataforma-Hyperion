import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRequiredCellResult } from "./verify-required-cell-result.mjs";

test("accepts only a successful affected cell or an explicitly skipped unaffected cell", () => {
  assert.equal(
    evaluateRequiredCellResult({
      cell: "nova",
      impactResult: "success",
      affected: "true",
      cellResult: "success"
    }).ok,
    true
  );
  assert.equal(
    evaluateRequiredCellResult({
      cell: "lumen",
      impactResult: "success",
      affected: "false",
      cellResult: "skipped"
    }).ok,
    true
  );
});

test("fails closed when impact fails, is cancelled, or produces no affected output", () => {
  for (const impactResult of ["failure", "cancelled", "skipped", ""]) {
    const verdict = evaluateRequiredCellResult({
      cell: "platform",
      impactResult,
      affected: "",
      cellResult: "skipped"
    });
    assert.equal(verdict.ok, false, impactResult);
    assert.match(verdict.reason, /impact job did not succeed/);
  }
});

test("rejects inconsistent affected and reusable-job results", () => {
  for (const [affected, cellResult] of [
    ["true", "failure"],
    ["true", "skipped"],
    ["false", "success"],
    ["false", "failure"],
    ["", "skipped"]
  ]) {
    assert.equal(
      evaluateRequiredCellResult({ cell: "pulso", impactResult: "success", affected, cellResult }).ok,
      false,
      `${affected}/${cellResult}`
    );
  }
});
