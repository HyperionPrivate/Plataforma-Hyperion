import assert from "node:assert/strict";
import test from "node:test";
import policy from "../../infra/compatibility-policy.json" with { type: "json" };
import { resolveNMinusOneCapabilities, validatePolicy } from "./resolve-n-minus-one-capabilities.mjs";

const LEGACY_SHA = "f89a42d8a4e3da8936c1848af25fe119cc4e1438";
const CURRENT_SHA = "c5497f83ebf9e57796e80aa749dd7cbdbcc7e145";

test("resolves the exact pre-descriptor foundation base to legacy contracts", () => {
  assert.deepEqual(
    resolveNMinusOneCapabilities({
      expectedSha: LEGACY_SHA,
      actualSha: LEGACY_SHA,
      currentPolicy: policy
    }),
    {
      channel_contract: "legacy",
      lumen_contract: "legacy",
      channel_v1_compatibility: "enabled",
      sofia_pulso_contract: "legacy_sql"
    }
  );
});

test("uses the base revision's own descriptor after the foundation merge", () => {
  assert.deepEqual(
    resolveNMinusOneCapabilities({
      expectedSha: CURRENT_SHA,
      actualSha: CURRENT_SHA,
      currentPolicy: policy,
      basePolicy: policy
    }),
    {
      channel_contract: "current",
      lumen_contract: "current",
      channel_v1_compatibility: "disabled",
      sofia_pulso_contract: "owner_api"
    }
  );
});

test("keeps SOFIA ownership independent from a current Channel contract", () => {
  const mixedPolicy = {
    ...policy,
    self: { ...policy.self, sofiaPulsoOwnership: "legacy_direct_sql_v1" }
  };
  assert.deepEqual(
    resolveNMinusOneCapabilities({
      expectedSha: CURRENT_SHA,
      actualSha: CURRENT_SHA,
      currentPolicy: policy,
      basePolicy: mixedPolicy
    }),
    {
      channel_contract: "current",
      lumen_contract: "current",
      channel_v1_compatibility: "disabled",
      sofia_pulso_contract: "legacy_sql"
    }
  );
});

test("keeps SOFIA owner API independent from a legacy Channel contract", () => {
  const mixedPolicy = {
    ...policy,
    self: { ...policy.self, channelInbound: "legacy_pre_outbox_v1" }
  };
  assert.deepEqual(
    resolveNMinusOneCapabilities({
      expectedSha: CURRENT_SHA,
      actualSha: CURRENT_SHA,
      currentPolicy: policy,
      basePolicy: mixedPolicy
    }),
    {
      channel_contract: "legacy",
      lumen_contract: "current",
      channel_v1_compatibility: "enabled",
      sofia_pulso_contract: "owner_api"
    }
  );
});

test("fails closed for an unknown descriptor-less base", () => {
  const unknownSha = "a".repeat(40);
  assert.throws(
    () =>
      resolveNMinusOneCapabilities({
        expectedSha: unknownSha,
        actualSha: unknownSha,
        currentPolicy: policy
      }),
    /no compatibility descriptor/
  );
});

test("rejects a present but invalid base descriptor instead of using a legacy override", () => {
  assert.throws(
    () =>
      resolveNMinusOneCapabilities({
        expectedSha: LEGACY_SHA,
        actualSha: LEGACY_SHA,
        currentPolicy: policy,
        basePolicy: null
      }),
    /must be an object/
  );
});

test("rejects malformed policies, fields and capability values", () => {
  assert.throws(() => validatePolicy({ ...policy, unknown: true }), /unknown fields/);
  assert.throws(
    () => validatePolicy({ ...policy, self: { ...policy.self, channelInbound: "guess" } }),
    /channelInbound is unsupported/
  );
  assert.throws(
    () => validatePolicy({ ...policy, self: { ...policy.self, sofiaPulsoOwnership: "guess" } }),
    /sofiaPulsoOwnership is unsupported/
  );
  assert.throws(() => validatePolicy({ ...policy, schemaVersion: 1 }), /schemaVersion/);
});

test("rejects a checkout that differs from the declared base SHA", () => {
  assert.throws(
    () =>
      resolveNMinusOneCapabilities({
        expectedSha: LEGACY_SHA,
        actualSha: CURRENT_SHA,
        currentPolicy: policy
      }),
    /does not match/
  );
});
