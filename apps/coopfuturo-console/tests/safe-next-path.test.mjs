import assert from "node:assert/strict";
import test from "node:test";

import { safeNextPath } from "../src/lib/safe-next-path.ts";

const FALLBACK_PATH = "/dashboard";

test("safeNextPath preserves internal paths with query strings and fragments", () => {
  for (const value of [
    "/dashboard",
    "/reportes?periodo=30d",
    "/conversaciones/abc-123#actividad",
    "/crm?filtro=activo#asociado-42",
    "/reportes/campa%C3%B1as?estado=activa",
  ]) {
    assert.equal(safeNextPath(value), value);
  }
});

test("safeNextPath rejects empty, absolute, scheme, and protocol-relative destinations", () => {
  for (const value of [
    null,
    "",
    "dashboard",
    "https://attacker.example/collect",
    "http://attacker.example/collect",
    "javascript:alert(1)",
    "data:text/html,attack",
    "//attacker.example/collect",
    "///attacker.example/collect",
    "https:%2f%2fattacker.example/collect",
  ]) {
    assert.equal(safeNextPath(value), FALLBACK_PATH, String(value));
  }
});

test("safeNextPath rejects raw, encoded, and nested-encoded backslashes", () => {
  for (const value of [
    String.raw`/\attacker.example/collect`,
    String.raw`/safe\..\..\attacker.example`,
    "/%5cattacker.example/collect",
    "/%5C%5Cattacker.example/collect",
    "/%255cattacker.example/collect",
    "/%25255Cattacker.example/collect",
    "/%25%35%63attacker.example/collect",
    "/dashboard?return=%5cattacker.example",
  ]) {
    assert.equal(safeNextPath(value), FALLBACK_PATH, value);
  }
});

test("safeNextPath rejects encoded protocol-relative destinations", () => {
  for (const value of [
    "/%2fattacker.example/collect",
    "/%2F%2Fattacker.example/collect",
    "/%252fattacker.example/collect",
    "/%25252Fattacker.example/collect",
    "/%25%32%66attacker.example/collect",
    "/%2f%5cattacker.example/collect",
  ]) {
    assert.equal(safeNextPath(value), FALLBACK_PATH, value);
  }
});
