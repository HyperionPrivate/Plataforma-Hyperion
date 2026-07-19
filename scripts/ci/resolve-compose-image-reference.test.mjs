import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposeImageReference } from "./resolve-compose-image-reference.mjs";

test("resolves Compose explicit images and deterministic build-owned defaults without containers", () => {
  const model = {
    services: {
      "audit-migrations": { build: { context: ".", target: "audit-migrations" }, image: "hyperion/audit:local" },
      "nova-bff": { build: { context: ".", target: "nova-bff" } }
    }
  };
  assert.equal(
    resolveComposeImageReference(model, "hyperion-platform-audit", "audit-migrations"),
    "hyperion/audit:local"
  );
  assert.equal(resolveComposeImageReference(model, "hyperion-nova-bff", "nova-bff"), "hyperion-nova-bff-nova-bff");
});

test("rejects missing, third-party and unsafe image resolution scopes", () => {
  const model = { services: { postgres: { image: "postgres:16" }, "nova-bff": { build: { context: "." } } } };
  assert.throws(() => resolveComposeImageReference(model, "unsafe/project", "nova-bff"), /project name is unsafe/);
  assert.throws(() => resolveComposeImageReference(model, "hyperion-nova", "missing"), /does not exist/);
  assert.throws(() => resolveComposeImageReference(model, "hyperion-nova", "postgres"), /not build-owned/);
});
