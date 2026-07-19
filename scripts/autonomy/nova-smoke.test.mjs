import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./nova-smoke.e2e.mjs", import.meta.url), "utf8");

test("NOVA smoke uses the isolated cookie and CSRF browser contract", () => {
  assert.match(source, /\/v1\/auth\/login/);
  assert.match(source, /x-requested-with.*nova-console/s);
  assert.match(source, /__Host-hyperion-nova-session/);
  assert.match(source, /__Host-hyperion-nova-csrf/);
  assert.match(source, /"x-csrf-token"/);
  assert.doesNotMatch(source, /NOVA_SMOKE_TOKEN/);
  assert.doesNotMatch(source, /authorization:\s*`Bearer/);
});

test("NOVA smoke proves cross-tenant and cross-product denials", () => {
  assert.match(source, /forbiddenTenantId/);
  assert.match(source, /allowStatuses: \[403\]/);
  assert.match(source, /\/lumen\/encounters/);
  assert.match(source, /allowStatuses: \[404\]/);
});
